/**
 * Language Exam Practice Server
 * Express server with Privy auth, LLM proxy, and user data storage
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { createRemoteJWKSet, jwtVerify } = require('jose');
const db = require('./db');
// DB connection is managed via db.js exports.
// We strictly use:
// DB_MODE='neon' -> fail fast, no fallback
// DB_MODE='auto' -> attempt connect, fallback allowed
const { isDbReady, DB_MODE, IS_NEON_MODE, IS_VERCEL, driverType } = db;
// Note: We no longer use a global IS_DB_AVAILABLE flag.
// Instead we check await db.initDb() at points of use.
const {
  JLPT_READING_TYPES,
  READING_TIME_BUDGET,
  PASSAGE_LENGTH_TARGETS,
  TYPE_TITLES
} = require('./jlpt_config');
const { createClient } = require('@deepgram/sdk');
const DEFAULT_GEMINI_MODEL = process.env.DEFAULT_GEMINI_MODEL || 'gemini-3-pro-preview';

// DB availability is now checked via db.initDb() at usage points
// In Neon mode, server fails fast at boot (see bottom of file)

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy for Vercel/Cloud deployments (enables correct IP detection for rate limiting)
app.set('trust proxy', 1);

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
// JSON Parse Error Handler
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    console.error(`[JSON Error] ${req.path}: ${err.message}`);
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }
  next();
});
app.use(express.static(path.join(__dirname, '../web')));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

// Strict rate limiting for answer verification (prevent brute-force)
const verifyAnswerLimiter = rateLimit({
  windowMs: 1000, // 1 second
  max: 5, // 5 requests per second
  message: { error: 'Too many verification requests, slow down' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.userId || req.ip
});

// Data directory: (Removed for strict DB mode)
// We rely entirely on the database.
const DATA_DIR = IS_VERCEL ? '/tmp/data' : path.join(__dirname, 'data');
// NOTE: We do NOT use fs.mkdir or local files in this refined architecture.

// Privy JWKS for token verification
const PRIVY_APP_ID = process.env.PRIVY_APP_ID;
const IS_DEMO_MODE = !PRIVY_APP_ID || PRIVY_APP_ID === 'demo-app-id' || PRIVY_APP_ID === '';
let privyJWKS = null;

// Logging
// Logging
function log(level, message, data = null) {
  const timestamp = new Date().toISOString();
  // Safe logging: avoid circular refs if data is complex, though JSON.stringify handles basic objs
  try {
    const logLine = `[${timestamp}] [${level}] ${message}${data ? ' ' + JSON.stringify(data) : ''}`;
    console.log(logLine);
  } catch (e) {
    console.log(`[${timestamp}] [${level}] ${message} [Log Error]`);
  }
}

async function getPrivyJWKS() {
  if (!privyJWKS && !IS_DEMO_MODE) {
    privyJWKS = createRemoteJWKSet(
      new URL('https://auth.privy.io/api/v1/apps/' + PRIVY_APP_ID + '/jwks.json')
    );
  }
  return privyJWKS;
}

// Auth middleware
async function authMiddleware(req, res, next) {
  // Full demo mode - no auth required at all
  if (IS_DEMO_MODE) {
    req.user = { userId: 'demo-user', email: 'demo@example.com' };
    return next();
  }

  const authHeader = req.headers.authorization;

  // No auth header - reject
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    log('WARN', 'Missing auth header', { path: req.path });
    return res.status(401).json({ error: 'Missing authorization token' });
  }

  const token = authHeader.substring(7);

  // Allow demo-token as fallback (useful when Privy is configured but user is in demo mode)
  if (token === 'demo-token') {
    log('INFO', 'Demo token accepted', { path: req.path });
    req.user = { userId: 'demo-user', email: 'demo@example.com' };
    return next();
  }

  // Try Privy verification
  try {
    const jwks = await getPrivyJWKS();
    const { payload } = await jwtVerify(token, jwks, {
      issuer: 'privy.io',
      audience: PRIVY_APP_ID
    });

    // Extract user info from Privy token
    const userId = crypto.createHash('sha256').update(payload.sub).digest('hex').substring(0, 16);
    const email = payload.email || payload.sub;

    log('INFO', 'Privy auth success', { userId, email });
    req.user = { userId, email };
    next();
  } catch (err) {
    log('ERROR', 'Auth error', { error: err.message, tokenLength: token.length });
    return res.status(401).json({ error: 'Invalid token' });
  }
}

const DEFAULT_MODES = {
  basic: { question_scale: 0.5, time_scale: 0.5 },
  standard: { question_scale: 1.0, time_scale: 1.0 },
  official: { question_scale: 1.0, time_scale: 1.0 }
};

// ============ Auth Endpoints ============

// Get public config (no auth required)
app.get('/api/config', (req, res) => {
  res.json({
    privyAppId: process.env.PRIVY_APP_ID || 'demo-app-id',
    privyClientId: process.env.PRIVY_CLIENT_ID || process.env.PRIVY_APP_ID || 'demo-app-id'
  });
});

// Get current user info
app.post('/api/me', authMiddleware, (req, res) => {
  res.json({ userId: req.user.userId, email: req.user.email });
});

// ============ DB Helper Functions ============

async function loadUserData(userId, email) {
  // Check DB availability via init
  const dbOk = await db.initDb();

  // In Neon mode, DB must be available
  if (IS_NEON_MODE && !dbOk) {
    throw new Error('DB required in Neon mode but unavailable');
  }

  // In Strict Mode (Neon/Production), we require DB.
  if (!dbOk) {
    throw new Error('Database unavailable. Please check connection.');
  }

  // Standard Demo Mode (when DB is available but user is demo)
  if (IS_DEMO_MODE || userId === 'demo-user') {
    return {
      history: [],
      mistakeBook: [],
      weakTags: [],
      nickname: 'Demo User',
      settings: {}
    };
  }

  try {
    const res = await db.query('SELECT * FROM users WHERE id = $1', [userId]);

    if (res.rows.length === 0) {
      // Create new user if not exists
      const initialData = { history: [], mistakeBook: {}, weakTags: [], settings: {} };
      await db.query(
        'INSERT INTO users (id, email, data) VALUES ($1, $2, $3)',
        [userId, email || '', JSON.stringify(initialData)]
      );
      return { ...initialData, nickname: null }; // Force nickname prompt
    }

    const { data, nickname } = res.rows[0];
    const parsedData = typeof data === 'string' ? JSON.parse(data) : data;
    return { ...parsedData, nickname };
  } catch (err) {
    console.error('DB load error:', err);
    throw err;
  }
}

async function saveUserData(userId, data) {
  // Check DB availability via init
  const dbOk = await db.initDb();

  // In Neon mode, DB must be available
  if (IS_NEON_MODE && !dbOk) {
    throw new Error('DB required in Neon mode but unavailable');
  }

  // Skip save if DB unavailable (ephemeral mode)
  if (!dbOk) {
    console.log(`[WARN] DB unavailable, skipping save for user ${userId}`);
    return;
  }

  if (IS_DEMO_MODE || userId === 'demo-user') return;

  // Filter out heavy objects like ttsCache to prevent DB bloat
  const { nickname, ttsCache, ...jsonData } = data;

  if (nickname) {
    await db.query(
      'UPDATE users SET data = $1, nickname = $2 WHERE id = $3',
      [JSON.stringify(jsonData), nickname, userId]
    );
  } else {
    await db.query(
      'UPDATE users SET data = $1 WHERE id = $2',
      [JSON.stringify(jsonData), userId]
    );
  }
}

// Helper: Manage Sessions (Max 1 session per user - new login forces logout of previous)
async function manageSession(userId, existingSessionId) {
  // 1. Clean up expired sessions
  await db.query('DELETE FROM sessions WHERE expires_at < NOW()');

  // 2. Check if existing session is valid (must be a valid UUID)
  const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(existingSessionId);

  if (existingSessionId && isUUID) {
    const res = await db.query('SELECT id FROM sessions WHERE id = $1 AND user_id = $2', [existingSessionId, userId]);
    if (res.rows.length > 0) {
      // Refresh expiry (extend by 7 days)
      await db.query("UPDATE sessions SET expires_at = NOW() + INTERVAL '7 days' WHERE id = $1", [existingSessionId]);
      return existingSessionId;
    }
  }

  // 3. Delete ALL existing sessions for this user (enforce 1 session limit)
  await db.query('DELETE FROM sessions WHERE user_id = $1', [userId]);

  // 4. Create new session
  const newSessionRes = await db.query(`
    INSERT INTO sessions (user_id, token, expires_at)
    VALUES ($1, 'valid', NOW() + INTERVAL '7 days')
    RETURNING id
  `, [userId]);

  return newSessionRes.rows[0].id;
}

// Get user data (Acts as Login/Session Init)
app.post('/api/user-data', authMiddleware, async (req, res) => {
  try {
    const { sessionId } = req.body; // Frontend sends current session ID if exists

    // Check DB status
    const dbOk = await db.initDb();

    // Manage Session (only if DB available and not demo user)
    let activeSessionId = null;
    if (dbOk && req.user.userId !== 'demo-user') {
      try {
        activeSessionId = await manageSession(req.user.userId, sessionId);
      } catch (e) {
        console.error('Session management failed:', e);
        // Continue without session if DB fails momentarily
      }
    }

    // Load Data
    const data = await loadUserData(req.user.userId, req.user.email);

    // Update last login (only if DB available and not demo)
    if (dbOk && req.user.userId !== 'demo-user') {
      try {
        await db.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [req.user.userId]);
      } catch (e) { console.error('Update last_login failed:', e); }
    }

    res.json({ ...data, sessionId: activeSessionId });
  } catch (err) {
    console.error('Load user data error:', err);
    res.status(500).json({ error: 'Failed to load user data' });
  }
});


// Save user data
app.put('/api/user-data', authMiddleware, async (req, res) => {
  try {
    const currentData = await loadUserData(req.user.userId, req.user.email);
    const newData = { ...currentData, ...req.body };
    await saveUserData(req.user.userId, newData);
    res.json({ success: true });
  } catch (err) {
    console.error('Save user data error:', err);
    res.status(500).json({ error: 'Failed to save user data' });
  }
});

// ============ Notebook/Knowledge Bank Endpoints ============

// Save/Unsave question to notebook
app.post('/api/notebook', authMiddleware, async (req, res) => {
  try {
    const { question, note, tags, action } = req.body;
    const userId = req.user.userId;

    if (IS_DEMO_MODE || userId === 'demo-user') return res.json({ success: true, demo: true });

    // 1. Ensure question exists in questions bank
    const hash = generateQuestionHash(question);

    // Upsert question to bank (ignore if exists)
    await db.query(
      `INSERT INTO questions (hash, content, keywords) 
       VALUES ($1, $2, $3) 
       ON CONFLICT (hash) DO NOTHING`,
      [hash, JSON.stringify(question), JSON.stringify(question.tags || [])]
    );

    if (action === 'remove') {
      await db.query(
        'DELETE FROM user_notebook WHERE user_id = $1 AND question_hash = $2',
        [userId, hash]
      );
    } else {
      // Upsert notebook entry
      await db.query(
        `INSERT INTO user_notebook (user_id, question_hash, note, tags)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, question_hash) 
         DO UPDATE SET note = $3, tags = $4, created_at = NOW()`,
        [userId, hash, note || '', JSON.stringify(tags || [])]
      );
    }

    res.json({ success: true, hash });
  } catch (err) {
    console.error('Notebook save error:', err);
    res.status(500).json({ error: 'Failed to save to notebook' });
  }
});

// Get user notebook
app.get('/api/notebook', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    if (IS_DEMO_MODE || userId === 'demo-user') return res.json({ items: [] });

    const result = await db.query(`
      SELECT n.*, q.content, q.hash
      FROM user_notebook n
      JOIN questions q ON n.question_hash = q.hash
      WHERE n.user_id = $1
      ORDER BY n.created_at DESC
      LIMIT 200
    `, [userId]);

    const items = result.rows.map(row => ({
      ...row,
      question: row.content,
      content: undefined
    }));

    res.json({ items });
  } catch (err) {
    console.error('Notebook fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch notebook' });
  }
});

// Helper: Generate consistent hash for a question
function generateQuestionHash(question) {
  // Normalize content for hashing: Prompt + Choices + Answer + Type
  const content = {
    p: question.prompt,
    c: question.choices,
    a: question.answer_index,
    t: question.type
    // Ignore ID, explanation, etc. for deduplication
  };
  return crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

// Helper: Async save generated questions to bank
async function saveQuestionsFromTest(testData) {
  if (!testData || !testData.groups) return;

  try {
    for (const group of testData.groups) {
      for (const mondai of group.mondai) {
        if (!mondai.items) continue;
        for (const item of mondai.items) {
          const hash = generateQuestionHash(item);
          // Fire and forget insert
          db.query(
            `INSERT INTO questions (hash, content, keywords) 
             VALUES ($1, $2, $3) 
             ON CONFLICT (hash) DO NOTHING`,
            [hash, JSON.stringify(item), JSON.stringify(item.tags || [])]
          ).catch(e => console.error('Question bank insert duplicate/error:', e.message));
        }
      }
    }
  } catch (e) {
    console.error('Error saving questions to bank:', e);
  }
}

// ============ Answer Hash Security Helper ============

/**
 * Generate answer hash for quick grading verification
 * Uses SHA-256 with secret key to prevent reverse engineering
 * @param {string} questionId - Question ID
 * @param {number} answerIndex - Correct answer index (0-3)
 * @returns {string} - SHA-256 hash
 */
function generateAnswerHash(questionId, answerIndex) {
  const SECRET = process.env.ANSWER_HASH_SECRET || 'default-secret-change-me-in-production';

  if (!process.env.ANSWER_HASH_SECRET) {
    log('WARN', 'ANSWER_HASH_SECRET not set, using default (INSECURE for production)');
  }

  const hashInput = `${questionId}:${answerIndex}:${SECRET}`;
  return crypto.createHash('sha256').update(hashInput).digest('hex');
}

/**
 * Sanitize mondai for client: remove answer_index/keys, add answer_hash
 * Ensures NO server-only data leaks to client
 * @param {object} data - Response data with questions
 * @returns {object} - Sanitized data
 */
function sanitizeMondaiForClient(data) {
  if (!data) return data;

  // Deep clone to avoid mutating original
  const sanitized = JSON.parse(JSON.stringify(data));

  // Helper to process items
  const processItems = (items) => {
    if (Array.isArray(items)) {
      items.forEach(item => {
        // 1. Generate hash if simple answer_index exists
        if (item.id && typeof item.answer_index === 'number') {
          item.answer_hash = generateAnswerHash(item.id, item.answer_index);
        }

        // 2. Remove sensitive fields
        delete item.answer_index;
        delete item.correct_answer;
        delete item.answer_key;
        delete item.answer_keys; // Ensure plural is also removed
        delete item.explanation_source; // Internal notes
      });
    }
  };

  // Process mondai array (direct chunk)
  if (sanitized.mondai && Array.isArray(sanitized.mondai)) {
    sanitized.mondai.forEach(m => {
      // Process items in mondai
      processItems(m.items);
    });
  }

  // Process groups structure (legacy/full test)
  if (sanitized.groups && Array.isArray(sanitized.groups)) {
    sanitized.groups.forEach(group => {
      if (group.mondai && Array.isArray(group.mondai)) {
        group.mondai.forEach(m => {
          processItems(m.items);
        });
      }
    });
  }

  // Also handle raw array of mondai (if passed directly)
  if (Array.isArray(sanitized)) {
    sanitized.forEach(m => {
      processItems(m.items);
    });
  }

  return sanitized;
}

// Alias for compatibility if needed, using the new robust sanitizer
const hashifyAnswers = sanitizeMondaiForClient;

// ============ Pool Snapshot Logic ============

/**
 * Generate bucket key: "main|M1|kanji"
 */
function getBucketKey(groupId, mondaiId, primaryType) {
  return `${groupId}|${mondaiId}|${primaryType}`;
}

/**
 * Generate stable hash for mondai content (deduplication)
 */
function generateMondaiHash(mondai) {
  const normalized = {
    mondai_id: mondai.mondai_id,
    type: mondai.mondai_type || (mondai.items && mondai.items[0]?.type) || 'unknown',
    items: (mondai.items || []).map(item => ({
      prompt: item.prompt,
      choices: item.choices,
      answer_index: item.answer_index
      // Exclude volatile fields like IDs if they are random
    })),
    passage: mondai.passage
  };
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

// ============ V2 Pool Architecture ============

const ON_DEMAND_BATCH = 1;
const WARM_TARGET_PER_BUCKET = 50;

/**
 * Ensure pool snapshot exists (Meta only)
 * Does NOT actively fill pool - on-demand generation in buildExamBlueprint handles this
 */
async function ensurePoolSnapshot(examSpec, level, dateYmd, plan, mode) {
  // Wait for DB initialization instead of checking boolean
  const ok = await db.initDb();
  if (!ok) return null;

  // UPSERT Snapshot (race-safe)
  const snapshotRes = await db.query(`
    INSERT INTO pool_snapshots (exam_id, level, mode, date_ymd)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (exam_id, level, mode, date_ymd)
    DO UPDATE SET exam_id = EXCLUDED.exam_id
    RETURNING id
  `, [examSpec.exam_id, level, mode, dateYmd]);

  const snapshotId = snapshotRes.rows[0]?.id;

  // NOTE: No preroll here - on-demand generation in buildExamBlueprint handles missing items
  // This ensures /api/exam/start returns quickly without blocking Gemini calls

  return snapshotId;
}

/**
 * Batch generate mondai to fill a bucket
 */
async function generateMondaiForBucket(params) {
  const { examSpec, level, mode, group, mondaiDef, bucketKey, snapshotId, count, plan } = params;

  let remaining = Math.max(0, Number(count) || 0);
  if (remaining === 0) return;

  while (remaining > 0) {
    const prompt = buildMondaiChunkPrompt(examSpec, mode, group, 0, [mondaiDef], 0, []);

    try {
      const result = await callGemini(prompt, { temperature: 0.8, proOnly: false, plan });
      const mondaiList = Array.isArray(result?.mondai) ? result.mondai : [];

      if (mondaiList.length === 0) {
        remaining -= 1;
        continue;
      }

      for (const m of mondaiList) {
        if (remaining <= 0) break;
        // Normalize and hash
        m.mondai_id = mondaiDef.mondai_id; // Ensure ID matches
        m.primary_type = mondaiDef.types[0];

        const hash = generateMondaiHash(m);

        // Extract item_type and estimated cost
        const itemType = m.mondai_type || mondaiDef.mondai_type || 'unknown';
        const estimatedCost = mondaiDef.estimated_seconds || 60;

        // Save to Bank with all required columns
        await db.query(`
            INSERT INTO mondai_bank (
              hash, exam_id, level, group_id, mondai_id, 
              primary_type, item_type, estimated_cost, content, meta
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)
            ON CONFLICT (hash) DO NOTHING
          `, [
          hash,
          examSpec.exam_id,
          level,
          group.group_id,
          mondaiDef.mondai_id,
          mondaiDef.types[0],
          itemType,
          estimatedCost,
          JSON.stringify(m),
          JSON.stringify({ mode, generated_at: new Date().toISOString() })
        ]);

        // Link to Bucket with ON CONFLICT (more efficient than WHERE NOT EXISTS)
        await db.query(`
            INSERT INTO pool_snapshot_items (snapshot_id, bucket_key, mondai_hash, group_id)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (snapshot_id, bucket_key, mondai_hash) DO NOTHING
          `, [snapshotId, bucketKey, hash, group.group_id]);

        remaining--;
      }
    } catch (e) {
      console.error('Pool generation error:', e?.message || e);
      remaining -= 1;
    }
  }
}

/**
 * Warm pool buckets with bounded limits (safe for serverless)
 * @param {string} snapshotId - Pool snapshot ID
 * @param {object} examSpec - Exam specification
 * @param {string} level - JLPT level
 * @param {string} mode - Exam mode
 * @param {string} dateYmd - Date string YYYY-MM-DD
 * @param {object} opts - Options: targetPerBucket, maxBuckets, maxGenerateTotal
 * @returns {object} Stats: { bucketsProcessed, generated, skipped }
 */
async function warmPool(snapshotId, examSpec, level, mode, dateYmd, opts = {}) {
  const {
    targetPerBucket = WARM_TARGET_PER_BUCKET,
    maxBuckets = 10,
    maxGenerateTotal = 20
  } = opts;

  let bucketsProcessed = 0;
  let generated = 0;
  let skipped = 0;

  // Gather all buckets from examSpec
  const buckets = [];
  for (const group of examSpec.groups) {
    for (const mondaiDef of group.mondai) {
      if (!mondaiDef.types?.[0]) continue;
      const primaryType = mondaiDef.types[0];
      const bucketKey = getBucketKey(group.group_id, mondaiDef.mondai_id, primaryType);
      buckets.push({ group, mondaiDef, bucketKey });
    }
  }

  // Process up to maxBuckets
  for (const bucket of buckets) {
    if (bucketsProcessed >= maxBuckets) break;
    if (generated >= maxGenerateTotal) break;

    const { group, mondaiDef, bucketKey } = bucket;

    // Check current count in bucket
    const countRes = await db.query(
      `SELECT COUNT(*) FROM pool_snapshot_items WHERE snapshot_id=$1 AND bucket_key=$2`,
      [snapshotId, bucketKey]
    );
    const current = parseInt(countRes.rows[0]?.count || 0);

    if (current >= targetPerBucket) {
      skipped++;
      continue;
    }

    // Calculate how many to generate (bounded by remaining quota)
    const needed = Math.min(targetPerBucket - current, maxGenerateTotal - generated);
    if (needed <= 0) {
      skipped++;
      continue;
    }

    console.log(`[Warmup] Filling ${bucketKey}: ${current} -> ${current + needed} (target: ${targetPerBucket})`);

    // Generate in small batches
    const batchSize = Math.min(needed, 5);
    let batchGenerated = 0;

    for (let i = 0; i < needed && generated < maxGenerateTotal; i += batchSize) {
      const count = Math.min(batchSize, needed - i, maxGenerateTotal - generated);

      try {
        await generateMondaiForBucket({
          examSpec, level, mode, group, mondaiDef, bucketKey, snapshotId,
          count,
          plan: 'warmup'
        });
        batchGenerated += count;
        generated += count;
      } catch (e) {
        console.error(`[Warmup] Error generating for ${bucketKey}:`, e?.message || e);
        break;
      }
    }

    bucketsProcessed++;
  }

  return { bucketsProcessed, generated, skipped };
}

/**
 * Build determinisic exam from pool
 */
async function buildExamBlueprint(examSpec, level, mode, seed, setNo, plan, snapshotId) {
  if (!snapshotId) throw new Error('Snapshot required');

  // Seedable RNG
  const rngSeed = `${seed}-${setNo}`;
  // Simple seed random (hashing)
  let seedValue = 0;
  for (let i = 0; i < rngSeed.length; i++) seedValue = (seedValue << 5) - seedValue + rngSeed.charCodeAt(i);
  const rng = () => {
    const x = Math.sin(seedValue++) * 10000;
    return x - Math.floor(x);
  };

  const blueprint = {
    groups: [],
    meta: {
      exam_id: examSpec.exam_id, level, mode, plan, seed, set_no: setNo,
      generated_at: new Date().toISOString()
    }
  };



  const modeConfig = examSpec.modes?.[mode] || DEFAULT_MODES[mode] || DEFAULT_MODES.official || { question_scale: 1.0, time_scale: 1.0 };
  const qScale = modeConfig.question_scale || 1.0;

  // Track used hashes to avoid duplicates across exam
  const usedHashes = new Set();

  for (const group of examSpec.groups) {
    const groupBlueprint = {
      group_id: group.group_id, title_vi: group.title_vi, mondai_slots: []
    };

    for (const mondaiDef of group.mondai) {
      const isReading = mondaiDef.types.some(t => t.startsWith('reading_'));
      const targetCount = Math.max(1, Math.round(mondaiDef.count_official * qScale));

      const bucketKey = getBucketKey(group.group_id, mondaiDef.mondai_id, mondaiDef.types[0]);

      // Sample from bucket
      // We need ONE mondai instance that fits requirements?
      // Reading: 1 mondai = 1 passage + questions.
      // Vocab: 1 mondai instance (micro chunk) usually has 1-5 questions.
      // If targetCount > mondaiInstance.questions, we might need multiple instances?
      // "Option 1" implies assembling based on Mondai Units.
      // For Reading: 1 mondai slot = 1 passage.
      // For Vocab: 1 mondai slot = 1 set of questions (micro chunk).

      try {
        let hash;
        try {
          hash = await sampleMondaiFromBucket(snapshotId, bucketKey, rng, Array.from(usedHashes));
        } catch (e) {
          // On-demand generation if bucket empty/exhausted
          // Log only important event
          console.log(`[Blueprint] Bucket empty/exhausted: ${bucketKey}. Triggering on-demand generation.`);

          await generateMondaiForBucket({
            examSpec, level, mode, group, mondaiDef, bucketKey, snapshotId,
            count: ON_DEMAND_BATCH,
            plan
          });

          // Retry sampling (if this fails, we skip this slot)
          hash = await sampleMondaiFromBucket(snapshotId, bucketKey, rng, Array.from(usedHashes));
        }

        usedHashes.add(hash);

        // Determine item type for reading
        let itemType = mondaiDef.types[0];

        groupBlueprint.mondai_slots.push({
          mondai_id: mondaiDef.mondai_id,
          type: itemType,
          mondai_hash: hash,
          question_count: targetCount,
          delivery_mode: isReading ? 'whole' : 'flexible'
        });
      } catch (e) {
        // Soft fail for individual slots if generation fails
        console.warn(`Failed to fill slot for ${bucketKey} after retry:`, e.message);
      }
    }
    blueprint.groups.push(groupBlueprint);
  }

  // READING SECTION TIME BUDGET OPTIMIZATION
  // Re-process reading slots if this is a full exam or has reading section
  // Note: Only apply if we have multiple reading mondai to select from.
  const readingGroup = blueprint.groups.find(g => g.group_id === 'main' || g.group_id === 'reading');
  if (readingGroup && READING_TIME_BUDGET[mode] && READING_TIME_BUDGET[mode][level]) {
    const budgetSec = READING_TIME_BUDGET[mode][level];

    // Filter out only reading slots
    const readingSlots = readingGroup.mondai_slots.filter(s => s.delivery_mode === 'whole');
    const otherSlots = readingGroup.mondai_slots.filter(s => s.delivery_mode !== 'whole');

    // Assign estimated cost to reading slots
    // Base cost: 30s per question + reading time (approx 1char/sec for reading?)
    // Simplified: Use db.estimated_cost if available, or heuristic
    // For now heuristic: 60s per unit base + 30s per question

    const candidates = await Promise.all(readingSlots.map(async slot => {
      // Fetch cost from DB
      const res = await db.query('SELECT estimated_cost, item_type FROM mondai_bank WHERE hash=$1', [slot.mondai_hash]);
      const cost = res.rows[0]?.estimated_cost || (60 + slot.question_count * 45); // fallback
      return { ...slot, cost, item_type: res.rows[0]?.item_type || slot.type };
    }));

    // Select units within budget
    let currentCost = 0;
    const selectedReading = [];
    const usedTypes = new Set();

    // 1. Ensure type diversity (Greedy)
    // Permitted types needed? 
    const requiredTypes = JLPT_READING_TYPES[level] || [];

    // Shuffle candidates for randomness
    candidates.sort(() => Math.random() - 0.5);

    // Try to pick one of each available type first
    for (const type of requiredTypes) {
      const match = candidates.find(c => c.item_type === type && !selectedReading.includes(c));
      if (match) {
        if (currentCost + match.cost <= budgetSec) {
          selectedReading.push(match);
          currentCost += match.cost;
          usedTypes.add(type);
        }
      }
    }

    // 2. Fill remaining budget with any reading type
    const remainingCandidates = candidates.filter(c => !selectedReading.includes(c));
    for (const cand of remainingCandidates) {
      if (currentCost + cand.cost <= budgetSec) {
        selectedReading.push(cand);
        currentCost += cand.cost;
      }
    }

    // Sort selected by mondai_id to maintain exam order structure
    selectedReading.sort((a, b) => {
      // Natural sort M1, M2...
      return a.mondai_id.localeCompare(b.mondai_id, undefined, { numeric: true });
    });

    // Replace slots
    readingGroup.mondai_slots = [...otherSlots, ...selectedReading];
  }

  // groupBlueprint push already handled inside loop
  // Note: Previous loop pushed groupBlueprint already. This logic needs to be INSIDE the loop or modify after.
  // Correction: The loop lines 715-752 handles pushing. 
  // I should inject this logic BEFORE pushing groupBlueprint or modify blueprint.groups after.
  // The snippet I'm replacing ends at 745... then closes loops.
  // The provided snippet in view_file ends at 752. 
  // I will replace the pushing logic.

  return blueprint;
}

async function sampleMondaiFromBucket(snapshotId, bucketKey, rng, usedHashes) {
  const used = Array.isArray(usedHashes) ? new Set(usedHashes) : new Set();

  const res = await db.query(`
    SELECT mondai_hash
    FROM pool_snapshot_items
    WHERE snapshot_id=$1 AND bucket_key=$2
  `, [snapshotId, bucketKey]);

  const available = (res.rows || []).filter((r) => r?.mondai_hash && !used.has(r.mondai_hash));
  if (available.length === 0) throw new Error('Bucket empty or exhausted');

  const x = rng();
  const clamped = Math.max(0, Math.min(0.999999, Number.isFinite(x) ? x : 0));
  return available[Math.floor(clamped * available.length)].mondai_hash;
}

// ============ LLM Endpoints ============

async function callOpenAI(messages, options = {}) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: options.model || 'gpt-4o',
      messages,
      temperature: options.temperature || 0.7,
      max_tokens: options.maxTokens || 8000,
      response_format: { type: 'json_object' }
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI error: ${err}`);
  }

  const data = await response.json();
  return JSON.parse(data.choices[0].message.content);
}

// Gemini model fallback order (full list)
const GEMINI_MODELS = [
  'gemini-3-pro-preview',
  'gemini-3-flash-preview',
  'gemini-2.5-pro',
  'gemini-2.5-flash'
];

// Pro-only models for high-quality generation (Flash only on quota/rate limit)
const GEMINI_MODELS_PRO = [
  'gemini-3-pro-preview',
  'gemini-2.5-pro'
];

// Gemini TTS models (for TTS fallback)
const GEMINI_TTS_MODELS = [
  'gemini-2.5-pro-tts',
  'gemini-2.5-flash-tts'
];

async function callGeminiWithModel(prompt, model, options = {}) {
  const apiKey = options.apiKey || process.env.GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  log('INFO', `Calling Gemini model: ${model}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: typeof options.temperature === 'number' ? options.temperature : 0.4,
        maxOutputTokens: options.maxTokens || 16384,
        responseMimeType: 'application/json',
        topP: typeof options.topP === 'number' ? options.topP : 0.95
      }
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    const error = new Error(`Gemini error (${model}): ${errText}`);
    error.status = response.status;
    error.model = model;
    throw error;
  }

  // Helper to clean JSON string (remove markdown, find first { and last })
  function cleanJson(text) {
    if (!text) return text;
    // Remove markdown code blocks
    let cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '');

    // Find first '{'
    const start = cleaned.indexOf('{');
    if (start === -1) return cleaned;

    // Robust extraction: count braces to find the matching closing brace
    let braceCount = 0;
    let inString = false;
    let escape = false;

    for (let i = start; i < cleaned.length; i++) {
      const char = cleaned[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (char === '\\') {
        escape = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (!inString) {
        if (char === '{') braceCount++;
        else if (char === '}') braceCount--;

        if (braceCount === 0) {
          // Found the matching end
          return cleaned.substring(start, i + 1);
        }
      }
    }

    // Fallback: return from start to end if no balanced closure found
    return cleaned.substring(start);
  }

  const data = await response.json();

  if (!data.candidates || !data.candidates[0]?.content?.parts?.[0]?.text) {
    throw new Error(`Gemini returned empty response from ${model}`);
  }

  let text = data.candidates[0].content.parts[0].text;
  log('INFO', `Gemini ${model} success`, { responseLength: text.length });

  // Try to parse JSON, with repair for truncated responses
  try {
    const cleanedText = cleanJson(text);
    return JSON.parse(cleanedText);
  } catch (parseErr) {
    log('WARN', `JSON parse failed, attempting repair...`, { error: parseErr.message });

    // Attempt to repair truncated JSON
    const repaired = repairTruncatedJSON(cleanJson(text));
    if (repaired) {
      log('INFO', 'JSON repair successful');
      return repaired;
    }

    throw parseErr;
  }
}

function validateQuestionItem(item) {
  const errors = [];
  if (!item || typeof item !== 'object') return ['item_not_object'];
  if (!item.id || typeof item.id !== 'string') errors.push('missing_id');
  if (!item.type || typeof item.type !== 'string') errors.push('missing_type');
  if (!item.prompt || typeof item.prompt !== 'string') errors.push('missing_prompt');
  if (!Array.isArray(item.choices) || item.choices.length !== 4) errors.push('choices_not_4');
  if (Array.isArray(item.choices)) {
    for (let i = 0; i < item.choices.length; i++) {
      if (typeof item.choices[i] !== 'string' || item.choices[i].trim() === '') {
        errors.push(`choice_${i}_invalid`);
      }
      if (item.choices[i] === 'A' || item.choices[i] === 'B' || item.choices[i] === 'C' || item.choices[i] === 'D') {
        errors.push('choices_are_letters');
        break;
      }
    }
  }
  if (typeof item.answer_index !== 'number' || item.answer_index < 0 || item.answer_index > 3) errors.push('answer_index_invalid');
  if (!item.explain_brief || typeof item.explain_brief !== 'string') errors.push('missing_explain_brief');
  if (!Array.isArray(item.tags) || item.tags.length === 0) errors.push('missing_tags');
  if (item.media && typeof item.media !== 'object') errors.push('media_invalid');
  return errors;
}

function validateGroupResult(group) {
  const errors = [];
  const ids = new Set();
  if (!group || typeof group !== 'object') return ['group_not_object'];
  if (!group.group_id || typeof group.group_id !== 'string') errors.push('missing_group_id');
  if (!group.title_vi || typeof group.title_vi !== 'string') errors.push('missing_title_vi');
  if (!Array.isArray(group.mondai) || group.mondai.length === 0) errors.push('missing_mondai');
  if (!Array.isArray(group.mondai)) return errors;

  // Listening types for validation
  const listeningTypes = ['listening_dialogue', 'listening_mono', 'listen_respond', 'listen_integration', 'listen_task'];

  for (let mi = 0; mi < group.mondai.length; mi++) {
    const m = group.mondai[mi];
    if (!m || typeof m !== 'object') {
      errors.push(`mondai_${mi}_not_object`);
      continue;
    }
    if (!m.mondai_id || typeof m.mondai_id !== 'string') errors.push(`mondai_${mi}_missing_mondai_id`);
    if (!m.title_vi || typeof m.title_vi !== 'string') errors.push(`mondai_${mi}_missing_title_vi`);
    if (!m.instructions_vi || typeof m.instructions_vi !== 'string') errors.push(`mondai_${mi}_missing_instructions_vi`);
    if (!Array.isArray(m.items) || m.items.length === 0) errors.push(`mondai_${mi}_missing_items`);

    if (!Array.isArray(m.items)) continue;

    // Check if this is a listening mondai
    const isListeningMondai = m.items.some(item => item && listeningTypes.includes(item.type));

    for (let ii = 0; ii < m.items.length; ii++) {
      const item = m.items[ii];
      const itemErrors = validateQuestionItem(item);
      if (itemErrors.length) errors.push(`mondai_${mi}_item_${ii}:${itemErrors.join(',')}`);
      if (item && typeof item.id === 'string') {
        if (ids.has(item.id)) errors.push(`duplicate_id:${item.id}`);
        ids.add(item.id);
      }

      // Listening Mode B: item-level script_text is NOT allowed for listening mondai
      if (isListeningMondai && item && item.media?.script_text) {
        errors.push(`mondai_${mi}_item_${ii}:script_text_should_be_at_mondai_level`);
      }

      // Legacy: non-listening items with media.script_text (keep existing validation)
      if (!isListeningMondai) {
        const needsScript = item && item.media && Object.prototype.hasOwnProperty.call(item.media, 'script_text');
        if (needsScript && item.media.script_text !== null && typeof item.media.script_text !== 'string') {
          errors.push(`mondai_${mi}_item_${ii}:script_text_invalid`);
        }
      }
    }

    // Listening Mode B: mondai-level script_text is REQUIRED for listening mondai
    if (isListeningMondai) {
      if (!m.media?.script_text || typeof m.media.script_text !== 'string' || m.media.script_text.trim() === '') {
        errors.push(`mondai_${mi}_missing_mondai_script_text`);
      }
    }
  }
  return errors;
}

function buildFixGroupPrompt(examSpec, mode, group, groupIndex, errors) {
  return `You are fixing a JSON output for a ${examSpec.display_name_vi} practice test group.

EXAM: ${examSpec.display_name_vi}
LEVEL: ${examSpec.level}
LANGUAGE: ${examSpec.language}
MODE: ${mode}
GROUP INDEX: ${groupIndex + 1}

The JSON has validation errors. Fix ONLY what is necessary to satisfy the schema and errors below.
Do NOT change the overall intent/difficulty, do NOT remove questions unless absolutely required to satisfy schema.

VALIDATION ERRORS:
${errors.slice(0, 40).join('\n')}

RULES:
1. Return RAW JSON only.
2. Ensure choices are full answer texts (NOT letters "A/B/C/D").
3. Each item must have 4 non-empty string choices and exactly 1 correct answer_index (0-3).
4. Keep existing ids where possible; if you must change, keep uniqueness.

INPUT JSON:
${JSON.stringify(group)}

RETURN FIXED JSON ONLY.`;
}

// Attempt to repair truncated JSON by closing open brackets
function repairTruncatedJSON(text) {
  try {
    // First try as-is
    return JSON.parse(text);
  } catch (e) {
    // Count open brackets
    let openBraces = 0;
    let openBrackets = 0;
    let inString = false;
    let escape = false;

    for (let i = 0; i < text.length; i++) {
      const char = text[i];

      if (escape) {
        escape = false;
        continue;
      }

      if (char === '\\') {
        escape = true;
        continue;
      }

      if (char === '"' && !escape) {
        inString = !inString;
        continue;
      }

      if (!inString) {
        if (char === '{') openBraces++;
        else if (char === '}') openBraces--;
        else if (char === '[') openBrackets++;
        else if (char === ']') openBrackets--;
      }
    }

    // If we're in a string, close it
    let repaired = text;
    if (inString) {
      repaired += '"';
    }

    // Close open brackets and braces
    repaired += ']'.repeat(Math.max(0, openBrackets));
    repaired += '}'.repeat(Math.max(0, openBraces));

    try {
      return JSON.parse(repaired);
    } catch (e2) {
      log('WARN', 'JSON repair failed', { error: e2.message });
      return null;
    }
  }
}

class ModelRouter {
  constructor() {
    this.keys = {
      'gemini-3-pro-preview': this.getKeys('GEMINI_KEYS_3_PRO'),
      'gemini-2.5-pro': this.getKeys('GEMINI_KEYS_25_PRO'),
      'gemini-3-flash-preview': this.getKeys('GEMINI_KEYS_FLASH'),
      'gemini-2.5-flash': this.getKeys('GEMINI_KEYS_FLASH'),
      'openai': this.getKeys('OPENAI_KEYS')
    };

    // Fallback/Legacy single key support
    const defaultKey = process.env.GEMINI_API_KEY;
    if (defaultKey) {
      if (this.keys['gemini-3-pro-preview'].length === 0) this.keys['gemini-3-pro-preview'].push(defaultKey);
      if (this.keys['gemini-2.5-pro'].length === 0) this.keys['gemini-2.5-pro'].push(defaultKey);
      if (this.keys['gemini-3-flash-preview'].length === 0) this.keys['gemini-3-flash-preview'].push(defaultKey);
      if (this.keys['gemini-2.5-flash'].length === 0) this.keys['gemini-2.5-flash'].push(defaultKey);
    }

    this.keyIndex = {}; // { model: index }
  }

  getKeys(envVar) {
    return (process.env[envVar] || '').split(',').map(k => k.trim()).filter(Boolean);
  }

  getNextKey(model) {
    const keys = this.keys[model] || [];
    if (keys.length === 0) return null;
    const idx = (this.keyIndex[model] || 0) % keys.length;
    return keys[idx];
  }

  rotateKey(model) {
    const keys = this.keys[model] || [];
    if (keys.length <= 1) return;
    this.keyIndex[model] = (this.keyIndex[model] || 0) + 1;
    log('INFO', `Rotating key for ${model}, now using index ${this.keyIndex[model] % keys.length}`);
  }

  /**
   * Determine model ladder based on request options
   */
  getLadder(options) {
    // If specific model requested, start with it
    const requested = options.model ? [options.model] : [];

    // Base ladder
    let base = [];
    if (options.proOnly) {
      // Quality tier
      base = ['gemini-3-pro-preview', 'gemini-2.5-pro'];
    } else {
      // Speed/Standard tier
      base = ['gemini-2.5-pro', 'gemini-2.5-flash'];
    }

    // Flash fallback (always available as last resort unless explicitly excluded)
    // Existing logic had complex proOnly rules. 
    // New rule: "gemini-2.5-flash (only if ALL Gemini keys exhausted)"
    // So we append flash at end of ladder.
    const fallback = ['gemini-2.5-flash', 'gemini-3-flash-preview'];

    // Merge unique
    const ladder = [...requested, ...base, ...fallback].filter((v, i, a) => a.indexOf(v) === i);
    return ladder;
  }

  async callWithFallback(prompt, options) {
    const ladder = this.getLadder(options);
    let lastError = null;

    for (const model of ladder) {
      // Try keys for this model
      const keys = this.keys[model] || [null]; // If no keys managed, might rely on global env in legacy?
      // Actually constructor guarantees keys array (might be empty).
      // If empty, and no default, we skip?
      // Wait, getNextKey handles it.

      // We try the CURRENT key. If it fails with quota, we rotate and retry SAME model?
      // OR we rotate and move to next model?
      // Requirement: "rotate/retry on quota errors".
      // Let's try up to key count times.

      const maxRetries = keys.length || 1;

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        const apiKey = this.getNextKey(model);
        if (!apiKey && model !== 'openai') {
          // Skip if no key (shouldn't happen with fallback logic)
          break;
        }

        try {
          if (model === 'openai') {
            return await callOpenAI([{ role: 'user', content: prompt }], { apiKey, ...options });
          } else {
            return await callGeminiWithModel(prompt, model, { ...options, apiKey });
          }
        } catch (err) {
          lastError = err;

          const isQuota = err.status === 429 || err.status === 403 || (err.message && err.message.includes('429'));

          if (isQuota) {
            log('WARN', `Quota exceeded for ${model} (key ${attempt}), rotating...`);
            this.rotateKey(model);
            // Retry loop continues to next key
          } else {
            // Non-quota error (e.g. 400 Bad Request, 500), might be model issue.
            // Move to next model in ladder.
            log('WARN', `Error with ${model}: ${err.message}. Trying next model.`);
            break; // Break key loop, go to next model
          }
        }
      }
    }

    throw lastError || new Error('All models/keys exhausted');
  }
}

const modelRouter = new ModelRouter();

async function callGemini(prompt, options = {}) {
  return modelRouter.callWithFallback(prompt, options);
}

async function generateGroupWithIntegrity(examSpec, mode, group, groupIndex, options = {}) {
  const model = options.model || DEFAULT_GEMINI_MODEL;
  const maxTokens = options.maxTokens || 16384;
  const temperature = typeof options.temperature === 'number' ? options.temperature : 0.4;

  const prompt = buildGenerateGroupPrompt(examSpec, mode, group, groupIndex);
  // Use Pro-only models for high-quality generation (no Flash fallback)
  const first = await callGemini(prompt, { model, maxTokens, temperature, proOnly: true });
  const errors1 = validateGroupResult(first);
  if (errors1.length === 0) return first;

  const fixPrompt = buildFixGroupPrompt(examSpec, mode, first, groupIndex, errors1);
  const fixed = await callGemini(fixPrompt, { model, maxTokens: Math.min(8192, maxTokens), temperature: 0, proOnly: true });
  const errors2 = validateGroupResult(fixed);
  if (errors2.length === 0) return fixed;

  const hardFail = new Error(`Group validation failed after fix: ${errors2.slice(0, 10).join(' | ')}`);
  hardFail.validationErrors = errors2;
  throw hardFail;
}

// Generate test
app.post('/api/generate-test', authMiddleware, async (req, res) => {
  try {
    const { examSpec, mode, provider, userHistory, model } = req.body;
    const llmProvider = provider || process.env.DEFAULT_LLM_PROVIDER || 'gemini';

    const prompt = buildGenerateTestPrompt(examSpec, mode, userHistory);

    let result;
    if (llmProvider === 'openai') {
      result = await callOpenAI([{ role: 'user', content: prompt }]);
    } else {
      result = await callGemini(prompt, { model: model || DEFAULT_GEMINI_MODEL, maxTokens: 16384, temperature: 0.4 });
    }

    // Async save generated questions to Knowledge Bank
    saveQuestionsFromTest(result).catch(e => console.error('Bank save error:', e));

    res.json(result);
  } catch (err) {
    console.error('Generate test error:', err);
    log('ERROR', 'Generate test failed', { error: err.message, stack: err.stack?.substring(0, 500) });
    res.status(500).json({ error: 'Lỗi máy chủ. Vui lòng thử lại sau.' });
  }
});

// Generate a single group (for progressive loading)
app.post('/api/generate-group', authMiddleware, async (req, res) => {
  try {
    const { examSpec, mode, groupIndex, provider, existingMeta, model } = req.body;
    const llmProvider = provider || process.env.DEFAULT_LLM_PROVIDER || 'gemini';

    const group = examSpec.groups[groupIndex];
    if (!group) {
      return res.status(400).json({ error: 'Invalid group index' });
    }

    let result;
    if (llmProvider === 'openai') {
      const prompt = buildGenerateGroupPrompt(examSpec, mode, group, groupIndex);
      result = await callOpenAI([{ role: 'user', content: prompt }]);
    } else {
      result = await generateGroupWithIntegrity(examSpec, mode, group, groupIndex, {
        model: model || DEFAULT_GEMINI_MODEL,
        maxTokens: 16384,
        temperature: 0.4
      });
    }

    // Async save generated questions (group) to Knowledge Bank
    saveQuestionsFromTest({ groups: [result] }).catch(e => console.error('Bank save error group:', e));

    // If this is the first group (groupIndex === 0), include metadata
    if (groupIndex === 0) {
      const modeConfig = examSpec.modes[mode];
      const timeScale = modeConfig.time_scale;

      result.meta = {
        exam_id: examSpec.exam_id,
        level: examSpec.level,
        language: examSpec.language,
        mode: mode,
        seed: Math.random().toString(36).substring(7),
        generated_at: new Date().toISOString(),
        providers: { llm: llmProvider, tts_mode: 'auto' },
        time_limits: {
          overall_sec: Math.round(examSpec.official_time_limits_sec.overall_time_sec * timeScale),
          groups: examSpec.official_time_limits_sec.groups.map(g => ({
            group_id: g.group_id,
            time_sec: Math.round(g.time_sec * timeScale)
          }))
        }
      };
    }

    res.json(result);
  } catch (err) {
    console.error('Generate group error:', err);
    log('ERROR', 'Generate group failed', { error: err.message, stack: err.stack?.substring(0, 500) });
    res.status(500).json({ error: 'Lỗi máy chủ. Vui lòng thử lại sau.' });
  }
});

// Generate a chunk of mondai (2-3 at a time for faster progressive loading)
app.post('/api/generate-mondai-chunk', authMiddleware, async (req, res) => {
  try {
    const {
      examSpec, mode, groupIndex, chunkIndex, chunkSize = 3,
      previousMondai = [], provider, model
    } = req.body;
    const llmProvider = provider || process.env.DEFAULT_LLM_PROVIDER || 'gemini';

    const group = examSpec.groups[groupIndex];
    if (!group) {
      return res.status(400).json({ error: 'Invalid group index' });
    }

    // Calculate which mondai to generate in this chunk
    const startMondaiIndex = chunkIndex * chunkSize;
    const endMondaiIndex = Math.min(startMondaiIndex + chunkSize, group.mondai.length);
    const mondaiToGenerate = group.mondai.slice(startMondaiIndex, endMondaiIndex);

    if (mondaiToGenerate.length === 0) {
      return res.json({ mondai: [], isLast: true });
    }

    const isLast = endMondaiIndex >= group.mondai.length;
    const isFirst = chunkIndex === 0;

    let result;
    if (llmProvider === 'openai') {
      const prompt = buildMondaiChunkPrompt(examSpec, mode, group, groupIndex, mondaiToGenerate, startMondaiIndex, previousMondai);
      result = await callOpenAI([{ role: 'user', content: prompt }]);
    } else {
      const prompt = buildMondaiChunkPrompt(examSpec, mode, group, groupIndex, mondaiToGenerate, startMondaiIndex, previousMondai);
      result = await callGemini(prompt, {
        model: model || DEFAULT_GEMINI_MODEL,
        maxTokens: 8192, // Smaller chunks need less tokens
        temperature: 0.4,
        proOnly: true
      });
    }

    // Validate mondai items
    const validatedMondai = [];
    if (result.mondai && Array.isArray(result.mondai)) {
      for (const m of result.mondai) {
        const errors = [];
        if (!m.mondai_id) errors.push('missing_mondai_id');
        if (!m.title_vi) errors.push('missing_title_vi');
        if (!Array.isArray(m.items) || m.items.length === 0) errors.push('missing_items');

        if (errors.length === 0) {
          validatedMondai.push(m);
        } else {
          log('WARN', `Mondai validation issues: ${errors.join(', ')}`);
        }
      }
    }

    // Response with chunk info
    const response = {
      mondai: validatedMondai,
      chunkIndex,
      isFirst,
      isLast,
      totalMondai: group.mondai.length,
      generatedCount: validatedMondai.length
    };

    // Include group metadata and meta on first chunk
    if (isFirst) {
      response.group_id = group.group_id;
      response.title_vi = group.title_vi;

      if (groupIndex === 0) {
        const modeConfig = examSpec.modes[mode];
        const timeScale = modeConfig.time_scale;
        response.meta = {
          exam_id: examSpec.exam_id,
          level: examSpec.level,
          language: examSpec.language,
          mode: mode,
          seed: Math.random().toString(36).substring(7),
          generated_at: new Date().toISOString(),
          providers: { llm: llmProvider, tts_mode: 'auto' },
          time_limits: {
            overall_sec: Math.round(examSpec.official_time_limits_sec.overall_time_sec * timeScale),
            groups: examSpec.official_time_limits_sec.groups.map(g => ({
              group_id: g.group_id,
              time_sec: Math.round(g.time_sec * timeScale)
            }))
          }
        };
      }
    }

    // Async save generated questions to Knowledge Bank
    saveQuestionsFromTest({ groups: [{ mondai: validatedMondai }] }).catch(e => console.error('Bank save error chunk:', e));

    // SECURITY: Replace answer_index with answer_hash
    const hashedResponse = hashifyAnswers(response);

    log('INFO', `Generated mondai chunk ${chunkIndex + 1}`, {
      groupIndex: groupIndex + 1,
      mondaiCount: validatedMondai.length,
      security: 'answer_hash'
    });

    res.json(hashedResponse);
  } catch (err) {
    console.error('Generate mondai chunk error:', err);
    log('ERROR', 'Generate mondai chunk failed', { error: err.message, stack: err.stack?.substring(0, 500) });
    res.status(500).json({ error: 'Lỗi máy chủ. Vui lòng thử lại sau.' });
  }
});


// Answer Verification Endpoint (for client-side quick grading)
app.post('/api/verify-answer', authMiddleware, verifyAnswerLimiter, (req, res) => {
  try {
    const { questionId, answerIndex } = req.body;

    // Validate input
    if (!questionId || typeof answerIndex !== 'number') {
      return res.status(400).json({ error: 'Invalid request: questionId and answerIndex required' });
    }

    if (answerIndex < 0 || answerIndex > 3) {
      return res.status(400).json({ error: 'Invalid answer index: must be 0-3' });
    }

    // Generate hash for the provided answer
    const hash = generateAnswerHash(questionId, answerIndex);

    res.json({ hash });

  } catch (err) {
    console.error('Verify answer error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});


app.post('/api/grade-test', authMiddleware, async (req, res) => {
  try {
    const { test, answers, provider } = req.body;
    const llmProvider = provider || process.env.DEFAULT_LLM_PROVIDER || 'gemini';

    // Note: Quick grading is now handled client-side using answer_hash verification
    // This endpoint is only for AI detailed grading

    const prompt = buildGradeTestPrompt(test, answers);

    let result;
    if (llmProvider === 'openai') {
      result = await callOpenAI([{ role: 'user', content: prompt }]);
    } else {
      result = await callGemini(prompt);
    }

    // Save to Exam Results Table (Robust storage)
    try {
      await db.query(
        'INSERT INTO exam_results (user_id, exam_id, score, summary, data) VALUES ($1, $2, $3, $4, $5)',
        [req.user.userId, test.meta.exam_id, result.score_summary.total_score, JSON.stringify(result), JSON.stringify({ test, answers })]
      );
    } catch (dbErr) {
      console.error('Failed to save exam result to DB:', dbErr);
    }

    // Update User History (Legacy/Frontend compatibility)
    try {
      const userData = await loadUserData(req.user.userId, req.user.email);
      userData.history = userData.history || [];
      userData.history.unshift({
        id: crypto.randomUUID(),
        exam_id: test.meta.exam_id,
        date: new Date().toISOString(),
        score: result.score_summary.total_score,
        max_score: result.score_summary.max_score,
        summary: result.score_summary
      });
      // Limit history to 20
      if (userData.history.length > 20) userData.history.pop();

      await saveUserData(req.user.userId, userData);
    } catch (histErr) {
      console.error('Failed to update user history:', histErr);
    }

    res.json(result);
  } catch (err) {
    console.error('Grade test error:', err);
    res.status(500).json({ error: 'Failed to grade test: ' + err.message });
  }
});

// Prepare TTS text
app.post('/api/prepare-tts-text', authMiddleware, async (req, res) => {
  try {
    const { text, language, provider } = req.body;
    const llmProvider = provider || process.env.DEFAULT_LLM_PROVIDER || 'gemini';

    const prompt = buildTtsTextPrompt(text, language);

    let result;
    if (llmProvider === 'openai') {
      result = await callOpenAI([{ role: 'user', content: prompt }]);
    } else {
      result = await callGemini(prompt);
    }

    res.json(result);
  } catch (err) {
    console.error('TTS text prep error:', err);
    res.status(500).json({ error: 'Failed to prepare TTS text: ' + err.message }).catch(console.error);
  }
});

// Helper: Parse JSONB safely (Neon may return as string)
function parseJsonb(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

// ============ User Management ============

// ============ TTS Endpoints ============

// In-memory TTS cache with LRU eviction (max 50 entries, ~50MB assuming 1MB per audio)
const TTS_CACHE = new Map();
const TTS_CACHE_MAX = 50;

function generateTextHash(text, language, voice) {
  return crypto.createHash('md5').update(`${text}|${language}|${voice || 'default'}`).digest('hex');
}

function getTTSFromCache(hash) {
  if (TTS_CACHE.has(hash)) {
    const entry = TTS_CACHE.get(hash);
    // Move to end (most recently used)
    TTS_CACHE.delete(hash);
    TTS_CACHE.set(hash, entry);
    log('INFO', `TTS cache hit: ${hash.substring(0, 8)}...`);
    return entry;
  }
  return null;
}

function setTTSCache(hash, audioBuffer) {
  // Evict oldest if at capacity
  if (TTS_CACHE.size >= TTS_CACHE_MAX) {
    const oldestKey = TTS_CACHE.keys().next().value;
    TTS_CACHE.delete(oldestKey);
    log('INFO', `TTS cache evicted: ${oldestKey.substring(0, 8)}...`);
  }
  TTS_CACHE.set(hash, audioBuffer);
  log('INFO', `TTS cached: ${hash.substring(0, 8)}... (${TTS_CACHE.size}/${TTS_CACHE_MAX})`);
}

// Detect if text contains dialogue format (Speaker: text)
function isDialogue(text) {
  const dialoguePattern = /^([A-Za-z0-9\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff_]+)\s*[:：]\s*.+$/gm;
  const matches = text.match(dialoguePattern);
  // Consider dialogue if at least 2 speaker lines found
  return matches && matches.length >= 2;
}

// Available Deepgram Aura-2 voices: alternating male/female for dialogue
const TTS_VOICES = {
  male: ['aura-2-fujin-ja', 'aura-2-ebisu-ja', 'aura-2-thalia-en'],
  female: ['aura-2-izanami-ja', 'aura-2-uzume-ja', 'aura-2-ama-ja', 'aura-2-apollo-en'],
};

// Parse dialogue text into segments with speaker labels
function parseDialogue(text) {
  const dialoguePattern = /^([A-Za-z0-9\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff_]+)\s*[:：]\s*(.+)$/gm;
  const segments = [];
  const speakerMap = new Map();
  let speakerIndex = 0;
  let lastIndex = 0;
  let match;

  dialoguePattern.lastIndex = 0;

  while ((match = dialoguePattern.exec(text)) !== null) {
    const beforeText = text.slice(lastIndex, match.index).trim();
    if (beforeText) {
      segments.push({ speaker: '__narrator__', text: beforeText });
    }

    const speaker = match[1].toLowerCase();
    const dialogueText = match[2].trim();

    if (!speakerMap.has(speaker)) {
      speakerMap.set(speaker, speakerIndex++);
    }

    segments.push({
      speaker,
      speakerIndex: speakerMap.get(speaker),
      text: dialogueText,
    });

    lastIndex = match.index + match[0].length;
  }

  const remainingText = text.slice(lastIndex).trim();
  if (remainingText) {
    segments.push({ speaker: '__narrator__', text: remainingText });
  }

  if (segments.length === 0) {
    return [{ speaker: '__narrator__', text: text.trim() }];
  }

  return segments;
}

// Get voice for speaker (smart assignment based on speaker index)
function getVoiceForSpeaker(segment, language) {
  if (segment.speaker === '__narrator__') {
    return language === 'ja-JP' ? 'aura-2-fujin-ja' : 'aura-asteria-en';
  }

  const isMale = segment.speakerIndex % 2 === 0;
  const voicePool = isMale ? TTS_VOICES.male : TTS_VOICES.female;
  const voiceIndex = Math.floor(segment.speakerIndex / 2) % voicePool.length;
  return voicePool[voiceIndex];
}

// Generate audio for a single text segment using Deepgram
async function generateDeepgramAudio(text, voice) {
  const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

  const response = await deepgram.speak.request(
    { text },
    { model: voice, encoding: 'mp3' }
  );

  const stream = await response.getStream();
  if (!stream) throw new Error('Failed to get audio stream from Deepgram');

  const reader = stream.getReader();
  const chunks = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  return Buffer.concat(chunks);
}

// STREAMING TTS endpoint - sends audio chunks as SSE
app.post('/api/tts/stream', authMiddleware, async (req, res) => {
  try {
    const { text, language } = req.body;

    if (!text || text.trim() === '') {
      return res.status(400).json({ error: 'Text is required' });
    }

    // Setup SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const segments = parseDialogue(text);
    log('INFO', `TTS Streaming ${segments.length} segment(s)`);

    // Send segment count first
    res.write(`data: ${JSON.stringify({ type: 'info', total: segments.length })}\n\n`);

    // Generate and stream each segment
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const voice = getVoiceForSpeaker(segment, language || 'ja-JP');
      log('INFO', `TTS [${i + 1}/${segments.length}] "${segment.text.slice(0, 30)}..." with ${voice}`);

      try {
        let audio;
        try {
          // Primary: Deepgram
          audio = await generateDeepgramAudio(segment.text, voice);
        } catch (deepgramErr) {
          // Fallback: Gemini TTS
          log('WARN', `Deepgram failed for segment ${i}, falling back to Gemini: ${deepgramErr.message}`);
          audio = await generateGeminiTTS(segment.text, language || 'ja-JP');
        }

        const base64Audio = audio.toString('base64');

        // Send audio chunk as SSE event
        res.write(`data: ${JSON.stringify({
          type: 'audio',
          index: i,
          speaker: segment.speaker,
          audio: base64Audio
        })}\n\n`);
      } catch (segmentErr) {
        log('WARN', `TTS segment ${i} failed (both providers): ${segmentErr.message}`);
        res.write(`data: ${JSON.stringify({ type: 'segment_error', index: i, message: segmentErr.message })}\n\n`);
      }
    }

    // Signal completion
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();

  } catch (error) {
    log('ERROR', 'TTS Stream Error:', { error: error.message });
    res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
    res.end();
  }
});

// Non-streaming TTS endpoint with smart dialogue detection + caching
app.post('/api/tts', authMiddleware, async (req, res) => {
  try {
    const { text, language, provider, speed, voice } = req.body;
    const ttsProvider = provider || 'deepgram';

    if (!text || text.trim() === '') {
      return res.status(400).json({ error: 'Text is required' });
    }

    const textIsDialogue = isDialogue(text);
    const lang = language || 'ja-JP';

    // For non-dialogue: check cache first
    if (!textIsDialogue) {
      const defaultVoice = lang === 'ja-JP' ? 'aura-2-fujin-ja' : 'aura-2-thalia-en';
      const cacheKey = generateTextHash(text, lang, voice || defaultVoice);
      const cachedAudio = getTTSFromCache(cacheKey);

      if (cachedAudio) {
        res.set({
          'Content-Type': 'audio/mpeg',
          'Content-Length': cachedAudio.length,
          'X-TTS-Cached': 'true',
          'X-TTS-Dialogue': 'false',
        });
        return res.send(cachedAudio);
      }
    }

    let audioBuffer;

    try {
      if (ttsProvider === 'deepgram') {
        if (textIsDialogue) {
          // Dialogue mode: parse and generate with different voices
          log('INFO', 'TTS: Dialogue mode detected');
          const segments = parseDialogue(text);
          const audioBuffers = [];

          for (const segment of segments) {
            const segmentVoice = voice || getVoiceForSpeaker(segment, lang);
            const audio = await generateDeepgramAudio(segment.text, segmentVoice);
            audioBuffers.push(audio);
          }

          audioBuffer = Buffer.concat(audioBuffers);
        } else {
          // Non-dialogue: single voice, single segment
          log('INFO', 'TTS: Single segment mode (non-dialogue)');
          const defaultVoice = voice || (lang === 'ja-JP' ? 'aura-2-fujin-ja' : 'aura-2-thalia-en');
          audioBuffer = await generateDeepgramAudio(text, defaultVoice);

          // Cache the result
          const cacheKey = generateTextHash(text, lang, defaultVoice);
          setTTSCache(cacheKey, audioBuffer);
        }
      } else if (ttsProvider === 'gemini') {
        audioBuffer = await generateGeminiTTS(text, language, speed, voice);
      } else {
        return res.status(400).json({ error: 'Use browser TTS on client side' });
      }
    } catch (primaryErr) {
      log('WARN', `Primary TTS (${ttsProvider}) failed, trying fallback:`, { error: primaryErr.message });
      // Fallback logic
      if (ttsProvider === 'deepgram') {
        audioBuffer = await generateGeminiTTS(text, language, speed, voice);
      } else {
        const defaultVoice = voice || (lang === 'ja-JP' ? 'aura-2-fujin-ja' : 'aura-2-thalia-en');
        audioBuffer = await generateDeepgramAudio(text, defaultVoice);
      }
    }

    res.set({
      'Content-Type': 'audio/mpeg',
      'Content-Length': audioBuffer.length,
      'X-TTS-Dialogue': textIsDialogue ? 'true' : 'false',
    });
    res.send(audioBuffer);
  } catch (err) {
    log('ERROR', 'TTS error:', { error: err.message });
    res.status(500).json({ error: 'TTS generation failed: ' + err.message });
  }
});

// Gemini TTS with model fallback
async function generateGeminiTTS(text, language, speed = 1.0, voice) {
  const languageCode = language === 'ja-JP' ? 'ja-JP' : language === 'zh-CN' ? 'cmn-CN' : 'en-US';
  const voiceName = voice || (language === 'ja-JP' ? 'ja-JP-Neural2-B' : 'cmn-CN-Wavenet-A');

  // Try Gemini TTS models in order
  for (const model of GEMINI_TTS_MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: `Read aloud in ${languageCode}: ${text}` }] }],
          generationConfig: {
            response_modalities: ['AUDIO'],
            speech_config: {
              voice_config: { prebuilt_voice_config: { voice_name: voiceName } }
            }
          }
        })
      });

      if (!response.ok) {
        log('WARN', `Gemini TTS ${model} failed, trying next...`);
        continue;
      }

      const data = await response.json();
      if (data.candidates?.[0]?.content?.parts?.[0]?.inline_data?.data) {
        return Buffer.from(data.candidates[0].content.parts[0].inline_data.data, 'base64');
      }

      // Fallback to Google Cloud TTS API if Gemini TTS response format differs
      throw new Error('Unexpected Gemini TTS response format');
    } catch (err) {
      log('WARN', `Gemini TTS ${model} error: ${err.message}`);
      continue;
    }
  }

  // Final fallback: Google Cloud TTS API
  const url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${process.env.GEMINI_API_KEY}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode, name: voiceName },
      audioConfig: { audioEncoding: 'MP3', speakingRate: speed }
    })
  });

  if (!response.ok) {
    throw new Error('All Gemini TTS options failed');
  }

  const data = await response.json();
  return Buffer.from(data.audioContent, 'base64');
}

// ============ Prompt Builders ============

function buildGenerateTestPrompt(examSpec, mode, userHistory) {
  const modeConfig = examSpec.modes[mode];
  const questionScale = modeConfig.question_scale;
  const timeScale = modeConfig.time_scale;

  const groupsInfo = examSpec.groups.map(g => {
    const mondaiInfo = g.mondai.map(m => {
      const count = Math.max(1, Math.round(m.count_official * questionScale));
      return `  - ${m.mondai_id} (${m.title_vi}): ${count} questions, types: ${m.types.join(', ')}`;
    }).join('\n');
    return `Group: ${g.group_id} (${g.title_vi})\n${mondaiInfo}`;
  }).join('\n\n');

  return `You are an expert ${examSpec.display_name_vi} exam creator. Generate a complete practice test.

EXAM: ${examSpec.display_name_vi}
LEVEL: ${examSpec.level}
LANGUAGE: ${examSpec.language}
MODE: ${mode} (time_scale: ${timeScale}, question_scale: ${questionScale})

STRUCTURE:
${groupsInfo}

RULES:
1. Generate 100% original questions. DO NOT copy or paraphrase real exam questions.
2. Each question must have exactly 4 choices with exactly 1 correct answer.
3. Questions must match the difficulty and style of ${examSpec.display_name_vi}.
4. For reading/listening questions, include appropriate passages/scripts.
5. For ${mode} mode, scale passage lengths proportionally (shorter for basic/standard).
6. Include meaningful tags and brief explanations for each question.
7. For listening items, include script_text for audio generation.
8. Ensure difficulty distribution within each mondai: easy 20%, medium 60%, hard 20%.
9. Distractors must be plausible (same part-of-speech/category), but clearly wrong for a single, verifiable reason.
10. Never create ambiguous items with multiple correct answers.
11. "choices" must be full answer texts, NOT letters "A/B/C/D".

PERSONALIZATION INSTRUCTIONS:
${userHistory?.weakTags?.length > 0 ? `The user is weak in: ${userHistory.weakTags.join(', ')}. Please include more questions covering these topics.` : 'Generate a balanced mix of questions.'}
${userHistory?.recentResults ? 'Avoid repeating exact questions from recent tests, but re-test similar concepts.' : ''}

OUTPUT JSON ONLY matching this schema:
{
  "meta": {
    "exam_id": "${examSpec.exam_id}",
    "level": "${examSpec.level}",
    "language": "${examSpec.language}",
    "mode": "${mode}",
    "seed": "<random_string>",
    "generated_at": "<ISO8601>",
    "providers": { "llm": "<provider>", "tts_mode": "auto", "tts_text_llm": "<provider>" },
    "time_limits": {
      "overall_sec": ${Math.round(examSpec.official_time_limits_sec.overall_time_sec * timeScale)},
      "groups": [${examSpec.official_time_limits_sec.groups.map(g =>
    `{ "group_id": "${g.group_id}", "time_sec": ${Math.round(g.time_sec * timeScale)} }`
  ).join(', ')}]
    }
  },
  "groups": [
    {
      "group_id": "<string>",
      "title_vi": "<string>",
      "mondai": [
        {
          "mondai_id": "<string>",
          "title_vi": "<string>",
          "instructions_vi": "<Vietnamese instructions>",
          "passage": { "title": "<optional>", "text": "<for reading>" },
          "items": [
            {
              "id": "<unique_id>",
              "type": "<question_type>",
              "prompt": "<question in ${examSpec.language}>",
              "choices": ["<choiceA text>", "<choiceB text>", "<choiceC text>", "<choiceD text>"],
              "answer_index": 0,
              "explain_brief": "<brief explanation>",
              "tags": ["<tag1>", "<tag2>"],
              "media": {
                "script_text": "<for listening>",
                "tts_text": null,
                "tts_text_provider": null
              }
            }
          ]
        }
      ]
    }
  ]
}

Generate the complete test now. JSON ONLY, no other text.`;
}

// Build prompt for generating a single group
function buildGenerateGroupPrompt(examSpec, mode, group, groupIndex) {
  const modeConfig = examSpec.modes[mode];
  const questionScale = modeConfig.question_scale;

  // Full exam structure for context
  const fullExamStructure = examSpec.groups.map((g, idx) => {
    const groupMondai = g.mondai.map(m => {
      const count = Math.max(1, Math.round(m.count_official * questionScale));
      return `    - ${m.mondai_id}: ${count} questions (${m.types.join(', ')})`;
    }).join('\n');
    const marker = idx === groupIndex ? ' ← GENERATE THIS ONE' : '';
    return `  ${idx + 1}. ${g.group_id} (${g.title_vi})${marker}\n${groupMondai}`;
  }).join('\n');

  // Reading type IDs for special handling
  const readingTypes = ['reading_short', 'reading_mid', 'reading_long', 'reading_compare', 'reading_info'];

  // Current group details with special handling for reading
  const mondaiInfo = group.mondai.map(m => {
    const totalQuestions = Math.max(1, Math.round(m.count_official * questionScale));
    const isReading = m.types.some(t => readingTypes.includes(t));

    if (isReading && totalQuestions > 2) {
      // For reading: fewer passages, more questions each
      // E.g., instead of 5 passages x 1 question, create 2 passages x 2-3 questions
      const passageCount = Math.min(2, Math.ceil(totalQuestions / 3));
      const questionsPerPassage = Math.ceil(totalQuestions / passageCount);
      return `  - ${m.mondai_id} (${m.title_vi}): ${passageCount} passage(s), ${questionsPerPassage} questions each (total ${totalQuestions}), types: ${m.types.join(', ')}
    *** IMPORTANT: Create FEWER passages with MORE questions per passage to reduce reading time ***`;
    }

    return `  - ${m.mondai_id} (${m.title_vi}): ${totalQuestions} questions, types: ${m.types.join(', ')}`;
  }).join('\n');

  return `You are an expert ${examSpec.display_name_vi} exam creator. You are generating a complete ${examSpec.display_name_vi} practice test GROUP BY GROUP.

EXAM: ${examSpec.display_name_vi}
LEVEL: ${examSpec.level}
LANGUAGE: ${examSpec.language}
MODE: ${mode} (question_scale: ${questionScale})

FULL EXAM STRUCTURE (for context - you are generating Group ${groupIndex + 1}):
${fullExamStructure}

NOW GENERATE GROUP ${groupIndex + 1} OF ${examSpec.groups.length}:
Group: ${group.group_id} (${group.title_vi})
${mondaiInfo}

IMPORTANT CONTEXT:
- This is part ${groupIndex + 1} of ${examSpec.groups.length} in a complete ${examSpec.display_name_vi} practice test
- Maintain consistent difficulty throughout the exam
- Questions should feel like they belong to the same cohesive test
- Use appropriate vocabulary and grammar for ${examSpec.level} level

*** READING COMPREHENSION OPTIMIZATION ***
For reading types (reading_short, reading_mid, reading_long, reading_compare, reading_info):
- Create FEWER passages but with MORE questions per passage
- Example: Instead of 5 passages with 1 question each, create 2 passages with 2-3 questions each
- This reduces total reading time while maintaining question count
- Each passage should be rich enough to support multiple questions

RULES:
1. Generate 100% original questions. DO NOT copy real exam questions.
2. Each question must have exactly 4 choices with exactly 1 correct answer.
3. Questions must match the difficulty and style of ${examSpec.display_name_vi}.
4. For reading/listening questions, include appropriate passages/scripts.
5. Include meaningful tags and brief explanations for each question.
6. For listening items, include script_text for audio generation.
7. "choices" must be full answer texts, NOT letters "A/B/C/D".

OUTPUT JSON ONLY matching the following schema.
IMPORTANT:
- Return RAW JSON only. Do not wrap in markdown code blocks.
- Ensure strict JSON validity (escape quotes properly).
- Ensure all required fields are present.

Schema:
{
  "group_id": "${group.group_id}",
  "title_vi": "${group.title_vi}",
  "mondai": [
    {
      "mondai_id": "<string>",
      "title_vi": "<Vietnamese Title> (<Japanese Title>)",
      "instructions_vi": "<Vietnamese instructions>",
      "passage": { "title": "<optional>", "text": "<for reading>" },
      "items": [
        {
          "id": "<unique_id>",
          "type": "<question_type>",
          "prompt": "<question in ${examSpec.language}>",
          "choices": ["<choiceA text>", "<choiceB text>", "<choiceC text>", "<choiceD text>"],
          "answer_index": 0,
          "explain_brief": "<brief explanation>",
          "tags": ["<tag1>", "<tag2>"],
          "media": {
            "script_text": "<for listening, null otherwise>"
          }
        }
      ]
    }
  ]
}

GENERATE JSON NOW:`;
}

// Build prompt for generating a chunk of mondai (2-3 at a time)
function buildMondaiChunkPrompt(examSpec, mode, group, groupIndex, mondaiToGenerate, startMondaiIndex, previousMondai = []) {
  const modeConfig = examSpec.modes[mode];
  const questionScale = modeConfig.question_scale;

  // Reading type IDs for special handling
  const readingTypes = ['reading_short', 'reading_mid', 'reading_long', 'reading_compare', 'reading_info'];
  // Listening type IDs
  const listeningTypes = ['listening_dialogue', 'listening_mono', 'listen_respond', 'listen_integration', 'listen_task'];

  // Current chunk mondai details
  const mondaiInfo = mondaiToGenerate.map((m, idx) => {
    const totalQuestions = Math.max(1, Math.round(m.count_official * questionScale));
    const isReading = m.types.some(t => readingTypes.includes(t));
    const isListening = m.types.some(t => listeningTypes.includes(t));
    const mondaiNum = startMondaiIndex + idx + 1;

    if (isReading) {
      // Use configured passage targets
      const targets = PASSAGE_LENGTH_TARGETS[mode] || PASSAGE_LENGTH_TARGETS['official'];
      const type = m.types.find(t => targets[t]) || 'reading_mid';
      const targetLength = targets[type] || 'medium length';

      return `  ${mondaiNum}. ${m.mondai_id} (${m.title_vi}): ONE passage (${targetLength}) with ${totalQuestions} questions, types: ${m.types.join(', ')}
    *** Create exactly ONE passage with ALL ${totalQuestions} questions included ***
    *** Passage may include subheadings if appropriate ***`;
    }

    if (isListening) {
      return `  ${mondaiNum}. ${m.mondai_id} (${m.title_vi}): ${totalQuestions} questions, types: ${m.types.join(', ')}
    ★★★ LISTENING AUDIO RULES ★★★
    - Put script_text at MONDAI level: mondai.media.script_text (NOT in items)
    - Use dialogue format: "A: こんにちは\nB: はい、こんにちは" (preferred for multi-voice TTS)
    - If monologue, still place at mondai.media.script_text
    - items[].media MUST be null or omitted`;
    }

    return `  ${mondaiNum}. ${m.mondai_id} (${m.title_vi}): ${totalQuestions} questions, types: ${m.types.join(', ')}`;
  }).join('\n');

  // Build detailed anti-duplication context from previously generated mondai
  let contextInfo = '';
  let usedVocabulary = [];
  let usedThemes = [];
  let usedGrammar = [];

  if (previousMondai.length > 0) {
    // Extract vocabulary, themes, and grammar from previous items
    previousMondai.forEach(m => {
      if (m.items) {
        m.items.forEach(item => {
          // Collect tags as themes/grammar points
          if (item.tags) {
            item.tags.forEach(tag => {
              if (tag.includes('文法') || tag.includes('grammar')) {
                if (!usedGrammar.includes(tag)) usedGrammar.push(tag);
              } else {
                if (!usedThemes.includes(tag)) usedThemes.push(tag);
              }
            });
          }
          // Extract key vocabulary from prompts (first few words)
          if (item.prompt) {
            const words = item.prompt.split(/[\s、。！？]+/).slice(0, 3).join(', ');
            if (words && !usedVocabulary.includes(words)) {
              usedVocabulary.push(words);
            }
          }
        });
      }
    });

    const contextSummary = previousMondai.map(m => {
      const questionCount = m.items?.length || 0;
      const sampleTopics = m.items?.slice(0, 2).map(i => i.tags?.[0] || i.type).join(', ') || 'various';
      return `  - ${m.mondai_id}: ${questionCount} questions about ${sampleTopics}`;
    }).join('\n');

    contextInfo = `
PREVIOUSLY GENERATED MONDAI (maintain consistency, STRICTLY avoid repetition):
${contextSummary}

★★★ ALREADY USED - DO NOT REPEAT ★★★
${usedThemes.length > 0 ? `Themes/Topics: ${usedThemes.slice(0, 10).join(', ')}` : ''}
${usedGrammar.length > 0 ? `Grammar Points: ${usedGrammar.slice(0, 8).join(', ')}` : ''}
${usedVocabulary.length > 0 ? `Sample Vocabulary: ${usedVocabulary.slice(0, 6).join(' | ')}` : ''}
`;
  }

  // Determine if this is a single-section exam (grammar/vocab only, listening only, or reading only)
  const isSingleSection = examSpec.groups.length === 1;
  const sectionType = group.group_id;

  // JLPT Can-do definitions by level
  const jlptCanDo = {
    'N5': {
      desc: 'Understand very basic sentences. Familiar, concrete daily topics. Explicit information only.',
      grammar: 'polite forms, basic conjunctions, no abstraction',
      types: 'kanji reading, vocabulary usage, particle selection, short sentence ordering, literal reading comprehension'
    },
    'N4': {
      desc: 'Understand simple explanations and descriptions. Slightly longer daily-life contexts. Still concrete, minimal abstraction.',
      grammar: 'polite forms, basic conjunctions, simple て-form, no abstraction',
      types: 'kanji reading, vocabulary usage, particle selection, short sentence ordering, literal reading comprehension'
    },
    'N3': {
      desc: 'Understand main points of everyday and semi-formal texts. Simple opinions, reasons, and intentions. Limited inference allowed.',
      grammar: 'plain forms, reasons (から/ので), soft opinions, basic conditional',
      types: 'meaning inference, paraphrase matching, intent identification (simple)'
    },
    'N2': {
      desc: 'Understand logical structure and arguments. Workplace, news-like, and explanatory texts. Abstract but practical concepts.',
      grammar: 'passive/causative, contrast (一方/に対して), logical connectors, formal expressions',
      types: 'logical flow, opinion vs fact, contextual paraphrasing'
    },
    'N1': {
      desc: 'Understand abstract, academic, critical, and implicit content. Opinions, nuance, stance, and author intent. High-density information.',
      grammar: 'modality, stance markers, ellipsis, rhetorical devices, literary expressions',
      types: 'abstract inference, author attitude, rhetorical purpose, implicit meaning'
    }
  };

  const levelInfo = jlptCanDo[examSpec.level] || jlptCanDo['N3'];

  return `You are an AI Expert that generates JLPT exam content.
All output MUST conform to official standards defined by The Japan Foundation.

================================
CORE PRINCIPLE: LEVEL DISCIPLINE
================================
TARGET LEVEL: ${examSpec.level}
You MUST generate content strictly within ${examSpec.level}.
You are allowed to go LOWER than ${examSpec.level}.
You are FORBIDDEN from exceeding ${examSpec.level}.
If uncertainty exists, DOWNGRADE difficulty.

EXAM: ${examSpec.display_name_vi}
LANGUAGE: ${examSpec.language}
MODE: ${mode} (question_scale: ${questionScale})
GROUP: ${group.group_id} (${group.title_vi})
CHUNK: Mondai ${startMondaiIndex + 1} to ${startMondaiIndex + mondaiToGenerate.length} of ${group.mondai.length}
${contextInfo}
GENERATE THESE MONDAI:
${mondaiInfo}

-------------------------
CAN-DO BOUNDARIES (${examSpec.level})
-------------------------
${levelInfo.desc}

ALLOWED GRAMMAR: ${levelInfo.grammar}
ALLOWED QUESTION TYPES: ${levelInfo.types}

If a question requires abilities from a higher tier → INVALID.
Using grammar ≥ one level above ${examSpec.level} → FORBIDDEN.

-------------------------
LANGUAGE SCOPE CONTROL
-------------------------
Vocabulary, kanji, and grammar MUST satisfy ALL conditions:
- Belongs to ${examSpec.level} OR lower
- Frequently appears in official JLPT prep materials
- Natural Japanese usage (no textbook artifacts)

Prohibited:
- Trick phrasing
- Artificial ambiguity
- Cross-level grammar mixing without necessity

-------------------------
ANSWER OPTION INTEGRITY
-------------------------
- Exactly ONE correct answer (answer_index: 0-3)
- No duplicate or near-duplicate options
- Distractors must:
  - Be plausible for ${examSpec.level}
  - Fail for a clear linguistic reason
- Never rely on cultural trivia or external knowledge

-------------------------
DIFFICULTY SAFETY CHECK
-------------------------
Before finalizing, verify:
- Does this question require knowledge above ${examSpec.level}? → REWRITE
- Would a learner at ${examSpec.level} reasonably succeed? → If no, DOWNGRADE
- When in doubt → Treat as TOO HARD → Rewrite at lower level

-------------------------
COHERENCE & ANTI-DUPLICATION
-------------------------
${previousMondai.length > 0 ? `★★★ ALREADY USED - DO NOT REPEAT ★★★
${usedThemes.length > 0 ? `Themes: ${usedThemes.slice(0, 10).join(', ')}` : ''}
${usedGrammar.length > 0 ? `Grammar: ${usedGrammar.slice(0, 8).join(', ')}` : ''}
${usedVocabulary.length > 0 ? `Vocab: ${usedVocabulary.slice(0, 6).join(' | ')}` : ''}
REPEAT = FAILURE.` : 'First chunk - establish diverse foundation.'}

-------------------------
OUTPUT RULE
-------------------------
Return RAW JSON ONLY. 
- DO NOT use markdown code blocks (no \`\`\`json).
- DO NOT start with "Here is the JSON...".
- DO NOT end with explanations.
- The output must start clearly with '{' and end with '}'.

{
  "mondai": [
    {
      "mondai_id": "<string>",
      "title_vi": "<string>",
      "instructions_vi": "<Vietnamese instructions>",
      "passage": { "title": "<optional>", "text": "<for reading>" },
      "media": { "script_text": "<for listening mondai ONLY - dialogue format A: ... B: ... preferred>" },
      "items": [
        {
          "id": "<unique_id>",
          "type": "<question_type>",
          "prompt": "<question in ${examSpec.language}>",
          "choices": ["<A text>", "<B text>", "<C text>", "<D text>"],
          "answer_index": 0,
          "explain_brief": "<brief explanation>",
          "tags": ["<tag1>", "<tag2>"]
        }
      ]
    }
  ]
}

GENERATE JSON NOW (NO MARKDOWN):`;
}

function buildGradeTestPrompt(test, answers) {
  const questionsWithAnswers = [];
  test.groups.forEach(g => {
    g.mondai.forEach(m => {
      m.items.forEach(item => {
        const userAnswer = answers[item.id];
        questionsWithAnswers.push({
          id: item.id,
          type: item.type,
          prompt: item.prompt,
          choices: item.choices,
          correct_index: item.answer_index,
          user_answer_index: userAnswer !== undefined ? userAnswer : null,
          explain_brief: item.explain_brief,
          tags: item.tags
        });
      });
    });
  });

  return `You are an expert exam grader. Grade the following test and provide detailed feedback in VIETNAMESE.

TEST: ${test.meta.exam_id} ${test.meta.level}
MODE: ${test.meta.mode}

QUESTIONS AND ANSWERS:
${JSON.stringify(questionsWithAnswers, null, 2)}

For each incorrect answer, provide:
1. why_wrong_vi: Explain why the user's choice was wrong (Vietnamese)
2. key_point_vi: The key grammar/vocab point being tested (Vietnamese)
3. mini_lesson_vi: A mini lesson to help the user understand (Vietnamese)
4. extra_examples_target: 2-3 example sentences in the target language
5. review_tasks_vi: Suggested review tasks (Vietnamese)

OUTPUT JSON ONLY matching correct schema.
IMPORTANT:
- Return RAW JSON only. Do not use markdown code blocks.
  - Ensure strict JSON validity.
- Ensure 'score_summary' field exists as used by system.

    Schema:
  {
    "score_summary": {
      "total_score": <correct_count>,
        "max_score": <total_questions>,
          "score_by_group": {"<group_id>": <score>, ... },
            "weak_tags": ["<tags where user made mistakes>"],
              "recommendation_vi": "<personalized study recommendation in Vietnamese>"
  },
                "by_question": [
                {
                  "id": "<question_id>",
                    "is_correct": true/false,
                    "why_wrong_vi": "<only if incorrect>",
                      "key_point_vi": "<key learning point>",
                        "mini_lesson_vi": "<mini lesson>",
                          "extra_examples_target": ["<example1>", "<example2>"],
                            "review_tasks_vi": ["<task1>", "<task2>"]
    }
                              ]
}

                              GENERATE JSON NOW:`;
}

function buildTtsTextPrompt(text, language) {
  const langName = language === 'ja-JP' ? 'Japanese' : language === 'zh-CN' ? 'Chinese' : 'English';

  return `Convert the following ${langName} text into TTS-optimized text for natural speech synthesis.

                              ORIGINAL TEXT:
                              ${text}

                              RULES:
                              1. Preserve the exact meaning - do not add or remove content
                              2. Add appropriate punctuation for natural pacing
3. Normalize numbers (e.g., "3時" -> "さんじ" for Japanese)
                              4. Add brief pauses with commas where natural
                              5. Keep the same language - do not translate

                              OUTPUT JSON ONLY:
                              {
                                "tts_text": "<optimized text for TTS>"
}

                                  JSON ONLY, no other text.`;
}

// ============ V2 Endpoints (Pool Architectre) ============

// ============ Admin Warmup Endpoint ============

/**
 * GET /api/admin/warmup - Pre-fill pool buckets (for cron/admin use)
 * Authentication: x-warmup-secret header OR ?secret= query param
 * Params: exam_id, level, mode, date_ymd, target, max_buckets, max_gen
 */
app.get('/api/admin/warmup', async (req, res) => {
  const startTime = Date.now();

  // Authenticate via secret
  const secret = req.headers['x-warmup-secret'] || req.query.secret;
  const expectedSecret = process.env.WARMUP_SECRET;

  if (!expectedSecret || secret !== expectedSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Wait for DB
    if (!(await db.initDb())) {
      return res.status(503).json({ error: 'DB unavailable' });
    }

    // Parse params with defaults
    const examId = req.query.exam_id || 'jlpt_base_N2';
    const level = req.query.level || 'N2';
    const mode = req.query.mode || 'standard';
    const dateYmd = req.query.date_ymd || new Date().toISOString().split('T')[0];
    const targetPerBucket = parseInt(req.query.target) || 50;
    const maxBuckets = parseInt(req.query.max_buckets) || 10;
    const maxGenerateTotal = parseInt(req.query.max_gen) || 20;

    // Load exam spec (simplified - uses default N2 structure)
    // In production, this should load from a config or DB
    const examSpec = {
      exam_id: examId,
      level: level,
      language: 'ja-JP',
      display_name_vi: `JLPT ${level}`,
      modes: DEFAULT_MODES,
      groups: [
        {
          group_id: 'vocab',
          title_vi: 'Từ vựng - Ngữ pháp',
          mondai: [
            { mondai_id: 'M1', title_vi: 'Đọc Hán tự', count_official: 5, types: ['kanji_reading'] },
            { mondai_id: 'M2', title_vi: 'Viết Hán tự', count_official: 5, types: ['kanji_writing'] },
            { mondai_id: 'M3', title_vi: 'Ghép từ', count_official: 5, types: ['word_formation'] },
            { mondai_id: 'M4', title_vi: 'Nghĩa từ vựng', count_official: 7, types: ['context_vocab'] },
            { mondai_id: 'M5', title_vi: 'Cách dùng', count_official: 5, types: ['usage'] },
            { mondai_id: 'M6', title_vi: 'Chọn ngữ pháp', count_official: 5, types: ['grammar_select'] },
            { mondai_id: 'M7', title_vi: 'Sắp xếp câu', count_official: 5, types: ['sentence_order'] },
            { mondai_id: 'M8', title_vi: 'Điền ngữ pháp', count_official: 5, types: ['grammar_cloze'] }
          ]
        }
      ]
    };

    console.log(`[Warmup] Starting for ${examId} ${level} ${mode} on ${dateYmd}`);

    // Ensure snapshot exists
    const snapshotId = await ensurePoolSnapshot(examSpec, level, dateYmd, 'warmup', mode);
    if (!snapshotId) {
      return res.status(500).json({ error: 'Failed to create snapshot' });
    }

    // Run warmPool with bounded limits
    const stats = await warmPool(snapshotId, examSpec, level, mode, dateYmd, {
      targetPerBucket,
      maxBuckets,
      maxGenerateTotal
    });

    const durationMs = Date.now() - startTime;

    console.log(`[Warmup] Complete: ${stats.bucketsProcessed} buckets, ${stats.generated} generated in ${durationMs}ms`);

    res.json({
      snapshotId,
      date_ymd: dateYmd,
      bucketsProcessed: stats.bucketsProcessed,
      generated: stats.generated,
      skipped: stats.skipped,
      durationMs
    });

  } catch (err) {
    console.error('[Warmup] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Helper: Deliver next chunk for an instance
 */
async function deliverNextChunk(instanceKey, want) {
  // Load instance + blueprint
  const inst = await db.query(
    'SELECT blueprint, delivery_state FROM exam_instances_cache WHERE instance_key=$1',
    [instanceKey]
  );

  if (inst.rows.length === 0) throw new Error('Instance not found');

  const blueprint = parseJsonb(inst.rows[0].blueprint);
  const deliveryState = parseJsonb(inst.rows[0].delivery_state, {});

  // Find requested group
  const groupIdx = blueprint.groups.findIndex(g => g.group_id === want.group_id);
  if (groupIdx === -1) throw new Error('Group not found in blueprint');

  const group = blueprint.groups[groupIdx];
  let cursor = deliveryState.cursors?.[want.group_id] || 0;

  const mondaiToDeliver = [];
  let blueprintModified = false;

  // Deliver items until we satisfy want_count or run out
  // Logic: 
  // - Reading (whole): Take 1 mondai, done.
  // - Others (flexible): Take up to want_count mondai slots.

  while (cursor < group.mondai_slots.length && mondaiToDeliver.length < want.want_count) {
    const slot = group.mondai_slots[cursor];

    // Load mondai content
    let content = null;
    const mRes = await db.query(
      'SELECT content FROM mondai_bank WHERE hash=$1',
      [slot.mondai_hash]
    );

    if (mRes.rows.length > 0) {
      content = parseJsonb(mRes.rows[0].content);
    } else {
      // SAFETY NET: Content missing from bank (data inconsistency)
      // Attempt to repair by finding another item from the same bucket
      console.warn(`[Chunk] Missing content for hash ${slot.mondai_hash}. Attempting repair...`);
      try {
        const snapRes = await db.query(
          'SELECT snapshot_id, bucket_key FROM pool_snapshot_items WHERE mondai_hash=$1 LIMIT 1',
          [slot.mondai_hash]
        );

        if (snapRes.rows.length > 0) {
          const { snapshot_id, bucket_key } = snapRes.rows[0];
          // Resample (using simple random as this is emergency fallback)
          const newHash = await sampleMondaiFromBucket(snapshot_id, bucket_key, Math.random, [slot.mondai_hash]);

          // Fetch new content
          const mRes2 = await db.query('SELECT content FROM mondai_bank WHERE hash=$1', [newHash]);
          if (mRes2.rows.length > 0) {
            content = parseJsonb(mRes2.rows[0].content);
            // Update Blueprint (Persistent Repair)
            slot.mondai_hash = newHash;
            blueprintModified = true;
            console.log(`[Chunk] Repaired slot with new hash ${newHash}`);
          }
        }
      } catch (e) {
        console.error('[Chunk] Repair failed:', e.message);
      }
    }

    if (content) {
      mondaiToDeliver.push(content);
    }

    cursor++;

    if (slot.delivery_mode === 'whole') {
      // If reading, stop after 1 to ensure integrity (unless client asked for more?)
      // Requirement says "Whole mondai at once". A chunk can contain 1 reading mondai.
      break;
    }
  }

  // Update state
  if (!deliveryState.cursors) deliveryState.cursors = {};
  deliveryState.cursors[want.group_id] = cursor;

  if (blueprintModified) {
    await db.query(
      'UPDATE exam_instances_cache SET delivery_state=$1, blueprint=$2 WHERE instance_key=$3',
      [JSON.stringify(deliveryState), JSON.stringify(blueprint), instanceKey]
    );
  } else {
    await db.query(
      'UPDATE exam_instances_cache SET delivery_state=$1 WHERE instance_key=$2',
      [JSON.stringify(deliveryState), instanceKey]
    );
  }

  return {
    mondai: mondaiToDeliver,
    nextCursor: cursor,
    done: cursor >= group.mondai_slots.length
  };
}

// POST /api/exam/start
app.post('/api/exam/start', authMiddleware, async (req, res) => {
  try {
    const { examSpec, mode, setNo, force_new } = req.body;
    const userId = req.user.userId;

    // Wait for DB initialization
    if (!(await db.initDb())) {
      return res.status(503).json({ error: 'DB unavailable for V2' });
    }

    const user = await loadUserData(userId, req.user.email);
    const plan = user.plan || 'free';
    const level = examSpec.level || examSpec.default_level;

    // Normalize Exam Spec (prevent crashes)
    if (!examSpec.modes) examSpec.modes = DEFAULT_MODES;

    // Deterministic Set No logic
    const today = new Date().toISOString().split('T')[0];
    let finalSetNo = setNo;

    // If force_new requested, rotate set_no to ensure uniqueness
    if (force_new) {
      // Using monotonic timestamp % 100000 to keep it as integer but unique enough per user session
      finalSetNo = Math.floor(Date.now() / 1000) % 100000;
    } else if (finalSetNo === undefined) {
      const hash = crypto.createHash('sha256')
        .update(`${userId}-${level}-${mode}-${today}`)
        .digest('hex');
      finalSetNo = parseInt(hash.substring(0, 8), 16) % 100;
    }

    // 1. Check if instance already exists (Idempotency)
    // Optimization: Avoid expensive blueprint build if we can reuse.
    let instanceKey, blueprint;

    // Helper to fetch existing
    const fetchExisting = async () => {
      const res = await db.query(
        'SELECT instance_key, blueprint FROM exam_instances_cache WHERE user_id=$1 AND exam_id=$2 AND level=$3 AND mode=$4 AND set_no=$5',
        [userId, examSpec.exam_id, level, mode, finalSetNo]
      );
      return res.rows[0];
    };

    const existingRow = await fetchExisting();

    if (existingRow) {
      // REUSE EXISTING
      console.log(`[Exam] Reusing existing instance for user ${userId}, set ${finalSetNo}`);
      instanceKey = existingRow.instance_key;
      blueprint = parseJsonb(existingRow.blueprint);

      // Extend expiry AND RESET delivery state (as requested)
      await db.query(`
            UPDATE exam_instances_cache 
            SET expires_at = (CURRENT_TIMESTAMP + INTERVAL '3 days'),
                delivery_state = $2
            WHERE instance_key = $1
        `, [instanceKey, JSON.stringify({ cursors: {} })]);

    } else {
      // CREATE NEW

      // Ensure Pool (fast/lazy)
      const snapshotId = await ensurePoolSnapshot(examSpec, level, today, plan, mode);

      // Build Blueprint
      const seed = crypto.randomUUID();
      const newBlueprint = await buildExamBlueprint(examSpec, level, mode, seed, finalSetNo, plan, snapshotId);
      const newInstanceKey = crypto.randomUUID();
      const answerKeys = {}; // Loaded lazily

      try {
        // Insert with ON CONFLICT DO NOTHING (Race condition handling)
        // If conflict occurs (someone else created it while we were building), we catch 23505 or handle via row count.
        await db.query(`
              INSERT INTO exam_instances_cache 
              (instance_key, user_id, exam_id, level, mode, plan, seed, set_no, blueprint, delivery_state, answer_keys)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            `, [
          newInstanceKey, userId, examSpec.exam_id, level, mode, plan, seed, finalSetNo,
          JSON.stringify(newBlueprint),
          JSON.stringify({ cursors: {} }),
          JSON.stringify(answerKeys)
        ]);

        instanceKey = newInstanceKey;
        blueprint = newBlueprint;
      } catch (e) {
        // Race condition: Conflict on unique key?
        if (e.code === '23505') {
          console.log('[Exam] Race condition on insert, reusing winner.');
          const winnerRow = await fetchExisting();
          if (winnerRow) {
            instanceKey = winnerRow.instance_key;
            blueprint = parseJsonb(winnerRow.blueprint);
            // Reset state for the winner too? user implies "start fresh"
            await db.query(`UPDATE exam_instances_cache SET delivery_state = $2 WHERE instance_key = $1`, [instanceKey, JSON.stringify({ cursors: {} })]);
          } else {
            throw e; // Should not happen
          }
        } else {
          throw e;
        }
      }

      // Ensure attempt record exists
      await db.query(`
          INSERT INTO attempts (instance_key, user_id, status)
          VALUES ($1, $2, 'active')
          ON CONFLICT DO NOTHING
        `, [instanceKey, userId]);
    }

    // First chunk (first 2 items of first group)
    const firstGroup = blueprint.groups[0];
    const firstChunk = await deliverNextChunk(instanceKey, {
      group_id: firstGroup.group_id,
      want_count: 2
    });

    res.json({
      instanceKey,
      manifest: {
        groups: blueprint.groups.map(g => ({
          group_id: g.group_id,
          title_vi: g.title_vi,
          expected_mondai_count: g.mondai_slots.length
        }))
      },
      firstChunk: sanitizeMondaiForClient(firstChunk),
      // Note: sanitizeMondaiForClient expects {mondai: []} or array. deliverNextChunk returns object with .mondai array
      // wrapper needed:
      mondai: sanitizeMondaiForClient({ mondai: firstChunk.mondai }).mondai,
      prefetchHints: [] // TODO: Add hints
    });

  } catch (err) {
    console.error('Start exam V2 error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/exam/chunk
app.post('/api/exam/chunk', authMiddleware, async (req, res) => {
  try {
    const { instanceKey, want } = req.body;

    // Wait for DB initialization
    if (!(await db.initDb())) {
      return res.status(503).json({ error: 'DB unavailable' });
    }

    const chunk = await deliverNextChunk(instanceKey, want);

    res.json({
      chunk: sanitizeMondaiForClient({ mondai: chunk.mondai }).mondai,
      nextCursor: chunk.nextCursor,
      done: chunk.done
    });
  } catch (err) {
    console.error('Chunk V2 error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/exam/quickgrade
app.post('/api/exam/quickgrade', authMiddleware, async (req, res) => {
  try {
    const { instanceKey, answers } = req.body;

    // Wait for DB initialization
    if (!(await db.initDb())) {
      return res.status(503).json({ error: 'DB unavailable' });
    }

    const inst = await db.query(
      'SELECT blueprint, user_id FROM exam_instances_cache WHERE instance_key=$1',
      [instanceKey]
    );

    if (inst.rows.length === 0) return res.status(404).json({ error: 'Instance not found' });
    if (inst.rows[0].user_id !== req.user.userId) return res.status(403).json({ error: 'Unauthorized' });

    const blueprint = parseJsonb(inst.rows[0].blueprint);

    // Grade by checking each answer against mondai_bank content
    // This assumes we didn't store answer_keys in cache yet.
    // Iterating all answers provided by user

    const results = {};
    let correctCount = 0;
    let totalCount = 0;

    // Gather all hashes we need to check
    const neededHashes = new Set();
    // Map question ID to mondai hash? 
    // Blueprint has mondai_slots. We don't know which question belongs to which mondai easily without loading?
    // Actually we do not. The client sends { questionId: answer }.
    // Server needs to find the question.
    // Optimization: Load ALL mondai in blueprint? Expensive.
    // Real implementation: Exam Instances Cache should ideally store map { questionId: { correct: 0, hash: ... } }
    // But we skipped that in START.
    // So we must load hashes.

    // For now, load all mondai hashes used in blueprint.
    const allHashes = [];
    blueprint.groups.forEach(g => g.mondai_slots.forEach(s => allHashes.push(s.mondai_hash)));

    // Query DB for all contents (might be heavy for full exam, but efficient with hash IN (...))
    // Limit to 100 items?
    const contentRes = await db.query(
      'SELECT content FROM mondai_bank WHERE hash = ANY($1)',
      [allHashes]
    );

    // Build efficient map: QuestionID -> CorrectAnswer
    const answerMap = {};
    contentRes.rows.forEach(row => {
      const m = parseJsonb(row.content);
      if (m.items) {
        m.items.forEach(item => {
          if (item.id && item.answer_index !== undefined) {
            answerMap[item.id] = item.answer_index;
          }
        });
      }
    });

    const byQuestion = {};

    for (const [qId, userAns] of Object.entries(answers)) {
      if (answerMap[qId] !== undefined) {
        const correct = answerMap[qId];
        const isCorrect = (userAns === correct);
        if (isCorrect) correctCount++;
        totalCount++;
        byQuestion[qId] = { correct: isCorrect };
        // DO NOT return correct answer
      }
    }

    // Update attempts
    await db.query(
      "UPDATE attempts SET status='submitted', submitted_at=NOW(), summary=$1 WHERE instance_key=$2",
      [JSON.stringify({ correct: correctCount, total: totalCount }), instanceKey]
    );

    res.json({
      score_summary: {
        correct: correctCount,
        total: totalCount,
        percentage: totalCount ? Math.round(correctCount / totalCount * 100) : 0
      },
      by_question: byQuestion
    });

  } catch (err) {
    console.error('Quickgrade V2 error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/exam/prefetch-tts
app.post('/api/exam/prefetch-tts', authMiddleware, async (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items)) return res.status(400).json({ error: 'Items array required' });

    // Wait for DB initialization (required for metrics logging)
    if (!(await db.initDb())) {
      // In auto mode, we might proceed without metrics? 
      // But prefetch is a "premium" feature likely requiring DB. 
      // Let's enforce it or log warning.
      // Given plan says V2 endpoints must check DB.
      return res.status(503).json({ error: 'DB unavailable' });
    }

    let cachedCount = 0;
    const scheduled = [];

    for (const item of items) {
      if (!item.text) continue;

      const lang = item.language || 'ja-JP';
      const isDlg = isDialogue(item.text);

      // Only cache non-dialogue currently (dialogue is complex)
      if (!isDlg) {
        const defaultVoice = lang === 'ja-JP' ? 'aura-2-fujin-ja' : 'aura-2-thalia-en';
        const voice = item.voice || defaultVoice;
        const hash = generateTextHash(item.text, lang, voice);

        if (getTTSFromCache(hash)) {
          cachedCount++;
        } else {
          scheduled.push({ ...item, hash, voice, lang });
        }
      }
    }

    // Trigger background generation for a few items (prevent flood)
    const MAX_PREFETCH = 5;
    const toProcess = scheduled.slice(0, MAX_PREFETCH);

    (async () => {
      for (const task of toProcess) {
        try {
          // Generate audio
          const audio = await generateDeepgramAudio(task.text, task.voice);
          setTTSCache(task.hash, audio);

          // Log metric
          await db.query(
            `INSERT INTO tts_metrics (provider, voice, language, text_len, latency_ms) VALUES ($1, $2, $3, $4, 0)`,
            ['deepgram-prefetch', task.voice, task.lang, task.text.length]
          ).catch(e => console.error('Metric log error:', e.message));

        } catch (e) {
          console.warn('Prefetch failed:', e.message);
        }
      }
    })();

    res.json({
      ok: true,
      cached: cachedCount,
      scheduled: toProcess.length,
      eta: toProcess.length * 1200 // estimated 1.2s per item
    });

  } catch (err) {
    console.error('Prefetch error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/coupon/redeem (Stub)
app.post('/api/coupon/redeem', authMiddleware, async (req, res) => {
  res.json({ success: false, message: "Coming soon" });
});

// POST /api/published-exams (Stub)
app.get('/api/published-exams', authMiddleware, async (req, res) => {
  res.json({ exams: [] });
});

// ============ Serve SPA ============

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../web/index.html'));
});

// Start server
if (require.main === module) {
  (async () => {
    // Fail-fast DB check for Neon mode
    if (IS_NEON_MODE) {
      console.log('[Boot] Neon mode active. Checking DB connection...');
      const ok = await db.initDb();
      if (!ok) {
        console.error('[FATAL] Neon mode requires DB connection. Exiting.');
        process.exit(1);
      }
    }

    app.listen(PORT, () => {
      console.log(`Language Exam Server running on http://localhost:${PORT}`);
      console.log(`DB Mode: ${DB_MODE} (Strict: ${IS_NEON_MODE})`);
      console.log(`Auth Mode: ${IS_DEMO_MODE ? 'DEMO MODE (no auth required)' : 'Privy (' + PRIVY_APP_ID + ')'}`);
    });
  })();
}

module.exports = app;
