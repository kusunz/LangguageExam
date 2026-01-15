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
const { createClient } = require('@deepgram/sdk');
const DEFAULT_GEMINI_MODEL = process.env.DEFAULT_GEMINI_MODEL || 'gemini-3-pro-preview';

// Initialize Database
let IS_DB_AVAILABLE = false;
db.initDb().then(success => {
  IS_DB_AVAILABLE = success;
  if (!success) console.log('⚠️ Running with File System storage fallback');
}).catch(console.error);

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy for Vercel/Cloud deployments (enables correct IP detection for rate limiting)
app.set('trust proxy', 1);

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../web')));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

// Data directory
// Data directory (Legacy/Local usage only - skipped for cloud)
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdir(DATA_DIR, { recursive: true }).catch(() => { });

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
  // If DB is NOT available, use File System (even for demo user to support testing)
  if (!IS_DB_AVAILABLE) {
    const filePath = path.join(DATA_DIR, `${userId}.json`);
    try {
      const content = await fs.readFile(filePath, 'utf8');
      return JSON.parse(content);
    } catch (e) {
      // Return default if file doesn't exist
      return {
        history: [],
        mistakeBook: [],
        weakTags: [],
        nickname: userId === 'demo-user' ? 'Demo User' : null,
        settings: {}
      };
    }
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
    const res = await db.pool.query('SELECT * FROM users WHERE id = $1', [userId]);

    if (res.rows.length === 0) {
      // Create new user if not exists
      const initialData = { history: [], mistakeBook: {}, weakTags: [], settings: {} };
      await db.pool.query(
        'INSERT INTO users (id, email, data) VALUES ($1, $2, $3)',
        [userId, email || '', JSON.stringify(initialData)]
      );
      return { ...initialData, nickname: null }; // Force nickname prompt
    }

    const { data, nickname } = res.rows[0];
    return { ...data, nickname };
  } catch (err) {
    console.error('DB load error:', err);
    throw err;
  }
}

async function saveUserData(userId, data) {
  // Fallback to File System if DB unavailable
  if (!IS_DB_AVAILABLE) {
    const filePath = path.join(DATA_DIR, `${userId}.json`);
    await fs.writeFile(filePath, JSON.stringify(data, null, 2));
    return;
  }

  if (IS_DEMO_MODE || userId === 'demo-user') return;

  // Filter out heavy objects like ttsCache to prevent DB bloat
  const { nickname, ttsCache, ...jsonData } = data;

  if (nickname) {
    await db.pool.query(
      'UPDATE users SET data = $1, nickname = $2 WHERE id = $3',
      [JSON.stringify(jsonData), nickname, userId]
    );
  } else {
    await db.pool.query(
      'UPDATE users SET data = $1 WHERE id = $2',
      [JSON.stringify(jsonData), userId]
    );
  }
}

// Helper: Manage Sessions
async function manageSession(userId, existingSessionId) {
  // 1. Clean up expired sessions
  await db.pool.query('DELETE FROM sessions WHERE expires_at < NOW()');

  // 2. Check if existing session is valid (must be a valid UUID)
  const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(existingSessionId);

  if (existingSessionId && isUUID) {
    const res = await db.pool.query('SELECT id FROM sessions WHERE id = $1 AND user_id = $2', [existingSessionId, userId]);
    if (res.rows.length > 0) {
      // Refresh expiry (extend by 7 days)
      await db.pool.query("UPDATE sessions SET expires_at = NOW() + INTERVAL '7 days' WHERE id = $1", [existingSessionId]);
      return existingSessionId;
    }
  }

  // 3. Create new session (Enforce limit 3)
  const countRes = await db.pool.query('SELECT COUNT(*) FROM sessions WHERE user_id = $1', [userId]);
  const count = parseInt(countRes.rows[0].count);

  if (count >= 3) {
    // Delete oldest session
    await db.pool.query(`
      DELETE FROM sessions WHERE id IN (
        SELECT id FROM sessions WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1
      )
    `, [userId]);
  }

  // Create new session
  const newSessionRes = await db.pool.query(`
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

    // Manage Session
    const activeSessionId = await manageSession(req.user.userId, sessionId);

    // Load Data
    const data = await loadUserData(req.user.userId, req.user.email);

    // Update last login
    await db.pool.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [req.user.userId]);

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
    await db.pool.query(
      `INSERT INTO questions (hash, content, keywords) 
       VALUES ($1, $2, $3) 
       ON CONFLICT (hash) DO NOTHING`,
      [hash, JSON.stringify(question), JSON.stringify(question.tags || [])]
    );

    if (action === 'remove') {
      await db.pool.query(
        'DELETE FROM user_notebook WHERE user_id = $1 AND question_hash = $2',
        [userId, hash]
      );
    } else {
      // Upsert notebook entry
      await db.pool.query(
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

    const result = await db.pool.query(`
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
          db.pool.query(
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
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;

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

  const data = await response.json();

  if (!data.candidates || !data.candidates[0]?.content?.parts?.[0]?.text) {
    throw new Error(`Gemini returned empty response from ${model}`);
  }

  let text = data.candidates[0].content.parts[0].text;
  log('INFO', `Gemini ${model} success`, { responseLength: text.length });

  // Try to parse JSON, with repair for truncated responses
  try {
    return JSON.parse(text);
  } catch (parseErr) {
    log('WARN', `JSON parse failed, attempting repair...`, { error: parseErr.message });

    // Attempt to repair truncated JSON
    const repaired = repairTruncatedJSON(text);
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
    for (let ii = 0; ii < m.items.length; ii++) {
      const item = m.items[ii];
      const itemErrors = validateQuestionItem(item);
      if (itemErrors.length) errors.push(`mondai_${mi}_item_${ii}:${itemErrors.join(',')}`);
      if (item && typeof item.id === 'string') {
        if (ids.has(item.id)) errors.push(`duplicate_id:${item.id}`);
        ids.add(item.id);
      }
      const needsScript = item && item.media && Object.prototype.hasOwnProperty.call(item.media, 'script_text');
      if (needsScript && item.media.script_text !== null && typeof item.media.script_text !== 'string') {
        errors.push(`mondai_${mi}_item_${ii}:script_text_invalid`);
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

async function callGemini(prompt, options = {}) {
  const requested = options.model ? [options.model] : [];
  // Use Pro-only models if specified, otherwise use full list
  const baseModels = options.proOnly ? GEMINI_MODELS_PRO : GEMINI_MODELS;
  const models = [...requested, ...baseModels].filter((v, i, a) => a.indexOf(v) === i);
  let lastError = null;

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    try {
      return await callGeminiWithModel(prompt, model, options);
    } catch (err) {
      lastError = err;
      log('WARN', `Gemini ${model} failed`, {
        status: err.status,
        error: err.message.substring(0, 200)
      });

      // If it's an auth error (401), no point retrying
      if (err.status === 401) {
        throw err;
      }

      // For proOnly mode: only fallback on rate limit/quota (429/403) or model-not-found (400)
      // For other errors, stop and throw
      if (options.proOnly) {
        if (err.status === 429 || err.status === 403 || err.status === 400) {
          log('INFO', `Model issue (${err.status}) on Pro model, trying Flash fallback...`);
          // Add Flash models to try list if not already there
          if (i === models.length - 1) {
            const flashModels = GEMINI_MODELS.filter(m => m.includes('flash') && !models.includes(m));
            models.push(...flashModels);
          }
          continue;
        }
        // Other errors in proOnly mode: stop trying
        throw err;
      }

      // Standard mode: try all models for any error
      continue;
    }
  }

  // All models failed
  throw lastError || new Error('All Gemini models failed');
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
    const { examSpec, mode, groupIndex, chunkIndex, chunkSize = 3, previousMondai = [], provider, model } = req.body;
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

    log('INFO', `Generated mondai chunk ${chunkIndex + 1} for group ${groupIndex + 1}: ${validatedMondai.length} mondai`);
    res.json(response);
  } catch (err) {
    console.error('Generate mondai chunk error:', err);
    log('ERROR', 'Generate mondai chunk failed', { error: err.message, stack: err.stack?.substring(0, 500) });
    res.status(500).json({ error: 'Lỗi máy chủ. Vui lòng thử lại sau.' });
  }
});


app.post('/api/grade-test', authMiddleware, async (req, res) => {
  try {
    const { test, answers, provider } = req.body;
    const llmProvider = provider || process.env.DEFAULT_LLM_PROVIDER || 'gemini';

    const prompt = buildGradeTestPrompt(test, answers);

    let result;
    if (llmProvider === 'openai') {
      result = await callOpenAI([{ role: 'user', content: prompt }]);
    } else {
      result = await callGemini(prompt);
    }

    // Save to Exam Results Table (Robust storage)
    try {
      await db.pool.query(
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
    res.status(500).json({ error: 'Failed to prepare TTS text: ' + err.message });
  }
});

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

  // Current chunk mondai details
  const mondaiInfo = mondaiToGenerate.map((m, idx) => {
    const totalQuestions = Math.max(1, Math.round(m.count_official * questionScale));
    const isReading = m.types.some(t => readingTypes.includes(t));
    const mondaiNum = startMondaiIndex + idx + 1;

    if (isReading && totalQuestions > 2) {
      const passageCount = Math.min(2, Math.ceil(totalQuestions / 3));
      const questionsPerPassage = Math.ceil(totalQuestions / passageCount);
      return `  ${mondaiNum}. ${m.mondai_id} (${m.title_vi}): ${passageCount} passage(s), ${questionsPerPassage} questions each (total ${totalQuestions}), types: ${m.types.join(', ')}
    *** Create FEWER passages with MORE questions per passage ***`;
    }

    return `  ${mondaiNum}. ${m.mondai_id} (${m.title_vi}): ${totalQuestions} questions, types: ${m.types.join(', ')}`;
  }).join('\n');

  // Context from previously generated mondai (summarized)
  let contextInfo = '';
  if (previousMondai.length > 0) {
    const contextSummary = previousMondai.map(m => {
      const questionCount = m.items?.length || 0;
      const sampleTopics = m.items?.slice(0, 2).map(i => i.tags?.[0] || i.type).join(', ') || 'various';
      return `  - ${m.mondai_id}: ${questionCount} questions about ${sampleTopics}`;
    }).join('\n');
    contextInfo = `
PREVIOUSLY GENERATED MONDAI (maintain consistency, avoid repetition):
${contextSummary}
`;
  }

  return `You are generating a CHUNK of ${examSpec.display_name_vi} practice test questions.

EXAM: ${examSpec.display_name_vi}
LEVEL: ${examSpec.level}
LANGUAGE: ${examSpec.language}
MODE: ${mode} (question_scale: ${questionScale})

GROUP: ${group.group_id} (${group.title_vi})
CHUNK: Mondai ${startMondaiIndex + 1} to ${startMondaiIndex + mondaiToGenerate.length} of ${group.mondai.length}
${contextInfo}
GENERATE THESE MONDAI NOW:
${mondaiInfo}

CRITICAL RULES:
1. Generate 100% original questions - NO copy from real exams
2. Each question: exactly 4 choices, exactly 1 correct answer
3. Match ${examSpec.level} difficulty precisely
4. "choices" are full answer texts, NOT letters "A/B/C/D"
5. Include meaningful tags and brief explanations
6. For listening: include script_text for TTS
7. ${previousMondai.length > 0 ? 'AVOID repeating vocabulary/topics from previously generated mondai' : 'This is the first chunk - set a good foundation'}

OUTPUT: Return RAW JSON only (no markdown code blocks):
{
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
          "choices": ["<A text>", "<B text>", "<C text>", "<D text>"],
          "answer_index": 0,
          "explain_brief": "<brief explanation>",
          "tags": ["<tag1>", "<tag2>"],
          "media": { "script_text": "<for listening, null otherwise>" }
        }
      ]
    }
  ]
}

GENERATE JSON NOW:`;
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

// ============ Serve SPA ============

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../web/index.html'));
});

// Start server
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Language Exam Server running on http://localhost:${PORT}`);
    console.log(`Auth Mode: ${IS_DEMO_MODE ? 'DEMO MODE (no auth required)' : 'Privy (' + PRIVY_APP_ID + ')'}`);
  });
}

module.exports = app;
