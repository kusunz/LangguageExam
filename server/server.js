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
const {
  buildProviderStages,
  createTemporaryUnavailableError,
  getTemporaryUnavailablePayload,
  isTemporaryUnavailableError,
  runJsonTask
} = require('./providers/llm-router');
const { callOpenRouter } = require('./providers/openrouter');
const { callGeminiText } = require('./providers/gemini');
const {
  runEmbeddingBackfill
} = require('./providers/embeddings');
const {
  recordServedMondaiHistory,
  selectMondaiFromBucket
} = require('./exam-history');
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
app.use(express.static(path.join(__dirname, '../web/public')));
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

// Rate limiting for TTS endpoints (prevent cost runaway)
const ttsLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 TTS requests per minute per user
  message: { error: 'Too many TTS requests, please slow down' },
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
const DEMO_SESSION_HEADER = 'x-demo-session-id';
const DEMO_USER_PREFIX = 'demo:';
let lastDemoCleanupAt = 0;

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


function isDemoUserId(userId) {
  return userId === 'demo-user' || String(userId || '').startsWith(DEMO_USER_PREFIX);
}

function getDemoUserFromRequest(req) {
  const providedSessionId = req.get(DEMO_SESSION_HEADER);
  if (!providedSessionId) {
    return { userId: 'demo-user', email: 'demo@example.com' };
  }

  const rawSessionId = String(providedSessionId).trim();
  const normalized = rawSessionId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'legacy-demo';
  const suffix = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  return {
    userId: `${DEMO_USER_PREFIX}${suffix}`,
    email: `demo+${suffix}@example.com`
  };
}

async function cleanupExpiredDemoArtifacts(force = false) {
  if (!force && (Date.now() - lastDemoCleanupAt) < 10 * 60 * 1000) return;
  lastDemoCleanupAt = Date.now();

  if (!(await db.initDb())) return;

  try {
    await db.query(`DELETE FROM attempts WHERE (user_id = 'demo-user' OR user_id LIKE 'demo:%') AND started_at < NOW() - INTERVAL '1 day'`);
    await db.query(`DELETE FROM exam_instances_cache WHERE (user_id = 'demo-user' OR user_id LIKE 'demo:%') AND created_at < NOW() - INTERVAL '1 day'`);
    await db.query(`DELETE FROM sessions WHERE (user_id = 'demo-user' OR user_id LIKE 'demo:%') AND created_at < NOW() - INTERVAL '1 day'`);
    await db.query(`DELETE FROM users WHERE (id = 'demo-user' OR id LIKE 'demo:%') AND COALESCE(last_login_at, created_at, NOW()) < NOW() - INTERVAL '1 day'`);
  } catch (error) {
    console.warn('[DemoCleanup] Failed:', error.message);
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
    req.user = getDemoUserFromRequest(req);
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
    req.user = getDemoUserFromRequest(req);
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

// Text Normalization Helpers
function toText(obj) {
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  if (Array.isArray(obj)) return obj.map(toText).join('\n');
  if (typeof obj === 'object') {
    return Object.values(obj).map(toText).join('\n');
  }
  return String(obj);
}

function shortText(obj, len = 200) {
  const txt = toText(obj);
  return txt.length > len ? txt.substring(0, len) + '...' : txt;
}

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
  if (IS_DEMO_MODE || isDemoUserId(userId)) {
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

  if (IS_DEMO_MODE || isDemoUserId(userId)) return;

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
async function abandonOtherActiveAttempts(userId, keepInstanceKey = null) {
  const params = [userId];
  let query = `
    UPDATE attempts
    SET status='abandoned', submitted_at=COALESCE(submitted_at, NOW())
    WHERE user_id=$1 AND status='active'
  `;

  if (keepInstanceKey) {
    params.push(keepInstanceKey);
    query += ' AND instance_key <> $2';
  }

  await db.query(query, params);
}

async function ensureActiveAttempt(userId, instanceKey) {
  const updateRes = await db.query(`
    UPDATE attempts
    SET status='active', submitted_at=NULL
    WHERE user_id=$1 AND instance_key=$2
  `, [userId, instanceKey]);

  if (updateRes.rowCount > 0) {
    return;
  }

  try {
    await db.query(`
      INSERT INTO attempts (instance_key, user_id, status)
      VALUES ($1, $2, 'active')
    `, [instanceKey, userId]);
  } catch (err) {
    if (err.code === '23505') {
      await db.query(`
        UPDATE attempts
        SET status='active', submitted_at=NULL
        WHERE user_id=$1 AND instance_key=$2
      `, [userId, instanceKey]);
      return;
    }
    throw err;
  }
}

async function abandonAttempt(userId, instanceKey) {
  return db.query(`
    UPDATE attempts
    SET status='abandoned', submitted_at=COALESCE(submitted_at, NOW())
    WHERE user_id=$1 AND instance_key=$2 AND status='active'
  `, [userId, instanceKey]);
}

async function getExamInstanceAccess(userId, instanceKey) {
  const inst = await db.query(
    'SELECT user_id FROM exam_instances_cache WHERE instance_key=$1',
    [instanceKey]
  );

  if (inst.rows.length === 0) {
    return { ok: false, status: 404, error: 'Instance not found' };
  }

  if (inst.rows[0].user_id !== userId) {
    return { ok: false, status: 404, error: 'Instance not found' };
  }

  const attempt = await db.query(
    `SELECT status
     FROM attempts
     WHERE user_id=$1 AND instance_key=$2
     ORDER BY started_at DESC
     LIMIT 1`,
    [userId, instanceKey]
  );

  return {
    ok: true,
    attemptStatus: attempt.rows[0]?.status || null
  };
}
async function manageSession(userId, existingSessionId, email = '') {
  try {
    // Use transaction to ensure atomicity
    await db.query('BEGIN');

    // 0. Ensure user exists (UPSERT) - prevents FK violation on sessions insert
    await db.query(`
      INSERT INTO users (id, email, data)
      VALUES ($1, $2, '{}')
      ON CONFLICT (id) DO UPDATE SET last_login_at = NOW()
    `, [userId, email || '']);

    // 1. Clean up expired sessions
    await db.query('DELETE FROM sessions WHERE expires_at < NOW()');

    // 2. Check if existing session is valid (must be a valid UUID)
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(existingSessionId);

    if (existingSessionId && isUUID) {
      const res = await db.query('SELECT id FROM sessions WHERE id = $1 AND user_id = $2', [existingSessionId, userId]);
      if (res.rows.length > 0) {
        // Refresh expiry (extend by 7 days)
        await db.query("UPDATE sessions SET expires_at = NOW() + INTERVAL '7 days' WHERE id = $1", [existingSessionId]);
        await db.query('COMMIT');
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

    await db.query('COMMIT');
    return newSessionRes.rows[0].id;
  } catch (err) {
    await db.query('ROLLBACK').catch(() => { });
    console.error('manageSession error:', err.code || 'UNKNOWN', err.message);
    throw err;
  }
}

// Get user data (Acts as Login/Session Init)
app.post('/api/user-data', authMiddleware, async (req, res) => {
  try {
    const { sessionId } = req.body; // Frontend sends current session ID if exists

    // Check DB status
    const dbOk = await db.initDb();

    if (dbOk && isDemoUserId(req.user.userId)) {
      await cleanupExpiredDemoArtifacts();
    }

    // Manage Session (only if DB available and not demo user)
    let activeSessionId = null;
    if (dbOk && !isDemoUserId(req.user.userId)) {
      try {
        activeSessionId = await manageSession(req.user.userId, sessionId, req.user.email);
      } catch (e) {
        console.error('Session management failed:', e.message, e.code || '', e.detail || '');
        // Continue without session if DB fails momentarily
      }
    }

    // Load Data
    const data = await loadUserData(req.user.userId, req.user.email);

    // Update last login (only if DB available and not demo)
    if (dbOk && !isDemoUserId(req.user.userId)) {
      try {
        await db.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [req.user.userId]);
      } catch (e) {
        console.error('Update last_login failed:', e.message, e.code || '');
      }
    }

    res.json({ ...data, sessionId: activeSessionId });
  } catch (err) {
    console.error('Load user data error:', {
      message: err.message,
      code: err.code || 'UNKNOWN',
      detail: err.detail || null,
      stack: err.stack
    });
    res.status(500).json({
      error: 'Failed to load user data',
      code: err.code || 'UNKNOWN',
      message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
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

    if (IS_DEMO_MODE || isDemoUserId(userId)) return res.json({ success: true, demo: true });

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
    if (IS_DEMO_MODE || isDemoUserId(userId)) return res.json({ items: [] });

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

function normalizeMondaiIdToken(mondaiId) {
  return String(mondaiId || 'm')
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '')
    .toLowerCase() || 'm';
}

function buildCanonicalQuestionId(mondaiId, itemIndex) {
  return `${normalizeMondaiIdToken(mondaiId)}_q${String(itemIndex + 1).padStart(2, '0')}`;
}

function buildQuestionReviewLabel(mondaiId, itemIndex) {
  const normalized = String(mondaiId || '').toUpperCase();
  const match = normalized.match(/^([A-Z]+)(\d+)$/);
  if (!match) return `Câu ${itemIndex + 1}`;

  const [, prefix, numericPart] = match;
  const sectionLabel = prefix === 'L'
    ? `Listen ${numericPart}`
    : `Mondai ${numericPart}`;

  return `${sectionLabel} - Câu ${itemIndex + 1}`;
}

function canonicalizeMondaiQuestionIds(mondai, options = {}) {
  if (!mondai || typeof mondai !== 'object') return mondai;

  const canonicalMondaiId = options.mondaiId || mondai.mondai_id || 'M';
  mondai.mondai_id = canonicalMondaiId;

  if (!Array.isArray(mondai.items)) return mondai;

  mondai.items = mondai.items.map((rawItem, itemIndex) => {
    const item = rawItem && typeof rawItem === 'object' ? rawItem : {};
    const canonicalId = buildCanonicalQuestionId(canonicalMondaiId, itemIndex);
    const reviewLabel = buildQuestionReviewLabel(canonicalMondaiId, itemIndex);

    if (!item.meta || typeof item.meta !== 'object') {
      item.meta = {};
    }

    if (item.id && item.id !== canonicalId) {
      item.meta.generated_id = item.id;
    }

    item.id = canonicalId;
    item.review_label = reviewLabel;
    item.meta.canonical_id = canonicalId;
    item.meta.review_label = reviewLabel;
    item.meta.question_index = itemIndex;
    item.meta.mondai_id = canonicalMondaiId;

    return item;
  });

  return mondai;
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
const BLUEPRINT_GENERATION_CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.BLUEPRINT_GENERATION_CONCURRENCY || '4', 10)
);
const OPENROUTER_RPM = Math.max(
  1,
  Number.parseInt(process.env.OPENROUTER_RPM || '5', 10)
);

function getEffectiveBlueprintGenerationConcurrency() {
  const rpmBound = Math.max(1, Math.min(OPENROUTER_RPM, 5));
  return Math.max(1, Math.min(BLUEPRINT_GENERATION_CONCURRENCY, rpmBound));
}

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
  const { examSpec, level, mode, group, mondaiDef, bucketKey, snapshotId, count } = params;

  let remaining = Math.max(0, Number(count) || 0);
  if (remaining === 0) return;

  while (remaining > 0) {
    const batchSize = Math.min(remaining, 3);
    const mondaiBatch = Array(batchSize).fill(mondaiDef);
    const prompt = buildMondaiChunkPrompt(examSpec, mode, group, 0, mondaiBatch, 0, []);

    try {
      const generation = await runJsonTask({
        task: 'generate',
        prompt,
        validateResult: validateMondaiChunkResult,
        maxTokens: 8192,
        temperature: 0.8
      });
      const mondaiList = Array.isArray(generation?.result?.mondai) ? generation.result.mondai : [];

      if (mondaiList.length === 0) {
        remaining -= 1;
        continue;
      }

      for (const mondai of mondaiList) {
        if (remaining <= 0) break;

        mondai.mondai_id = mondaiDef.mondai_id;
        mondai.primary_type = mondaiDef.types[0];
        canonicalizeMondaiQuestionIds(mondai, { mondaiId: mondaiDef.mondai_id });

        const hash = generateMondaiHash(mondai);
        const itemType = mondai.mondai_type || mondaiDef.mondai_type || mondaiDef.types?.[0] || 'unknown';
        const estimatedCost = mondaiDef.estimated_seconds || 60;
        const insertRes = await db.query(`
            INSERT INTO mondai_bank (
              hash, exam_id, level, group_id, mondai_id,
              primary_type, item_type, estimated_cost, content, meta
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)
            ON CONFLICT (hash) DO NOTHING
            RETURNING hash
          `, [
          hash,
          examSpec.exam_id,
          level,
          group.group_id,
          mondaiDef.mondai_id,
          mondaiDef.types[0],
          itemType,
          estimatedCost,
          JSON.stringify(mondai),
          JSON.stringify({
            mode,
            generated_at: new Date().toISOString(),
            llm_provider: formatLlmProviderLabel(generation.meta)
          })
        ]);

        await db.query(`
            INSERT INTO pool_snapshot_items (snapshot_id, bucket_key, mondai_hash, group_id)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (snapshot_id, bucket_key, mondai_hash) DO NOTHING
          `, [snapshotId, bucketKey, hash, group.group_id]);

        remaining -= 1;
      }
    } catch (error) {
      console.error('Pool generation error:', error?.message || error);
      if (isTemporaryUnavailableError(error)) {
        throw error;
      }
      throw createTemporaryUnavailableError(error);
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
        if (isTemporaryUnavailableError(e)) {
          throw e;
        }
        break;
      }
    }

    bucketsProcessed++;
  }

  return { bucketsProcessed, generated, skipped };
}

async function runTasksWithConcurrency(taskFactories, limit) {
  const tasks = Array.isArray(taskFactories) ? taskFactories : [];
  if (tasks.length === 0) return [];

  const concurrency = Math.max(1, Number(limit) || 1);
  const results = new Array(tasks.length);
  let cursor = 0;

  async function worker() {
    while (cursor < tasks.length) {
      const currentIndex = cursor;
      cursor += 1;
      results[currentIndex] = await tasks[currentIndex]();
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function buildBlueprintSlotId(groupId, mondaiId, ordinal) {
  return `${groupId}:${mondaiId}:${ordinal + 1}`;
}

async function hydratePendingBlueprintSlots(params) {
  const {
    pendingSlots,
    examSpec,
    level,
    mode,
    snapshotId,
    plan,
    rng,
    usedHashes,
    userId,
    allowRepeat
  } = params;

  if (!Array.isArray(pendingSlots) || pendingSlots.length === 0) {
    return;
  }

  const generationTasks = pendingSlots.map(({ group, mondaiDef, slot }) => async () => {
    try {
      console.log(`[Blueprint] Bucket empty/exhausted: ${slot.bucket_key}. Triggering on-demand generation.`);
      await generateMondaiForBucket({
        examSpec,
        level,
        mode,
        group,
        mondaiDef,
        bucketKey: slot.bucket_key,
        snapshotId,
        count: ON_DEMAND_BATCH,
        plan
      });
      return { ok: true, slot, mondaiDef };
    } catch (error) {
      return { ok: false, slot, mondaiDef, error };
    }
  });

  const generationResults = await runTasksWithConcurrency(
    generationTasks,
    getEffectiveBlueprintGenerationConcurrency()
  );

  for (const result of generationResults) {
    if (result?.ok) continue;
    if (isTemporaryUnavailableError(result?.error)) {
      throw result.error;
    }

    console.warn(`Failed to generate bucket ${result?.slot?.bucket_key}:`, result?.error?.message || result?.error);
    throw createTemporaryUnavailableError(
      result?.error || new Error(`Failed to generate bucket ${result?.slot?.bucket_key || 'unknown'}`)
    );
  }

  for (const pending of pendingSlots) {
    const { mondaiDef, slot } = pending;
    if (slot._failed) continue;

    try {
      const hash = await sampleMondaiFromBucket(
        snapshotId,
        slot.bucket_key,
        rng,
        Array.from(usedHashes),
        {
          userId,
          allowRepeat,
          level,
          primaryType: mondaiDef.types?.[0] || null
        }
      );

      usedHashes.add(hash);
      slot.mondai_hash = hash;
      slot.status = 'ready';
    } catch (error) {
      if (isTemporaryUnavailableError(error)) {
        throw error;
      }

      console.warn(`Failed to hydrate slot ${slot.slot_id} after generation:`, error.message);
      throw createTemporaryUnavailableError(error);
    }
  }
}

/**
 * Build determinisic exam from pool
 */
async function buildExamBlueprint(examSpec, level, mode, seed, setNo, plan, snapshotId, selectionOptions = {}) {
  if (!snapshotId) throw new Error('Snapshot required');

  const { userId = null, allowRepeat = false } = selectionOptions;

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
  const pendingSlots = [];

  for (const group of examSpec.groups) {
    const groupBlueprint = {
      group_id: group.group_id, title_vi: group.title_vi, mondai_slots: []
    };

    for (const mondaiDef of group.mondai) {
      const isReading = mondaiDef.types.some(t => t.startsWith('reading_'));
      const targetCount = Math.max(1, Math.round(mondaiDef.count_official * qScale));

      const bucketKey = getBucketKey(group.group_id, mondaiDef.mondai_id, mondaiDef.types[0]);
      const slot = {
        slot_id: buildBlueprintSlotId(group.group_id, mondaiDef.mondai_id, groupBlueprint.mondai_slots.length),
        bucket_key: bucketKey,
        mondai_id: mondaiDef.mondai_id,
        type: mondaiDef.types[0],
        question_count: targetCount,
        delivery_mode: isReading ? 'whole' : 'flexible',
        status: 'pending'
      };

      groupBlueprint.mondai_slots.push(slot);
      try {
        const hash = await sampleMondaiFromBucket(
          snapshotId,
          bucketKey,
          rng,
          Array.from(usedHashes),
          { userId, allowRepeat, level, primaryType: mondaiDef.types?.[0] || null }
        );
        usedHashes.add(hash);
        slot.mondai_hash = hash;
        slot.status = 'ready';
      } catch (error) {
        if (isTemporaryUnavailableError(error)) {
          throw error;
        }
        pendingSlots.push({ group, mondaiDef, slot });
      }
    }
    blueprint.groups.push(groupBlueprint);
  }

  await hydratePendingBlueprintSlots({
    pendingSlots,
    examSpec,
    level,
    mode,
    snapshotId,
    plan,
    rng,
    usedHashes,
    userId,
    allowRepeat
  });

  const missingSlots = blueprint.groups.flatMap((group) =>
    (group.mondai_slots || []).filter((slot) => !slot.mondai_hash)
  );

  if (missingSlots.length > 0) {
    throw createTemporaryUnavailableError(
      new Error(`Blueprint incomplete: ${missingSlots.map((slot) => slot.slot_id || slot.bucket_key || 'unknown').join(', ')}`)
    );
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

async function sampleMondaiFromBucket(snapshotId, bucketKey, rng, usedHashes, options = {}) {
  return selectMondaiFromBucket(db, {
    snapshotId,
    bucketKey,
    rng,
    usedHashes,
    userId: options.userId || null,
    allowRepeat: !!options.allowRepeat,
    level: options.level || null,
    primaryType: options.primaryType || null
  });
}

// ============ LLM Endpoints ============

// Gemini TTS models (for TTS fallback)
const GEMINI_TTS_MODELS = [
  'gemini-2.5-pro-tts',
  'gemini-2.5-flash-tts'
];

function validateQuestionItem(item) {
  const errors = [];
  if (!item || typeof item !== 'object') return ['item_not_object'];
  if (item.id !== undefined && typeof item.id !== 'string') errors.push('id_invalid');
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

function validateMondaiChunkResult(result) {
  const errors = [];
  if (!result || typeof result !== 'object') return ['chunk_not_object'];
  if (!Array.isArray(result.mondai) || result.mondai.length === 0) errors.push('missing_mondai');
  if (!Array.isArray(result.mondai)) return errors;

  result.mondai.forEach((mondai, index) => {
    if (!mondai || typeof mondai !== 'object') {
      errors.push(`mondai_${index}_not_object`);
      return;
    }
    if (!mondai.mondai_id || typeof mondai.mondai_id !== 'string') errors.push(`mondai_${index}_missing_mondai_id`);
    if (!mondai.title_vi || typeof mondai.title_vi !== 'string') errors.push(`mondai_${index}_missing_title_vi`);
    if (!Array.isArray(mondai.items) || mondai.items.length === 0) errors.push(`mondai_${index}_missing_items`);

    if (Array.isArray(mondai.items)) {
      mondai.items.forEach((item, itemIndex) => {
        const itemErrors = validateQuestionItem(item);
        if (itemErrors.length > 0) {
          errors.push(`mondai_${index}_item_${itemIndex}:${itemErrors.join(',')}`);
        }
      });
    }
  });

  return errors;
}

function validateExplanationResult(result) {
  const errors = [];
  if (!result || typeof result !== 'object') return ['result_not_object'];
  if (!result.explanations || typeof result.explanations !== 'object') errors.push('missing_explanations');
  if (result?.explanations && typeof result.explanations === 'object') {
    Object.entries(result.explanations).forEach(([key, value]) => {
      if (typeof value !== 'string' || value.trim() === '') {
        errors.push(`invalid_explanation:${key}`);
      }
    });
  }
  return errors;
}

function formatLlmProviderLabel(meta) {
  if (!meta?.provider) return 'llm-router';
  return meta.model ? `${meta.provider}:${meta.model}` : meta.provider;
}

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
    const { test, answers, instanceKey } = req.body;

    // ======== V2 Branch: instanceKey present ========
    if (instanceKey && await db.initDb()) {
      const access = await getExamInstanceAccess(req.user.userId, instanceKey);
      if (!access.ok) {
        return res.status(access.status).json({ error: access.error });
      }
      if (access.attemptStatus && access.attemptStatus !== 'active') {
        return res.status(409).json({ error: 'Exam session has ended' });
      }

      const inst = await db.query(
        'SELECT blueprint, user_id FROM exam_instances_cache WHERE instance_key=$1',
        [instanceKey]
      );
      if (inst.rows.length === 0) return res.status(404).json({ error: 'Instance not found' });
      if (inst.rows[0].user_id !== req.user.userId) return res.status(403).json({ error: 'Unauthorized' });

      const blueprint = parseJsonb(inst.rows[0].blueprint);
      const sortedAnswers = JSON.stringify(Object.entries(answers || {}).sort());
      const answersHash = crypto.createHash('sha256').update(instanceKey + sortedAnswers).digest('hex');

      const cachedAttempt = await db.query(
        'SELECT summary FROM attempts WHERE instance_key=$1 AND user_id=$2 AND answers_hash=$3 AND summary IS NOT NULL',
        [instanceKey, req.user.userId, answersHash]
      );
      if (cachedAttempt.rows.length > 0 && cachedAttempt.rows[0].summary) {
        const cached = parseJsonb(cachedAttempt.rows[0].summary);
        if (cached && cached.by_question) {
          console.log('[Grade V2] Returning cached AI result');
          cached.cached = true;
          return res.json(cached);
        }
      }

      const allHashes = [];
      blueprint.groups.forEach((group) => group.mondai_slots.forEach((slot) => allHashes.push(slot.mondai_hash)));
      const contentRes = await db.query(
        'SELECT hash, content FROM mondai_bank WHERE hash = ANY($1)',
        [allHashes]
      );

      const questionMap = {};
      contentRes.rows.forEach((row) => {
        const mondai = parseJsonb(row.content);
        canonicalizeMondaiQuestionIds(mondai, { mondaiId: mondai?.mondai_id });
        if (mondai.items) {
          mondai.items.forEach((item) => {
            if (item.id && item.answer_index !== undefined) {
              questionMap[item.id] = {
                correct_index: item.answer_index,
                prompt: item.prompt,
                choices: item.choices,
                tags: item.tags || [],
                explain_brief: item.explain_brief || '',
                passage: mondai.passage || ''
              };
            }
          });
        }
      });

      let correctCount = 0;
      let totalCount = 0;
      const byQuestion = [];
      const wrongQuestions = [];
      const submittedIds = Object.keys(answers || {});
      const invalidIds = submittedIds.filter((id) => !questionMap[id]);
      if (invalidIds.length > 0) {
        return res.status(400).json({
          error: 'Invalid question IDs',
          invalid: invalidIds.slice(0, 10)
        });
      }

      for (const [questionId, userAnswer] of Object.entries(answers || {})) {
        const question = questionMap[questionId];
        if (!question) continue;

        totalCount += 1;
        const isCorrect = userAnswer === question.correct_index;
        if (isCorrect) correctCount += 1;

        const questionResult = {
          id: questionId,
          is_correct: isCorrect,
          user_answer_index: userAnswer,
          correct_index: question.correct_index,
          prompt: question.prompt,
          choices: question.choices,
          tags: question.tags,
          key_point_vi: question.explain_brief
        };

        byQuestion.push(questionResult);

        if (!isCorrect) {
          wrongQuestions.push({
            id: questionId,
            prompt: question.prompt,
            choices: question.choices,
            user_answer: userAnswer !== null && userAnswer !== undefined ? question.choices[userAnswer] : '(chưa trả lời)',
            correct_answer: question.choices[question.correct_index],
            passage_snippet: question.passage ? shortText(question.passage) : ''
          });
        }
      }

      if (wrongQuestions.length > 0) {
        const wrongPrompt = `Bạn là gia sư JLPT. Giải thích ngắn gọn bằng tiếng Việt cho ${wrongQuestions.length} câu sai.
Trả lời JSON: { "explanations": { "<question_id>": "<giải thích 1-2 câu>" } }

${wrongQuestions.map((wq, idx) => `[Câu ${idx + 1}] id="${wq.id}"
Đề: ${wq.prompt}
Đáp án đúng: ${wq.correct_answer}
Thí sinh chọn: ${wq.user_answer}
${wq.passage_snippet ? `Ngữ cảnh: ${wq.passage_snippet}...` : ''}`).join('\n\n')}`;
        const explanationResult = await runJsonTask({
          task: 'explain',
          prompt: wrongPrompt,
          validateResult: validateExplanationResult,
          maxTokens: 4096,
          temperature: 0.2
        });

        const explanations = explanationResult?.result?.explanations || {};
        byQuestion.forEach((question) => {
          if (explanations[question.id]) {
            question.key_point_vi = explanations[question.id];
          }
        });
      }

      const result = {
        score_summary: {
          total_score: correctCount,
          max_score: totalCount,
          percentage: totalCount ? Math.round(correctCount / totalCount * 100) : 0,
          weak_tags: byQuestion
            .filter((question) => !question.is_correct)
            .flatMap((question) => question.tags || [])
            .filter((value, index, array) => array.indexOf(value) === index)
            .slice(0, 10),
          recommendation_vi: correctCount >= totalCount * 0.7
            ? 'Kết quả tốt! Tiếp tục luyện tập để cải thiện.'
            : 'Cần ôn tập thêm các phần còn yếu.'
        },
        by_question: byQuestion,
        grading_mode: 'ai',
        cached: false
      };

      const summaryJson = JSON.stringify(result);
      await db.query(`
        UPDATE attempts
        SET status='graded', summary=$3, answers_hash=$4, ai_grade=$5, submitted_at=NOW()
        WHERE user_id=$1 AND instance_key=$2
      `, [req.user.userId, instanceKey, summaryJson, answersHash, summaryJson]);

      return res.json(result);
    }

    // ======== V1 Legacy: full test object ========
    const prompt = buildGradeTestPrompt(test, answers);
    const grading = await runJsonTask({
      task: 'explain',
      prompt,
      maxTokens: 16384,
      temperature: 0.2
    });
    const result = grading.result;

    try {
      await db.query(
        'INSERT INTO exam_results (user_id, exam_id, score, summary, data) VALUES ($1, $2, $3, $4, $5)',
        [req.user.userId, test.meta.exam_id, result.score_summary.total_score, JSON.stringify(result), JSON.stringify({ test, answers })]
      );
    } catch (dbErr) {
      console.error('Failed to save exam result to DB:', dbErr);
    }

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
      if (userData.history.length > 20) userData.history.pop();
      await saveUserData(req.user.userId, userData);
    } catch (histErr) {
      console.error('Failed to update user history:', histErr);
    }

    return res.json(result);
  } catch (err) {
    console.error('Grade test error:', err);
    if (isTemporaryUnavailableError(err)) {
      return res.status(503).json(getTemporaryUnavailablePayload(err));
    }
    return res.status(500).json({ error: 'Failed to grade test: ' + err.message });
  }
});

// Prepare TTS text
app.post('/api/prepare-tts-text', authMiddleware, async (req, res) => {
  try {
    const { text, language } = req.body;
    const prompt = buildTtsTextPrompt(text, language);
    const prepared = await runJsonTask({
      task: 'explain',
      prompt,
      maxTokens: 4096,
      temperature: 0.2
    });

    res.json(prepared.result);
  } catch (err) {
    console.error('TTS text prep error:', err);
    if (isTemporaryUnavailableError(err)) {
      return res.status(503).json(getTemporaryUnavailablePayload(err));
    }
    return res.status(500).json({ error: 'Failed to prepare TTS text: ' + err.message });
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
app.post('/api/tts/stream', authMiddleware, ttsLimiter, async (req, res) => {
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
app.post('/api/tts', authMiddleware, ttsLimiter, async (req, res) => {
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

function getExamPromptProfile(examSpec) {
  const examId = String(examSpec?.exam_id || '').toLowerCase();

  if (examId.includes('jlpt') || examSpec?.language === 'ja-JP') {
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

    return {
      family: 'JLPT',
      authority: 'The Japan Foundation',
      systemRole: 'You are an AI Expert that generates JLPT exam content.',
      levelProfiles: jlptCanDo,
      fallbackLevel: jlptCanDo.N3,
      scopeRules: `Vocabulary, kanji, and grammar MUST satisfy ALL conditions:
- Belongs to ${examSpec.level} OR lower
- Frequently appears in official JLPT prep materials
- Natural Japanese usage (no textbook artifacts)`
    };
  }

  return {
    family: examSpec?.exam_id || 'language exam',
    authority: 'official exam conventions',
    systemRole: 'You are an AI Expert that generates language exam content.',
    levelProfiles: {},
    fallbackLevel: {
      desc: 'Keep the language natural, level-appropriate, and instruction-following.',
      grammar: 'Use grammar and vocabulary that match the declared level only.',
      types: 'Follow the requested question types exactly.'
    },
    scopeRules: `Vocabulary and grammar must stay within the declared level for ${examSpec?.display_name_vi || examSpec?.exam_id || 'this exam'} and remain natural for native materials.`
  };
}

// Build prompt for generating a chunk of mondai (2-3 at a time)
function buildMondaiChunkPrompt(examSpec, mode, group, groupIndex, mondaiToGenerate, startMondaiIndex, previousMondai = []) {
  const modeConfig = examSpec.modes[mode];
  const questionScale = modeConfig.question_scale;
  const promptProfile = getExamPromptProfile(examSpec);

  // Reading type IDs for special handling
  const readingTypes = ['reading_short', 'reading_mid', 'reading_long', 'reading_compare', 'reading_info'];
  // Listening type IDs
  const listeningTypes = ['listening_dialogue', 'listening_mono', 'listen_respond', 'listen_integration', 'listen_task'];

  // Current chunk mondai details
  const mondaiInfo = mondaiToGenerate.map((m, idx) => {
    const totalQuestions = Math.max(1, Math.round(m.count_official * questionScale));
    const isReading = m.types.some(t => readingTypes.includes(t));
    const isListening = m.types.some(t => listeningTypes.includes(t));
    const promptSlot = startMondaiIndex + idx + 1;
    const officialNum = String(m.mondai_id || '').match(/[A-Z]+(\d+)/i)?.[1] || String(promptSlot);
    const officialLabel = `${isListening || String(m.mondai_id || '').startsWith('L') ? 'Listen' : 'Mondai'} ${officialNum}`;

    if (isReading) {
      const targets = PASSAGE_LENGTH_TARGETS[mode] || PASSAGE_LENGTH_TARGETS['official'];
      const type = m.types.find(t => targets[t]) || 'reading_mid';
      const targetLength = targets[type] || 'medium length';

      return `  Slot ${promptSlot}: ${m.mondai_id} (${m.title_vi}) | official label: ${officialLabel}
    ONE passage (${targetLength}) with ${totalQuestions} questions, types: ${m.types.join(', ')}
    *** Create exactly ONE passage with ALL ${totalQuestions} questions included ***
    *** Passage may include subheadings if appropriate ***`;
    }

    if (isListening) {
      return `  Slot ${promptSlot}: ${m.mondai_id} (${m.title_vi}) | official label: ${officialLabel}
    ${totalQuestions} questions, types: ${m.types.join(', ')}
    ★★★ LISTENING AUDIO RULES ★★★
    - Put script_text at MONDAI level: mondai.media.script_text (NOT in items)
    - Use dialogue format: "A: こんにちは\nB: はい、こんにちは" (preferred for multi-voice TTS)
    - If monologue, still place at mondai.media.script_text
    - items[].media MUST be null or omitted`;
    }

    return `  Slot ${promptSlot}: ${m.mondai_id} (${m.title_vi}) | official label: ${officialLabel}
    ${totalQuestions} questions, types: ${m.types.join(', ')}`;
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

  const levelInfo = promptProfile.levelProfiles[examSpec.level] || promptProfile.fallbackLevel;

  return `${promptProfile.systemRole}
All output MUST conform to official standards defined by ${promptProfile.authority}.

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
CHUNK SLOTS: ${startMondaiIndex + 1} to ${startMondaiIndex + mondaiToGenerate.length} of ${group.mondai.length}
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
${promptProfile.scopeRules}

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
FORMATTING & EMPHASIS RULES
-------------------------
- FORBIDDEN: Do not use HTML tags like <u>, <i>, <b>.
- REQUIRED: For underlining/emphasis targets in questions, use exactly DOUBLE SQUARE BRACKETS.
  Example: 「[[昨日]]、何をしましたか。」
- Keep text plain and rely on [[...]] markers for highlights.
- For reading passages, structure with simple newlines.

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

-------------------------
EMPHASIS MARKERS (CRITICAL)
-------------------------
When highlighting kanji/vocabulary in prompts:
- Use [[word]] markers (double brackets) for emphasis
- Example: "Choose the correct reading for [[漢字]] in the sentence."
- DO NOT use HTML tags like <u> or <b>
- DO NOT use markdown ** or __
- ONLY use [[...]] for emphasized/target words

-------------------------
TITLE RULES (meta.display_title)
-------------------------
For each mondai, optionally include "meta.display_title" with format:
- Listening mondai: "Listen X" or "Listen X: {localizedTitle} ({日本語タイトル})"
- Non-listening: "Mondai X" or "Mondai X: {localizedTitle} ({日本語タイトル})"
Where X MUST come from mondai_id / official exam structure, never from local chunk order.
If mondai_id is M8, display_title must use Mondai 8.
If mondai_id is L3, display_title must use Listen 3.
{localizedTitle} should be in Vietnamese (target user language) and stay semantically aligned with the requested mondai title.
{日本語タイトル} is optional Japanese title in parentheses.
If omitted, UI will fallback to the canonical official label.
DO NOT include titles/headers inside passage.text or script_text.

-------------------------
QUESTION ID RULES
-------------------------
- items[].id SHOULD follow the canonical format: "<mondai_id_lowercase>_qNN"
- Example for M2: "m2_q01", "m2_q02"
- Example for L3: "l3_q01"
- Keep numbering sequential inside each mondai
- NEVER use generic/random ids like "item1", "question_1", "mondai1-q1", "N5_M2_001_Q1"
- If omitted, the server will normalize them, but following this format is strongly preferred

{
  "mondai": [
    {
      "mondai_id": "<string>",
      "title_vi": "<string>",
      "instructions_vi": "<Vietnamese instructions>",
      "meta": { "display_title": "<optional: Mondai X or Listen X: Localized Title (日本語)>" },
      "passage": { "title": "<optional>", "text": "<for reading>" },
      "media": { "script_text": "<for listening mondai ONLY - dialogue format A: ... B: ... preferred>" },
      "items": [
        {
          "id": "<example: m2_q01>",
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
1. why_wrong: Explain why the user's choice was wrong (bilingual: {vi, ja})
2. key_point: The key grammar/vocab point being tested (bilingual: {vi, ja})
3. mini_lesson: A mini lesson to help the user understand (bilingual: {vi, ja})
4. extra_examples: 2-3 example sentences in the target language (bilingual array of {vi, ja})
5. review_tasks: Suggested review tasks (bilingual: {vi, ja})

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
                    "why_wrong": { "vi": "<explanation>", "ja": "<explanation>" },
                    "key_point": { "vi": "<key point>", "ja": "<key point>" },
                    "mini_lesson": { "vi": "<mini lesson>", "ja": "<mini lesson>" },
                    "extra_examples": [ { "vi": "<translation>", "ja": "<example>" } ],
                    "review_tasks": { "vi": ["<task1>"], "ja": ["<task1>"] }
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

function getAdminSecretFromRequest(req) {
  return req.headers['x-warmup-secret'] || req.query.secret || req.body?.secret;
}

function isAuthorizedAdminRequest(req) {
  const expectedSecret = process.env.WARMUP_SECRET;
  const secret = getAdminSecretFromRequest(req);
  return Boolean(expectedSecret && secret && secret === expectedSecret);
}

function getLlmConfigSnapshot() {
  const tasks = ['generate', 'repair', 'explain'];
  const taskStages = Object.fromEntries(
    tasks.map((task) => [task, buildProviderStages(task).map((stage) => ({
      name: stage.name,
      provider: stage.provider,
      model: stage.model,
      repairModel: stage.repairModel || stage.model
    }))])
  );

  return {
    openrouterConfigured: Boolean(process.env.OPENROUTER_API_KEY),
    geminiConfigured: Boolean(
      process.env.GEMINI_API_KEY ||
      process.env.GEMINI_API_KEY_A ||
      process.env.GEMINI_API_KEY_B
    ),
    embeddingConfigured: Boolean(
      process.env.GEMINI_EMBEDDING_KEY_A ||
      process.env.GEMINI_EMBEDDING_KEY_B ||
      process.env.GEMINI_API_KEY ||
      process.env.GEMINI_API_KEY_A ||
      process.env.GEMINI_API_KEY_B
    ),
    tasks: taskStages,
    env: {
      OPENROUTER_MODEL_GENERATE_PRIMARY: process.env.OPENROUTER_MODEL_GENERATE_PRIMARY || 'qwen/qwen3.6-plus-preview:free',
      OPENROUTER_MODEL_GENERATE_SECONDARY: process.env.OPENROUTER_MODEL_GENERATE_SECONDARY || 'nvidia/nemotron-3-super-120b-a12b:free',
      OPENROUTER_MODEL_REPAIR_PRIMARY: process.env.OPENROUTER_MODEL_REPAIR_PRIMARY || 'nvidia/nemotron-3-nano-30b-a3b:free',
      OPENROUTER_MODEL_REPAIR_SECONDARY: process.env.OPENROUTER_MODEL_REPAIR_SECONDARY || 'arcee-ai/trinity-large-preview:free',
      OPENROUTER_MODEL_EXPLAIN_PRIMARY: process.env.OPENROUTER_MODEL_EXPLAIN_PRIMARY || 'qwen/qwen3.6-plus-preview:free',
      OPENROUTER_MODEL_EXPLAIN_SECONDARY: process.env.OPENROUTER_MODEL_EXPLAIN_SECONDARY || 'nvidia/nemotron-3-super-120b-a12b:free',
      OPENROUTER_RPM: process.env.OPENROUTER_RPM || '5',
      BLUEPRINT_GENERATION_CONCURRENCY: process.env.BLUEPRINT_GENERATION_CONCURRENCY || '4',
      BLUEPRINT_GENERATION_CONCURRENCY_EFFECTIVE: String(getEffectiveBlueprintGenerationConcurrency()),
      GEMINI_MODEL_FALLBACK: process.env.GEMINI_MODEL_FALLBACK || 'gemini-3.1-flash-lite-preview',
      GEMINI_MODEL_FALLBACK_COMPAT: process.env.GEMINI_MODEL_FALLBACK_COMPAT || '',
      GEMINI_EMBEDDING_MODEL_PRIMARY: process.env.GEMINI_EMBEDDING_MODEL_PRIMARY || process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001',
      GEMINI_EMBEDDING_MODEL_SECONDARY: process.env.GEMINI_EMBEDDING_MODEL_SECONDARY || '',
      EMBEDDING_BACKFILL_BATCH_SIZE: process.env.EMBEDDING_BACKFILL_BATCH_SIZE || '24',
      EMBEDDING_BATCH_MAX_ITEMS: process.env.EMBEDDING_BATCH_MAX_ITEMS || '6',
      EMBEDDING_BATCH_MAX_CHARS: process.env.EMBEDDING_BATCH_MAX_CHARS || '24000'
    }
  };
}

function buildLlmHealthPrompt(task, stage) {
  return `Return JSON only.
{
  "ok": true,
  "task": "${task}",
  "stage": "${stage.name}",
  "provider": "${stage.provider}",
  "model": "${stage.model}"
}`;
}

function validateLlmHealthResponse(value) {
  if (!value || typeof value !== 'object') return ['health_payload_invalid'];
  if (value.ok !== true) return ['health_ok_false'];
  return [];
}

async function probeLlmStage(task, stage) {
  const prompt = buildLlmHealthPrompt(task, stage);
  const startedAt = Date.now();

  try {
    let response;

    if (stage.provider === 'openrouter') {
      response = await callOpenRouter({
        prompt,
        model: stage.model,
        maxTokens: 256,
        temperature: 0
      });
    } else {
      response = await callGeminiText({
        prompt,
        model: stage.model,
        apiKey: stage.apiKey,
        maxTokens: 256,
        temperature: 0
      });
    }

    const parsed = JSON.parse(String(response.text || '').replace(/```json/gi, '').replace(/```/g, '').trim());
    const validationErrors = validateLlmHealthResponse(parsed);
    if (validationErrors.length > 0) {
      throw new Error(`Invalid health payload: ${validationErrors.join(', ')}`);
    }

    return {
      task,
      name: stage.name,
      provider: stage.provider,
      model: stage.model,
      ok: true,
      latencyMs: Date.now() - startedAt
    };
  } catch (error) {
    return {
      task,
      name: stage.name,
      provider: stage.provider,
      model: stage.model,
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: error.message,
      status: error.status || null,
      retryable: Boolean(error.retryable)
    };
  }
}

// ============ V2 Endpoints (Pool Architectre) ============

// ============ Admin LLM Diagnostics ============

app.get('/api/admin/llm-config', async (req, res) => {
  if (!isAuthorizedAdminRequest(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  return res.json({
    ok: true,
    config: getLlmConfigSnapshot()
  });
});

app.post('/api/admin/llm-healthcheck', async (req, res) => {
  if (!isAuthorizedAdminRequest(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const requestedTasks = Array.isArray(req.body?.tasks) ? req.body.tasks : ['generate', 'repair', 'explain'];
  const tasks = requestedTasks
    .map((task) => String(task || '').trim().toLowerCase())
    .filter((task, index, values) => ['generate', 'repair', 'explain'].includes(task) && values.indexOf(task) === index);

  const results = [];

  for (const task of tasks) {
    const stages = buildProviderStages(task).slice(0, 4);
    for (const stage of stages) {
      results.push(await probeLlmStage(task, stage));
    }
  }

  return res.json({
    ok: true,
    checkedAt: new Date().toISOString(),
    summary: {
      total: results.length,
      passed: results.filter((item) => item.ok).length,
      failed: results.filter((item) => !item.ok).length
    },
    results
  });
});

// ============ Admin Warmup Endpoint ============

/**
 * GET /api/admin/warmup - Pre-fill pool buckets (for cron/admin use)
 * Authentication: x-warmup-secret header OR ?secret= query param
 * Params: exam_id, level, mode, date_ymd, target, max_buckets, max_gen
 */
app.get(['/api/admin/warmup', '/api/admin/warmup/:levelParam/:modeParam'], async (req, res) => {
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
    const examId = req.query.exam_id || 'jlpt_n2';
    const level = req.params.levelParam?.toUpperCase() || req.query.level || 'N2';

    let modeToUse = req.params.modeParam?.toLowerCase() || req.query.mode || 'standard';
    let targetPerBucket = parseInt(req.query.target) || 5;
    let maxBuckets = parseInt(req.query.max_buckets) || 20;

    // Special handling for Vercel cron path without query strings
    if (modeToUse === 'basic_target3') {
      modeToUse = 'basic';
      targetPerBucket = 3;
      maxBuckets = 10;
    }

    const mode = modeToUse;
    const dateYmd = req.query.date_ymd || new Date().toISOString().split('T')[0];
    const maxGenerateTotal = parseInt(req.query.max_gen) || 20;

    // Load real exam spec from file (includes listening/reading)
    let examSpec;
    try {
      const specPath = path.join(__dirname, '../web/public/exams', `${examId}.json`);
      const raw = await fs.readFile(specPath, 'utf-8');
      examSpec = JSON.parse(raw);
      examSpec.level = level; // Override level from param
    } catch (specErr) {
      console.warn(`[Warmup] Could not load ${examId}.json, using fallback spec`);
      examSpec = {
        exam_id: examId, level, language: 'ja-JP',
        display_name_vi: `JLPT ${level}`, modes: DEFAULT_MODES,
        groups: [{
          group_id: 'vocab', title_vi: 'Từ vựng',
          mondai: [{ mondai_id: 'M1', title_vi: 'Hán tự', count_official: 5, types: ['kanji_reading'] }]
        }]
      };
    }

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
    if (isTemporaryUnavailableError(err)) {
      return res.status(503).json(getTemporaryUnavailablePayload(err));
    }
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/admin/warm-pool - Enhanced warm with round-robin + concurrency limiter
 * Authentication: x-warmup-secret header
 * Body: { exam_id?, level?, mode?, date_ymd?, targetPerBucket?, maxBuckets?, maxConcurrency? }
 */
app.post('/api/admin/warm-pool', async (req, res) => {
  const startTime = Date.now();

  // Authenticate via secret header
  const secret = req.headers['x-warmup-secret'];
  const expectedSecret = process.env.WARMUP_SECRET;
  if (!expectedSecret || secret !== expectedSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    if (!(await db.initDb())) {
      return res.status(503).json({ error: 'DB unavailable' });
    }

    const {
      exam_id = 'jlpt_n2',
      level = 'N2',
      mode = 'standard',
      date_ymd = new Date().toISOString().split('T')[0],
      targetPerBucket = 5,
      maxBuckets = 20,
      maxConcurrency = 2
    } = req.body || {};

    // Load real exam spec from file
    let examSpec;
    try {
      const specPath = path.join(__dirname, '../web/public/exams', `${exam_id}.json`);
      const raw = await fs.readFile(specPath, 'utf-8');
      examSpec = JSON.parse(raw);
      examSpec.level = level;
    } catch (specErr) {
      return res.status(400).json({ error: `Exam spec ${exam_id}.json not found` });
    }

    if (!examSpec.modes) examSpec.modes = DEFAULT_MODES;

    console.log(`[WarmPool] Starting for ${exam_id} ${level} ${mode} on ${date_ymd} (target=${targetPerBucket}, maxBuckets=${maxBuckets}, concurrency=${maxConcurrency})`);

    const snapshotId = await ensurePoolSnapshot(examSpec, level, date_ymd, 'warmup', mode);
    if (!snapshotId) {
      return res.status(500).json({ error: 'Failed to create snapshot' });
    }

    // Build round-robin bucket list across all groups
    const groupBuckets = examSpec.groups.map(group => {
      return group.mondai.filter(m => m.types?.[0]).map(mondaiDef => ({
        group, mondaiDef,
        bucketKey: getBucketKey(group.group_id, mondaiDef.mondai_id, mondaiDef.types[0])
      }));
    });

    // Interleave buckets: take 1 from each group in turn
    const interleaved = [];
    let maxLen = Math.max(...groupBuckets.map(g => g.length));
    for (let i = 0; i < maxLen; i++) {
      for (const gb of groupBuckets) {
        if (i < gb.length) interleaved.push(gb[i]);
      }
    }

    // Simple concurrency limiter
    let running = 0;
    let bucketsProcessed = 0;
    let generatedCount = 0;
    let skipped = 0;

    const warmBucket = async (bucket) => {
      const { group, mondaiDef, bucketKey } = bucket;

      const countRes = await db.query(
        'SELECT COUNT(*) FROM pool_snapshot_items WHERE snapshot_id=$1 AND bucket_key=$2',
        [snapshotId, bucketKey]
      );
      const current = parseInt(countRes.rows[0]?.count || 0);

      if (current >= targetPerBucket) {
        skipped++;
        return;
      }

      const needed = Math.min(targetPerBucket - current, 3); // Cap per-bucket batch
      if (needed <= 0) { skipped++; return; }

      console.log(`[WarmPool] Filling ${bucketKey}: ${current} -> ${current + needed}`);

      try {
        await generateMondaiForBucket({
          examSpec, level, mode, group, mondaiDef, bucketKey, snapshotId,
          count: needed, plan: 'warmup'
        });
        generatedCount += needed;
      } catch (e) {
        console.error(`[WarmPool] Error generating for ${bucketKey}:`, e?.message || e);
        if (isTemporaryUnavailableError(e)) {
          throw e;
        }
      }
      bucketsProcessed++;
    };

    // Process with concurrency limit
    const bucketsToProcess = interleaved.slice(0, maxBuckets);
    const semaphore = { active: 0, queue: [] };

    const acquire = () => new Promise(resolve => {
      if (semaphore.active < maxConcurrency) {
        semaphore.active++;
        resolve();
      } else {
        semaphore.queue.push(resolve);
      }
    });

    const release = () => {
      semaphore.active--;
      if (semaphore.queue.length > 0) {
        semaphore.active++;
        semaphore.queue.shift()();
      }
    };

    await Promise.all(bucketsToProcess.map(async (bucket) => {
      await acquire();
      try { await warmBucket(bucket); }
      finally { release(); }
    }));

    const durationMs = Date.now() - startTime;
    console.log(`[WarmPool] Complete: ${bucketsProcessed} buckets, ${generatedCount} generated, ${skipped} skipped in ${durationMs}ms`);

    res.json({
      snapshotId,
      date_ymd,
      bucketsProcessed,
      generatedCount,
      skipped,
      durationMs
    });

  } catch (err) {
    console.error('[WarmPool] Error:', err);
    if (isTemporaryUnavailableError(err)) {
      return res.status(503).json(getTemporaryUnavailablePayload(err));
    }
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET|POST /api/admin/embeddings/backfill - Backfill missing embeddings in controlled batches
 * Authentication: x-warmup-secret header OR ?secret= query param
 * Params/Body: batch_size?, max_batches?, max_items_per_request?, max_chars_per_request?
 */
async function handleEmbeddingBackfillRequest(req, res) {
  const secret = req.headers['x-warmup-secret'] || req.query.secret || req.body?.secret;
  const expectedSecret = process.env.WARMUP_SECRET;
  if (!expectedSecret || secret !== expectedSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    if (!(await db.initDb())) {
      return res.status(503).json({ error: 'DB unavailable' });
    }

    const batchSize = Math.max(
      1,
      parseInt(req.body?.batch_size || req.body?.batchSize || req.query.batch_size || req.query.batchSize) || 24
    );
    const maxBatches = Math.max(
      1,
      parseInt(req.body?.max_batches || req.body?.maxBatches || req.query.max_batches || req.query.maxBatches) || 1
    );
    const maxItemsPerRequest = Math.max(
      1,
      parseInt(
        req.body?.max_items_per_request ||
        req.body?.maxItemsPerRequest ||
        req.query.max_items_per_request ||
        req.query.maxItemsPerRequest
      ) || 6
    );
    const maxCharsPerRequest = Math.max(
      1000,
      parseInt(
        req.body?.max_chars_per_request ||
        req.body?.maxCharsPerRequest ||
        req.query.max_chars_per_request ||
        req.query.maxCharsPerRequest
      ) || 24000
    );

    let batchesRun = 0;
    let selected = 0;
    let processed = 0;
    let remaining = null;
    let lastStats = null;

    for (let index = 0; index < maxBatches; index += 1) {
      const stats = await runEmbeddingBackfill(db, {
        batchSize,
        maxItemsPerRequest,
        maxCharsPerRequest
      });
      lastStats = stats;
      batchesRun += 1;
      selected += stats.selected || 0;
      processed += stats.processed || 0;
      remaining = stats.remaining;

      if ((stats.selected || 0) === 0) break;
      if (typeof stats.remaining === 'number' && stats.remaining <= 0) break;
    }

    return res.json({
      ok: true,
      batchesRun,
      batchSize,
      maxBatches,
      maxItemsPerRequest,
      maxCharsPerRequest,
      selected,
      processed,
      remaining,
      skipped: lastStats?.skipped || null
    });
  } catch (error) {
    console.error('[EmbeddingBackfill] Error:', error);
    return res.status(500).json({ error: error.message });
  }
}

app.get('/api/admin/embeddings/backfill', handleEmbeddingBackfillRequest);
app.post('/api/admin/embeddings/backfill', handleEmbeddingBackfillRequest);

/**
 * POST /api/admin/cleanup - Remove old pool snapshots and items
 * Authentication: x-warmup-secret header
 * Body: { keepDays?: number } (default 14)
 */
app.post('/api/admin/cleanup', async (req, res) => {
  const secret = req.headers['x-warmup-secret'];
  const expectedSecret = process.env.WARMUP_SECRET;
  if (!expectedSecret || secret !== expectedSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    if (!(await db.initDb())) {
      return res.status(503).json({ error: 'DB unavailable' });
    }

    const keepDays = Math.max(1, parseInt(req.body?.keepDays) || 14);
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - keepDays);
    const cutoffYmd = cutoffDate.toISOString().split('T')[0];

    console.log(`[Cleanup] Removing pool data older than ${cutoffYmd} (${keepDays} days)`);

    // Delete items linked to old snapshots first (FK safety)
    const itemsRes = await db.query(
      `DELETE FROM pool_snapshot_items WHERE snapshot_id IN (
        SELECT id FROM pool_snapshots WHERE date_ymd < $1
      )`, [cutoffYmd]
    );

    // Delete the old snapshots
    const snapsRes = await db.query(
      'DELETE FROM pool_snapshots WHERE date_ymd < $1', [cutoffYmd]
    );

    const result = {
      deletedSnapshots: snapsRes.rowCount || 0,
      deletedItems: itemsRes.rowCount || 0,
      cutoffDate: cutoffYmd,
      keepDays
    };

    console.log(`[Cleanup] Done: ${result.deletedSnapshots} snapshots, ${result.deletedItems} items removed`);
    res.json(result);

  } catch (err) {
    console.error('[Cleanup] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Helper: Attach stable slot metadata to delivered mondai
 */
function attachSlotMetaToMondai(content, slot, groupId, slotIndex) {
  const cloned = JSON.parse(JSON.stringify(content || {}));
  const slotId = slot?.slot_id || buildBlueprintSlotId(groupId, cloned?.mondai_id || 'M', slotIndex);
  const expectedMondaiId = slot?.mondai_id || cloned?.mondai_id || null;
  cloned.slot_id = slotId;
  cloned.slot_index = slotIndex;
  cloned.group_id = groupId;

  if (!cloned.meta || typeof cloned.meta !== 'object') {
    cloned.meta = {};
  }

  if (expectedMondaiId && cloned.mondai_id !== expectedMondaiId) {
    cloned.meta.generated_mondai_id = cloned.mondai_id || null;
    cloned.mondai_id = expectedMondaiId;
  }

  canonicalizeMondaiQuestionIds(cloned, { mondaiId: expectedMondaiId || cloned.mondai_id });

  cloned.meta.slot_id = slotId;
  cloned.meta.group_id = groupId;
  cloned.meta.expected_mondai_id = expectedMondaiId;
  cloned.meta.delivery_mode = slot?.delivery_mode || 'flexible';

  return cloned;
}

/**
 * Helper: Deliver next chunk for an instance
 */
async function deliverNextChunk(instanceKey, want) {
  await db.query('BEGIN');
  try {
    // Load instance + blueprint using FOR UPDATE to prevent race conditions
    const inst = await db.query(
      'SELECT blueprint, delivery_state FROM exam_instances_cache WHERE instance_key=$1 FOR UPDATE',
      [instanceKey]
    );

    if (inst.rows.length === 0) {
      await db.query('ROLLBACK');
      throw new Error('Instance not found');
    }

    const blueprint = parseJsonb(inst.rows[0].blueprint);
    const deliveryState = parseJsonb(inst.rows[0].delivery_state, {});

    const cursorBefore = deliveryState.cursors?.[want.group_id] || 0;
    const reqId = Date.now() + '_' + Math.random().toString(36).substr(2, 4);
    console.log(`[ChunkReq ${reqId}] Start: ${instanceKey} group=${want.group_id} cursor=${cursorBefore}`);

    // Find requested group
    const groupIdx = blueprint.groups.findIndex(g => g.group_id === want.group_id);
    if (groupIdx === -1) {
      await db.query('ROLLBACK');
      throw new Error('Group not found in blueprint');
    }

    const group = blueprint.groups[groupIdx];
    let cursor = deliveryState.cursors?.[want.group_id] || 0;

    // Determine which slots we'll try to deliver (for batch fetch)
    const slotsToConsider = [];
    let tempCursor = cursor;
    while (tempCursor < group.mondai_slots.length && slotsToConsider.length < want.want_count) {
      slotsToConsider.push({ slot: group.mondai_slots[tempCursor], idx: tempCursor });
      tempCursor++;
      if (group.mondai_slots[tempCursor - 1]?.delivery_mode === 'whole') break;
    }

    // Batch fetch all hashes in one query
    const hashesToFetch = slotsToConsider.map(s => s.slot.mondai_hash);
    const contentMap = {};
    if (hashesToFetch.length > 0) {
      const batchRes = await db.query(
        'SELECT hash, content FROM mondai_bank WHERE hash = ANY($1)',
        [hashesToFetch]
      );
      batchRes.rows.forEach(r => { contentMap[r.hash] = parseJsonb(r.content); });
    }

    const mondaiToDeliver = [];
    let blueprintModified = false;

    for (const { slot, idx } of slotsToConsider) {
      let content = contentMap[slot.mondai_hash] || null;

      if (!content) {
        // SAFETY NET: Content missing from bank (data inconsistency)
        console.warn(`[Chunk] Missing content for hash ${slot.mondai_hash}. Attempting repair...`);
        try {
          const snapRes = await db.query(
            'SELECT snapshot_id, bucket_key FROM pool_snapshot_items WHERE mondai_hash=$1 LIMIT 1',
            [slot.mondai_hash]
          );

          if (snapRes.rows.length > 0) {
            const { snapshot_id, bucket_key } = snapRes.rows[0];
            const newHash = await sampleMondaiFromBucket(snapshot_id, bucket_key, Math.random, [slot.mondai_hash]);
            const mRes2 = await db.query('SELECT content FROM mondai_bank WHERE hash=$1', [newHash]);
            if (mRes2.rows.length > 0) {
              content = parseJsonb(mRes2.rows[0].content);
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
        mondaiToDeliver.push(attachSlotMetaToMondai(content, slot, group.group_id, idx));
      }
      cursor = idx + 1;
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

    await db.query('COMMIT');

    const resultMondaiIds = mondaiToDeliver.map(m => m.mondai_id);
    console.log(`[ChunkReq ${reqId}] End: cursor ${cursorBefore} -> ${cursor}. Returned ${resultMondaiIds.length} items: ${resultMondaiIds.join(', ')}`);

    return {
      mondai: mondaiToDeliver,
      nextCursor: cursor,
      done: cursor >= group.mondai_slots.length
    };
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

// POST /api/exam/start
app.post('/api/exam/start', authMiddleware, async (req, res) => {
  try {
    const {
      examSpec,
      mode,
      setNo,
      force_new,
      resume,
      daily,
      allow_repeat,
      allowRepeat,
      force_retake,
      forceRetake
    } = req.body;
    const userId = req.user.userId;

    if (!(await db.initDb())) {
      return res.status(503).json({ error: 'DB unavailable for V2' });
    }

    if (isDemoUserId(userId)) {
      await cleanupExpiredDemoArtifacts();
    }

    const user = await loadUserData(userId, req.user.email);
    const plan = user.plan || 'free';
    const level = examSpec.level || examSpec.default_level;
    const repeatAllowed = !!(allow_repeat ?? allowRepeat ?? false);
    const explicitRetake = !!(force_retake ?? forceRetake ?? false);

    if (!examSpec.modes) examSpec.modes = DEFAULT_MODES;

    let finalSetNo = setNo;
    let forceCreateNew = !!force_new || explicitRetake;

    if (!explicitRetake && resume) {
      const latestRes = await db.query(
        `SELECT set_no FROM exam_instances_cache
         WHERE user_id=$1 AND exam_id=$2 AND level=$3 AND mode=$4 AND expires_at > NOW()
         ORDER BY created_at DESC LIMIT 1`,
        [userId, examSpec.exam_id, level, mode]
      );
      if (latestRes.rows.length > 0) {
        finalSetNo = latestRes.rows[0].set_no;
        console.log(`[Exam] Resume: using set_no ${finalSetNo}`);
      }
    }

    if (finalSetNo === undefined && daily) {
      const today = new Date().toISOString().split('T')[0];
      const hash = crypto.createHash('sha256')
        .update(`${userId}-${level}-${mode}-${today}`)
        .digest('hex');
      finalSetNo = parseInt(hash.substring(0, 8), 16) % 100;
      console.log(`[Exam] Daily mode: set_no ${finalSetNo}`);
    }

    if (finalSetNo === undefined) {
      forceCreateNew = true;
    }

    let instanceKey;
    let blueprint;

    const fetchExisting = async (sn) => {
      const result = await db.query(
        'SELECT instance_key, blueprint FROM exam_instances_cache WHERE user_id=$1 AND exam_id=$2 AND level=$3 AND mode=$4 AND set_no=$5',
        [userId, examSpec.exam_id, level, mode, sn]
      );
      return result.rows[0];
    };

    if (forceCreateNew) {
      const MAX_ATTEMPTS = 5;
      let created = false;

      for (let attempt = 0; attempt < MAX_ATTEMPTS && !created; attempt++) {
        const maxRes = await db.query(
          'SELECT COALESCE(MAX(set_no), 0) + 1 AS next_set FROM exam_instances_cache WHERE user_id=$1 AND exam_id=$2 AND level=$3 AND mode=$4',
          [userId, examSpec.exam_id, level, mode]
        );
        finalSetNo = maxRes.rows[0].next_set;
        console.log(`[Exam] New set_no: ${finalSetNo} (attempt ${attempt + 1})`);

        const today = new Date().toISOString().split('T')[0];
        const snapshotId = await ensurePoolSnapshot(examSpec, level, today, plan, mode);
        const seed = crypto.randomUUID();
        const newBlueprint = await buildExamBlueprint(
          examSpec,
          level,
          mode,
          seed,
          finalSetNo,
          plan,
          snapshotId,
          { userId, allowRepeat: repeatAllowed || explicitRetake }
        );
        const newInstanceKey = crypto.randomUUID();

        try {
          await db.query(`
            INSERT INTO exam_instances_cache
            (instance_key, user_id, exam_id, level, mode, plan, seed, set_no, blueprint, delivery_state, answer_keys)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          `, [
            newInstanceKey, userId, examSpec.exam_id, level, mode, plan, seed, finalSetNo,
            JSON.stringify(newBlueprint),
            JSON.stringify({ cursors: {} }),
            JSON.stringify({})
          ]);

          await recordServedMondaiHistory(db, {
            userId,
            instanceKey: newInstanceKey,
            blueprint: newBlueprint
          });

          instanceKey = newInstanceKey;
          blueprint = newBlueprint;
          created = true;
          console.log(`[Exam] Created new instance ${instanceKey.substring(0, 8)}... set_no=${finalSetNo}`);
        } catch (e) {
          if (e.code === '23505' && attempt < MAX_ATTEMPTS - 1) {
            console.log(`[Exam] Conflict on set_no ${finalSetNo}, retrying (attempt ${attempt + 1})...`);
            continue;
          }
          throw e;
        }
      }

      if (!created) throw new Error('Failed to create exam instance after max retries');
    } else {
      const existingRow = await fetchExisting(finalSetNo);

      if (existingRow) {
        console.log(`[Exam] Reusing existing instance for user ${userId}, set ${finalSetNo}`);
        instanceKey = existingRow.instance_key;
        blueprint = parseJsonb(existingRow.blueprint);

        await db.query(`
          UPDATE exam_instances_cache
          SET expires_at = (CURRENT_TIMESTAMP + INTERVAL '3 days'),
              delivery_state = $2
          WHERE instance_key = $1
        `, [instanceKey, JSON.stringify({ cursors: {} })]);
      } else {
        const today = new Date().toISOString().split('T')[0];
        const snapshotId = await ensurePoolSnapshot(examSpec, level, today, plan, mode);
        const seed = crypto.randomUUID();
        const newBlueprint = await buildExamBlueprint(
          examSpec,
          level,
          mode,
          seed,
          finalSetNo,
          plan,
          snapshotId,
          { userId, allowRepeat: repeatAllowed || explicitRetake }
        );
        const newInstanceKey = crypto.randomUUID();

        try {
          await db.query(`
            INSERT INTO exam_instances_cache
            (instance_key, user_id, exam_id, level, mode, plan, seed, set_no, blueprint, delivery_state, answer_keys)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          `, [
            newInstanceKey, userId, examSpec.exam_id, level, mode, plan, seed, finalSetNo,
            JSON.stringify(newBlueprint),
            JSON.stringify({ cursors: {} }),
            JSON.stringify({})
          ]);

          await recordServedMondaiHistory(db, {
            userId,
            instanceKey: newInstanceKey,
            blueprint: newBlueprint
          });

          instanceKey = newInstanceKey;
          blueprint = newBlueprint;
        } catch (e) {
          if (e.code === '23505') {
            const winnerRow = await fetchExisting(finalSetNo);
            if (winnerRow) {
              instanceKey = winnerRow.instance_key;
              blueprint = parseJsonb(winnerRow.blueprint);
              await db.query(
                'UPDATE exam_instances_cache SET delivery_state = $2 WHERE instance_key = $1',
                [instanceKey, JSON.stringify({ cursors: {} })]
              );
            } else {
              throw e;
            }
          } else {
            throw e;
          }
        }
      }
    }

    if (!blueprint?.groups?.[0]) {
      throw new Error('Failed to build exam blueprint');
    }

    await abandonOtherActiveAttempts(userId, instanceKey);
    await ensureActiveAttempt(userId, instanceKey);

    const firstGroup = blueprint.groups[0];
    const firstChunk = await deliverNextChunk(instanceKey, {
      group_id: firstGroup.group_id,
      want_count: 2
    });

    res.json({
      instanceKey,
      manifest: {
        groups: blueprint.groups.map((group) => ({
          group_id: group.group_id,
          title_vi: group.title_vi,
          expected_mondai_count: group.mondai_slots.length,
          slot_order: group.mondai_slots.map((slot) => slot.slot_id)
        }))
      },
      mondai: sanitizeMondaiForClient({ mondai: firstChunk.mondai }).mondai
    });
  } catch (err) {
    console.error('Start exam V2 error:', err);
    if (isTemporaryUnavailableError(err)) {
      return res.status(503).json(getTemporaryUnavailablePayload(err));
    }
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/exam/abandon
app.post('/api/exam/abandon', authMiddleware, async (req, res) => {
  try {
    const { instanceKey } = req.body || {};

    if (!instanceKey) {
      return res.status(400).json({ error: 'instanceKey is required' });
    }

    if (!(await db.initDb())) {
      return res.status(503).json({ error: 'DB unavailable for abandon' });
    }

    const result = await abandonAttempt(req.user.userId, instanceKey);
    res.json({ success: true, abandoned: result.rowCount || 0 });
  } catch (err) {
    console.error('Abandon exam error:', err);
    res.status(500).json({ error: err.message });
  }
});
// POST /api/exam/chunk
app.post('/api/exam/chunk', authMiddleware, async (req, res) => {
  try {
    const { instanceKey, want } = req.body;

    if (!instanceKey || !want?.group_id) {
      return res.status(400).json({ error: 'instanceKey and want.group_id are required' });
    }

    // Wait for DB initialization
    if (!(await db.initDb())) {
      return res.status(503).json({ error: 'DB unavailable' });
    }

    const access = await getExamInstanceAccess(req.user.userId, instanceKey);
    if (!access.ok) {
      return res.status(access.status).json({ error: access.error });
    }
    if (access.attemptStatus && access.attemptStatus !== 'active') {
      return res.status(409).json({ error: 'Exam session has ended' });
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

    const access = await getExamInstanceAccess(req.user.userId, instanceKey);
    if (!access.ok) {
      return res.status(access.status).json({ error: access.error });
    }
    if (access.attemptStatus && access.attemptStatus !== 'active') {
      return res.status(409).json({ error: 'Exam session has ended' });
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
      canonicalizeMondaiQuestionIds(m, { mondaiId: m?.mondai_id });
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
        // Return full info for UI highlighting
        byQuestion[qId] = {
          is_correct: isCorrect,
          user_index: userAns,
          correct_index: correct
        };
      }
    }

    // Update attempts (fallback for missing UNIQUE constraint)
    const summaryJson = JSON.stringify({ correct: correctCount, total: totalCount });
    const updateRes = await db.query(`
      UPDATE attempts 
      SET status='submitted', summary=$3, submitted_at=NOW()
      WHERE user_id=$1 AND instance_key=$2
    `, [req.user.userId, instanceKey, summaryJson]);

    if (updateRes.rowCount === 0) {
      try {
        await db.query(`
          INSERT INTO attempts (user_id, instance_key, status, summary, submitted_at)
          VALUES ($1, $2, 'submitted', $3, NOW())
        `, [req.user.userId, instanceKey, summaryJson]);
      } catch (insertErr) {
        // Ignore duplicate key errors if a race condition happened
      }
    }

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

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API endpoint not found' });
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
























