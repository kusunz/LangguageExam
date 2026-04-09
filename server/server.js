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
  extractUniqueMondaiHashes,
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
const GENERATE_MAX_TOKENS = Math.max(
  4096,
  Number.parseInt(process.env.LLM_GENERATE_MAX_TOKENS || '16384', 10)
);

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

const DAILY_BANK_LEVELS = ['N5', 'N4', 'N3', 'N2', 'N1'];
const DAILY_BANK_MODES = ['basic', 'standard', 'official'];
const DAILY_BANK_RETENTION_DAYS = Math.max(
  30,
  Number.parseInt(process.env.DAILY_BANK_RETENTION_DAYS || '30', 10)
);
const DAILY_BANK_SET_COUNT = Math.max(
  5,
  Number.parseInt(process.env.DAILY_BANK_SET_COUNT || '5', 10)
);
const DAILY_BANK_TARGET_PER_BUCKET = Math.max(
  5,
  Number.parseInt(process.env.DAILY_BANK_TARGET_PER_BUCKET || '5', 10)
);
const DAILY_BANK_WARM_MAX_GENERATE_TOTAL = Math.max(
  DAILY_BANK_TARGET_PER_BUCKET * 17,
  Number.parseInt(process.env.DAILY_BANK_WARM_MAX_GENERATE_TOTAL || String(DAILY_BANK_TARGET_PER_BUCKET * 17), 10)
);
const DAILY_BANK_RUN_ON_STARTUP = String(process.env.DAILY_BANK_RUN_ON_STARTUP || '1') !== '0';
const DAILY_BANK_ENABLED = String(process.env.DAILY_BANK_ENABLED || '1') !== '0';
const DAILY_BANK_SCHEDULE_HOUR = Math.max(
  0,
  Math.min(23, Number.parseInt(process.env.DAILY_BANK_SCHEDULE_HOUR || '0', 10))
);
const DAILY_BANK_SCHEDULE_MINUTE = Math.max(
  0,
  Math.min(59, Number.parseInt(process.env.DAILY_BANK_SCHEDULE_MINUTE || '5', 10))
);

const DAILY_BANK_VARIANTS = [
  { key: 'full', title: 'Full Exam', mondaiIds: null },
  { key: 'vocab_grammar', title: 'Vocabulary & Grammar', mondaiIds: ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7'] },
  { key: 'vocab', title: 'Vocabulary', mondaiIds: ['M1', 'M2', 'M3', 'M4'] },
  { key: 'grammar', title: 'Grammar', mondaiIds: ['M5', 'M6', 'M7'] },
  { key: 'reading', title: 'Reading', mondaiIds: ['M8', 'M9', 'M10', 'M11', 'M12'] },
  { key: 'listening', title: 'Listening', mondaiIds: ['L1', 'L2', 'L3', 'L4', 'L5'] }
];

const DAILY_BANK_VARIANT_MAP = new Map(DAILY_BANK_VARIANTS.map((variant) => [variant.key, variant]));
const DAILY_BANK_EXACT_VARIANT_LOOKUP = new Map(
  DAILY_BANK_VARIANTS
    .filter((variant) => Array.isArray(variant.mondaiIds) && variant.mondaiIds.length > 0)
    .map((variant) => [variant.mondaiIds.slice().sort().join('|'), variant.key])
);
const CURRENT_DAY_RARE_BUCKET_WARM_ENABLED = String(process.env.CURRENT_DAY_RARE_BUCKET_WARM_ENABLED || '1') !== '0';
const CURRENT_DAY_RARE_BUCKET_WARM_ON_STARTUP = String(process.env.CURRENT_DAY_RARE_BUCKET_WARM_ON_STARTUP || '1') !== '0';
const CURRENT_DAY_RARE_BUCKET_WARM_TARGET_PER_BUCKET = Math.max(
  1,
  Number.parseInt(process.env.CURRENT_DAY_RARE_BUCKET_WARM_TARGET_PER_BUCKET || '3', 10)
);
const CURRENT_DAY_RARE_BUCKET_WARM_CONCURRENCY = Math.max(
  1,
  Math.min(2, Number.parseInt(process.env.CURRENT_DAY_RARE_BUCKET_WARM_CONCURRENCY || '1', 10))
);

const examSpecTemplateCache = new Map();
const dailyBankRuntimeState = {
  running: false,
  lastRunDateYmd: null,
  lastStartedAt: null,
  lastFinishedAt: null,
  lastResult: null,
  timer: null
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

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function ensureObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function uniqueStrings(values, limit = 10) {
  const output = [];
  for (const value of ensureArray(values)) {
    const text = String(value || '').trim();
    if (!text || output.includes(text)) continue;
    output.push(text);
    if (output.length >= limit) break;
  }
  return output;
}

function getLearningProfileKey(examId, level) {
  return `${String(examId || 'general').toLowerCase()}::${String(level || 'all').toUpperCase()}`;
}

function normalizeLearningProfile(profile) {
  const source = ensureObject(profile);
  const exams = {};

  Object.entries(ensureObject(source.exams)).forEach(([key, value]) => {
    const examProfile = ensureObject(value);
    exams[key] = {
      exam_id: examProfile.exam_id || null,
      level: examProfile.level || null,
      mode: examProfile.mode || null,
      updated_at: examProfile.updated_at || null,
      attempts: Number.isFinite(examProfile.attempts) ? examProfile.attempts : 0,
      last_score: Number.isFinite(examProfile.last_score) ? examProfile.last_score : null,
      max_score: Number.isFinite(examProfile.max_score) ? examProfile.max_score : null,
      last_accuracy: Number.isFinite(examProfile.last_accuracy) ? examProfile.last_accuracy : null,
      average_accuracy: Number.isFinite(examProfile.average_accuracy) ? examProfile.average_accuracy : null,
      weak_tags: uniqueStrings(examProfile.weak_tags, 12),
      strength_tags: uniqueStrings(examProfile.strength_tags, 12),
      focus_tags: uniqueStrings(examProfile.focus_tags, 12),
      confusion_patterns: uniqueStrings(examProfile.confusion_patterns, 10),
      personalization_hints: uniqueStrings(examProfile.personalization_hints, 10),
      study_plan: uniqueStrings(examProfile.study_plan, 8),
      next_goals: uniqueStrings(examProfile.next_goals, 8),
      learner_summary: String(examProfile.learner_summary || '').trim(),
      recommendation: String(examProfile.recommendation || '').trim(),
      explanation_style: ['step_by_step', 'contrastive', 'example_first'].includes(examProfile.explanation_style)
        ? examProfile.explanation_style
        : 'step_by_step'
    };
  });

  return {
    updated_at: source.updated_at || null,
    explanation_style: ['step_by_step', 'contrastive', 'example_first'].includes(source.explanation_style)
      ? source.explanation_style
      : 'step_by_step',
    weak_tags: uniqueStrings(source.weak_tags, 12),
    strength_tags: uniqueStrings(source.strength_tags, 12),
    focus_tags: uniqueStrings(source.focus_tags, 12),
    confusion_patterns: uniqueStrings(source.confusion_patterns, 10),
    personalization_hints: uniqueStrings(source.personalization_hints, 10),
    study_plan: uniqueStrings(source.study_plan, 8),
    next_goals: uniqueStrings(source.next_goals, 8),
    learner_summary: String(source.learner_summary || '').trim(),
    recommendation: String(source.recommendation || '').trim(),
    exams
  };
}

function mergePersistedLearningProfile(currentProfile, incomingProfile) {
  const current = normalizeLearningProfile(currentProfile);
  if (!incomingProfile) return current;

  const incoming = normalizeLearningProfile(incomingProfile);
  const mergedExams = { ...current.exams };

  Object.entries(incoming.exams).forEach(([key, value]) => {
    const existing = normalizeLearningProfile({ exams: { [key]: mergedExams[key] || {} } }).exams[key] || {};
    mergedExams[key] = {
      ...existing,
      ...value,
      weak_tags: uniqueStrings([...(existing?.weak_tags || []), ...value.weak_tags], 12),
      strength_tags: uniqueStrings([...(existing?.strength_tags || []), ...value.strength_tags], 12),
      focus_tags: uniqueStrings([...(existing?.focus_tags || []), ...value.focus_tags], 12),
      confusion_patterns: uniqueStrings([...(existing?.confusion_patterns || []), ...value.confusion_patterns], 10),
      personalization_hints: uniqueStrings([...(existing?.personalization_hints || []), ...value.personalization_hints], 10),
      study_plan: uniqueStrings([...(existing?.study_plan || []), ...value.study_plan], 8),
      next_goals: uniqueStrings([...(existing?.next_goals || []), ...value.next_goals], 8),
      learner_summary: value.learner_summary || existing?.learner_summary || '',
      recommendation: value.recommendation || existing?.recommendation || '',
      explanation_style: value.explanation_style || existing?.explanation_style || 'step_by_step',
      attempts: Math.max(existing?.attempts || 0, value.attempts || 0),
      last_score: Number.isFinite(value.last_score) ? value.last_score : existing?.last_score ?? null,
      max_score: Number.isFinite(value.max_score) ? value.max_score : existing?.max_score ?? null,
      last_accuracy: Number.isFinite(value.last_accuracy) ? value.last_accuracy : existing?.last_accuracy ?? null,
      average_accuracy: Number.isFinite(value.average_accuracy) ? value.average_accuracy : existing?.average_accuracy ?? null,
      updated_at: value.updated_at || existing?.updated_at || current.updated_at || null
    };
  });

  return {
    ...current,
    ...incoming,
    updated_at: incoming.updated_at || current.updated_at || null,
    explanation_style: incoming.explanation_style || current.explanation_style || 'step_by_step',
    weak_tags: uniqueStrings([...current.weak_tags, ...incoming.weak_tags], 12),
    strength_tags: uniqueStrings([...current.strength_tags, ...incoming.strength_tags], 12),
    focus_tags: uniqueStrings([...current.focus_tags, ...incoming.focus_tags], 12),
    confusion_patterns: uniqueStrings([...current.confusion_patterns, ...incoming.confusion_patterns], 10),
    personalization_hints: uniqueStrings([...current.personalization_hints, ...incoming.personalization_hints], 10),
    study_plan: uniqueStrings([...current.study_plan, ...incoming.study_plan], 8),
    next_goals: uniqueStrings([...current.next_goals, ...incoming.next_goals], 8),
    learner_summary: incoming.learner_summary || current.learner_summary || '',
    recommendation: incoming.recommendation || current.recommendation || '',
    exams: mergedExams
  };
}

function normalizeUserDataShape(data) {
  const source = ensureObject(data);
  return {
    ...source,
    history: ensureArray(source.history),
    mistakeBook: ensureArray(source.mistakeBook),
    weakTags: uniqueStrings(source.weakTags, 20),
    settings: ensureObject(source.settings),
    learningProfile: normalizeLearningProfile(source.learningProfile)
  };
}

function countTagsFromItems(items, limit = 8) {
  const counts = new Map();
  ensureArray(items).forEach((entry) => {
    ensureArray(entry).forEach((tag) => {
      const value = String(tag || '').trim();
      if (!value) return;
      counts.set(value, (counts.get(value) || 0) + 1);
    });
  });

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([tag]) => tag);
}

function buildUserLearningSignals(userData, examMeta = {}) {
  const normalizedUser = normalizeUserDataShape(userData);
  const examId = examMeta.exam_id || examMeta.examId || 'general';
  const level = examMeta.level || 'all';
  const profileKey = getLearningProfileKey(examId, level);
  const learningProfile = normalizeLearningProfile(normalizedUser.learningProfile);
  const examProfile = ensureObject(learningProfile.exams[profileKey]);
  const sameExamHistory = normalizedUser.history.filter((entry) => !examId || !entry?.exam || entry.exam === examId);
  const recentHistory = sameExamHistory.slice(-5);
  const recentAccuracies = recentHistory
    .map((entry) => {
      const score = Number(entry?.score ?? entry?.summary?.total_score ?? entry?.summary?.score_total);
      const maxScore = Number(entry?.maxScore ?? entry?.max_score ?? entry?.summary?.max_score ?? entry?.summary?.score_max);
      if (!Number.isFinite(score) || !Number.isFinite(maxScore) || maxScore <= 0) return null;
      return Math.round((score / maxScore) * 100);
    })
    .filter((value) => Number.isFinite(value));

  const relevantMistakes = normalizedUser.mistakeBook.filter((entry) => !examId || !entry?.exam || entry.exam === examId);
  const weakTagsFromMistakes = countTagsFromItems(
    relevantMistakes.map((entry) => entry?.question?.tags || entry?.tags),
    8
  );

  return {
    profileKey,
    attemptCount: Number.isFinite(examProfile.attempts) ? examProfile.attempts : recentHistory.length,
    averageAccuracy: Number.isFinite(examProfile.average_accuracy)
      ? examProfile.average_accuracy
      : (recentAccuracies.length > 0
        ? Math.round(recentAccuracies.reduce((sum, value) => sum + value, 0) / recentAccuracies.length)
        : null),
    lastAccuracy: Number.isFinite(examProfile.last_accuracy)
      ? examProfile.last_accuracy
      : (recentAccuracies.length > 0 ? recentAccuracies[recentAccuracies.length - 1] : null),
    weakTags: uniqueStrings([
      ...weakTagsFromMistakes,
      ...normalizedUser.weakTags,
      ...ensureArray(examProfile.weak_tags),
      ...ensureArray(learningProfile.weak_tags)
    ], 10),
    strengthTags: uniqueStrings([
      ...ensureArray(examProfile.strength_tags),
      ...ensureArray(learningProfile.strength_tags)
    ], 8),
    focusTags: uniqueStrings([
      ...ensureArray(examProfile.focus_tags),
      ...ensureArray(learningProfile.focus_tags),
      ...weakTagsFromMistakes
    ], 8),
    confusionPatterns: uniqueStrings([
      ...ensureArray(examProfile.confusion_patterns),
      ...ensureArray(learningProfile.confusion_patterns)
    ], 6),
    personalizationHints: uniqueStrings([
      ...ensureArray(examProfile.personalization_hints),
      ...ensureArray(learningProfile.personalization_hints)
    ], 6),
    studyPlan: uniqueStrings([
      ...ensureArray(examProfile.study_plan),
      ...ensureArray(learningProfile.study_plan)
    ], 6),
    nextGoals: uniqueStrings([
      ...ensureArray(examProfile.next_goals),
      ...ensureArray(learningProfile.next_goals)
    ], 6),
    explanationStyle: examProfile.explanation_style || learningProfile.explanation_style || 'step_by_step',
    learnerSummary: examProfile.learner_summary || learningProfile.learner_summary || '',
    recommendation: examProfile.recommendation || learningProfile.recommendation || ''
  };
}

function buildUserLearningContext(userData, examMeta = {}, uiLocale = 'vi') {
  const signals = buildUserLearningSignals(userData, examMeta);
  const lines = [];

  if (Number.isFinite(signals.averageAccuracy)) {
    lines.push(`- Historical average accuracy: ${signals.averageAccuracy}% across ${signals.attemptCount || 0} saved attempts.`);
  }
  if (Number.isFinite(signals.lastAccuracy)) {
    lines.push(`- Most recent saved accuracy: ${signals.lastAccuracy}%.`);
  }
  if (signals.weakTags.length > 0) {
    lines.push(`- Frequent weak tags: ${signals.weakTags.join(', ')}.`);
  }
  if (signals.focusTags.length > 0) {
    lines.push(`- Current focus tags: ${signals.focusTags.join(', ')}.`);
  }
  if (signals.confusionPatterns.length > 0) {
    lines.push(`- Observed confusion patterns: ${signals.confusionPatterns.join(', ')}.`);
  }
  if (signals.personalizationHints.length > 0) {
    lines.push(`- Helpful coaching style hints: ${signals.personalizationHints.join(', ')}.`);
  }
  if (signals.learnerSummary) {
    lines.push(`- Existing learner summary: ${signals.learnerSummary}`);
  }
  if (signals.recommendation) {
    lines.push(`- Existing recommendation: ${signals.recommendation}`);
  }

  if (lines.length === 0) {
    return uiLocale === 'en'
      ? 'No prior learner profile is available yet. Treat this as an early diagnostic attempt.'
      : 'Chưa có hồ sơ học tập trước đó. Hãy xem đây là một lần chẩn đoán ban đầu.';
  }

  return lines.join('\n');
}

function buildUserExamGenerationHints(userData, examMeta = {}) {
  const signals = buildUserLearningSignals(userData, examMeta);
  const hints = {
    weak_tags: uniqueStrings([...signals.focusTags, ...signals.weakTags], 5),
    strong_tags: uniqueStrings(signals.strengthTags, 4),
    confusion_patterns: uniqueStrings(signals.confusionPatterns, 4),
    personalization_hints: uniqueStrings(signals.personalizationHints, 4),
    explanation_style: signals.explanationStyle || 'step_by_step',
    learner_summary: signals.learnerSummary || ''
  };

  const hasHints = hints.weak_tags.length > 0 ||
    hints.strong_tags.length > 0 ||
    hints.confusion_patterns.length > 0 ||
    hints.personalization_hints.length > 0 ||
    !!hints.learner_summary;

  return hasHints ? hints : null;
}

function buildFallbackGradeAnalysis({
  uiLocale,
  correctCount,
  totalCount,
  weakTags = [],
  strongTags = [],
  previousSignals = null
}) {
  const percent = totalCount > 0 ? Math.round((correctCount / totalCount) * 100) : 0;
  const focusTags = uniqueStrings(weakTags, 4);
  const explanationStyle = previousSignals?.explanationStyle || 'step_by_step';

  if (uiLocale === 'en') {
    return {
      recommendation: percent >= 70
        ? 'You are on the right track. Keep your pace, then spend a few focused minutes reviewing the weak spots from this test.'
        : 'This result is still very fixable. Review the weak spots from this test first, then retry similar items with short focused drills.',
      learner_summary: focusTags.length > 0
        ? `Your base is better on familiar patterns, but you still get pulled off track by ${focusTags.join(', ')}.`
        : 'Your foundation is forming, and the next step is to make your answer-selection process more consistent.',
      study_plan: focusTags.length > 0
        ? focusTags.map((tag) => `Review ${tag} with 3-5 short examples and one contrast pair.`)
        : ['Redo the incorrect questions once more and explain the correct choice aloud.'],
      strength_tags: uniqueStrings(strongTags, 5),
      weak_tags: uniqueStrings(weakTags, 8),
      focus_tags: focusTags,
      confusion_patterns: previousSignals?.confusionPatterns || [],
      personalization_hints: uniqueStrings([
        explanationStyle === 'contrastive'
          ? 'Validate the learner’s likely intuition first, then contrast the chosen answer against the correct answer.'
          : explanationStyle === 'example_first'
            ? 'Lead with one concrete example before giving the rule, then end with what clue to notice next time.'
            : 'Explain mistakes step by step, keep terminology simple, and end with what clue to notice next time.',
        'Prefer short coaching notes that feel like one-on-one tutoring, not an answer key.'
      ], 5),
      explanation_style: explanationStyle,
      next_goals: percent >= 70
        ? ['Maintain score stability on the next attempt.', 'Push one weak tag into your comfort zone.']
        : ['Recover the main weak tags from this attempt.', 'Aim for a clearer answer-selection process on similar items.']
    };
  }

  return {
    recommendation: percent >= 70
      ? 'Bạn đang đi đúng hướng. Hãy giữ nhịp học hiện tại, rồi dành vài phút rà lại đúng những chỗ vừa sai trong bài này.'
      : 'Bài này vẫn gỡ lại được. Bạn nên ôn ngay các điểm yếu vừa lộ ra, rồi làm lại vài câu cùng dạng để khóa cách nhận diện.',
    learner_summary: focusTags.length > 0
      ? `Nền tảng của bạn ổn hơn ở các mẫu quen thuộc, nhưng vẫn dễ bị kéo lệch ở ${focusTags.join(', ')}.`
      : 'Bài làm này cho thấy nền tảng đang hình thành; bước tiếp theo là làm cho quy trình chọn đáp án ổn định hơn.',
    study_plan: focusTags.length > 0
      ? focusTags.map((tag) => `Ôn lại ${tag} bằng 3-5 ví dụ ngắn và 1 cặp so sánh đúng/sai.`)
      : ['Làm lại các câu sai thêm một lần và tự giải thích vì sao đáp án đúng hợp lý hơn.'],
    strength_tags: uniqueStrings(strongTags, 5),
    weak_tags: uniqueStrings(weakTags, 8),
    focus_tags: focusTags,
    confusion_patterns: previousSignals?.confusionPatterns || [],
    personalization_hints: uniqueStrings([
      explanationStyle === 'contrastive'
        ? 'Ưu tiên xác nhận chỗ dễ nhầm trước, rồi đối chiếu rõ đáp án đã chọn với đáp án đúng.'
        : explanationStyle === 'example_first'
          ? 'Ưu tiên đưa ví dụ cụ thể trước rồi mới rút ra quy tắc, và chốt lại bằng dấu hiệu cần nhìn ở lần sau.'
          : 'Ưu tiên giải thích từng bước, dùng thuật ngữ đơn giản và chốt lại bằng dấu hiệu cần nhìn ở lần sau.',
      'Giọng giải thích nên giống gia sư kèm riêng, không giống đáp án mẫu.'
    ], 5),
    explanation_style: explanationStyle,
    next_goals: percent >= 70
      ? ['Giữ vững điểm số ở lần làm tiếp theo.', 'Biến ít nhất 1 nhóm điểm yếu thành vùng an toàn hơn.']
      : ['Gỡ lại các nhóm lỗi chính trong bài này.', 'Tập quy trình chọn đáp án rõ ràng hơn cho các câu tương tự.']
  };
}

function mergeLearningProfile(userData, analysisSummary, examMeta = {}) {
  const baseData = normalizeUserDataShape(userData);
  const baseProfile = normalizeLearningProfile(baseData.learningProfile);
  const examId = examMeta.exam_id || examMeta.examId || 'general';
  const level = examMeta.level || 'all';
  const profileKey = getLearningProfileKey(examId, level);
  const existingExamProfile = ensureObject(baseProfile.exams[profileKey]);
  const totalScore = Number(examMeta.total_score);
  const maxScore = Number(examMeta.max_score);
  const accuracy = Number.isFinite(totalScore) && Number.isFinite(maxScore) && maxScore > 0
    ? Math.round((totalScore / maxScore) * 100)
    : null;
  const nextAttempts = (existingExamProfile.attempts || 0) + 1;
  const nextAverageAccuracy = accuracy === null
    ? (Number.isFinite(existingExamProfile.average_accuracy) ? existingExamProfile.average_accuracy : null)
    : (
      Number.isFinite(existingExamProfile.average_accuracy) && existingExamProfile.attempts
        ? Math.round(((existingExamProfile.average_accuracy * existingExamProfile.attempts) + accuracy) / nextAttempts)
        : accuracy
    );
  const nowIso = new Date().toISOString();

  const nextExamProfile = {
    exam_id: examId,
    level,
    mode: examMeta.mode || existingExamProfile.mode || null,
    updated_at: nowIso,
    attempts: nextAttempts,
    last_score: Number.isFinite(totalScore) ? totalScore : existingExamProfile.last_score ?? null,
    max_score: Number.isFinite(maxScore) ? maxScore : existingExamProfile.max_score ?? null,
    last_accuracy: accuracy,
    average_accuracy: nextAverageAccuracy,
    weak_tags: uniqueStrings([
      ...ensureArray(analysisSummary?.weak_tags),
      ...ensureArray(existingExamProfile.weak_tags)
    ], 12),
    strength_tags: uniqueStrings([
      ...ensureArray(analysisSummary?.strength_tags),
      ...ensureArray(existingExamProfile.strength_tags)
    ], 12),
    focus_tags: uniqueStrings([
      ...ensureArray(analysisSummary?.focus_tags),
      ...ensureArray(analysisSummary?.weak_tags),
      ...ensureArray(existingExamProfile.focus_tags)
    ], 12),
    confusion_patterns: uniqueStrings([
      ...ensureArray(analysisSummary?.confusion_patterns),
      ...ensureArray(existingExamProfile.confusion_patterns)
    ], 10),
    personalization_hints: uniqueStrings([
      ...ensureArray(analysisSummary?.personalization_hints),
      ...ensureArray(existingExamProfile.personalization_hints)
    ], 10),
    study_plan: uniqueStrings([
      ...ensureArray(analysisSummary?.study_plan),
      ...ensureArray(existingExamProfile.study_plan)
    ], 8),
    next_goals: uniqueStrings([
      ...ensureArray(analysisSummary?.next_goals),
      ...ensureArray(existingExamProfile.next_goals)
    ], 8),
    learner_summary: String(analysisSummary?.learner_summary || existingExamProfile.learner_summary || '').trim(),
    recommendation: String(analysisSummary?.recommendation || existingExamProfile.recommendation || '').trim(),
    explanation_style: ['step_by_step', 'contrastive', 'example_first'].includes(analysisSummary?.explanation_style)
      ? analysisSummary.explanation_style
      : (existingExamProfile.explanation_style || baseProfile.explanation_style || 'step_by_step')
  };

  return mergePersistedLearningProfile(baseProfile, {
    updated_at: nowIso,
    explanation_style: nextExamProfile.explanation_style,
    weak_tags: nextExamProfile.weak_tags,
    strength_tags: nextExamProfile.strength_tags,
    focus_tags: nextExamProfile.focus_tags,
    confusion_patterns: nextExamProfile.confusion_patterns,
    personalization_hints: nextExamProfile.personalization_hints,
    study_plan: nextExamProfile.study_plan,
    next_goals: nextExamProfile.next_goals,
    learner_summary: nextExamProfile.learner_summary,
    recommendation: nextExamProfile.recommendation,
    exams: {
      [profileKey]: nextExamProfile
    }
  });
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
    return normalizeUserDataShape({
      history: [],
      mistakeBook: [],
      weakTags: [],
      nickname: 'Demo User',
      settings: {},
      learningProfile: {}
    });
  }

  try {
    const res = await db.query('SELECT * FROM users WHERE id = $1', [userId]);

    if (res.rows.length === 0) {
      // Create new user if not exists
      const initialData = normalizeUserDataShape({ history: [], mistakeBook: [], weakTags: [], settings: {}, learningProfile: {} });
      await db.query(
        'INSERT INTO users (id, email, data) VALUES ($1, $2, $3)',
        [userId, email || '', JSON.stringify(initialData)]
      );
      return { ...initialData, nickname: null }; // Force nickname prompt
    }

    const { data, nickname } = res.rows[0];
    const parsedData = typeof data === 'string' ? JSON.parse(data) : data;
    return { ...normalizeUserDataShape(parsedData), nickname };
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
  const normalizedData = normalizeUserDataShape(data);
  const { nickname, ttsCache, ...jsonData } = normalizedData;

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
    const currentData = normalizeUserDataShape(await loadUserData(req.user.userId, req.user.email));
    const incomingData = normalizeUserDataShape(req.body);
    const newData = {
      ...currentData,
      ...incomingData,
      history: Array.isArray(req.body?.history) ? incomingData.history : currentData.history,
      mistakeBook: Array.isArray(req.body?.mistakeBook) ? incomingData.mistakeBook : currentData.mistakeBook,
      weakTags: Array.isArray(req.body?.weakTags) ? incomingData.weakTags : currentData.weakTags,
      settings: req.body?.settings ? { ...currentData.settings, ...incomingData.settings } : currentData.settings,
      learningProfile: mergePersistedLearningProfile(currentData.learningProfile, req.body?.learningProfile)
    };
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
 * Sanitize mondai for client: remove grading-only fields before sending to browser
 * Ensures NO server-only answer data leaks to client before submission
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
        // Remove sensitive grading fields before returning any payload to the browser.
        delete item.answer_index;
        delete item.answer_hash;
        delete item.correct_answer;
        delete item.correct_index;
        delete item.answer_key;
        delete item.answer_keys; // Ensure plural is also removed
        delete item.is_correct;
        delete item.user_answer_index;
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
const BLUEPRINT_EAGER_SLOT_COUNT = Math.max(
  1,
  Number.parseInt(process.env.BLUEPRINT_EAGER_SLOT_COUNT || '2', 10)
);
const BLUEPRINT_ON_DEMAND_BATCH_SIZE = Math.max(
  1,
  Number.parseInt(process.env.BLUEPRINT_ON_DEMAND_BATCH_SIZE || '2', 10)
);
const BLUEPRINT_ON_DEMAND_REQUEST_CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.BLUEPRINT_ON_DEMAND_REQUEST_CONCURRENCY || '2', 10)
);
const BLUEPRINT_GENERATION_CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.BLUEPRINT_GENERATION_CONCURRENCY || '4', 10)
);
const OPENROUTER_RPM = Math.max(
  1,
  Number.parseInt(process.env.OPENROUTER_RPM || '5', 10)
);
const SNAPSHOT_RARE_BUCKET_BOOTSTRAP_TARGET = Math.max(
  2,
  Number.parseInt(process.env.SNAPSHOT_RARE_BUCKET_BOOTSTRAP_TARGET || '3', 10)
);
const SNAPSHOT_LISTENING_BUCKET_BOOTSTRAP_TARGET = Math.max(
  SNAPSHOT_RARE_BUCKET_BOOTSTRAP_TARGET,
  Number.parseInt(process.env.SNAPSHOT_LISTENING_BUCKET_BOOTSTRAP_TARGET || '4', 10)
);
const snapshotRareBucketBootstrapState = new Map();
const currentDayRareBucketWarmRuntimeState = {
  entries: new Map(),
  queue: [],
  activeCount: 0,
  lastScheduledAt: null,
  lastFinishedAt: null,
  lastResult: null
};

function getEffectiveBlueprintGenerationConcurrency() {
  const rpmBound = Math.max(1, Math.min(OPENROUTER_RPM, 5));
  return Math.max(1, Math.min(BLUEPRINT_GENERATION_CONCURRENCY, rpmBound));
}

function getEffectiveOnDemandRequestConcurrency() {
  return Math.max(
    1,
    Math.min(getEffectiveBlueprintGenerationConcurrency(), BLUEPRINT_ON_DEMAND_REQUEST_CONCURRENCY)
  );
}

function chunkArray(items, size) {
  const result = [];
  const chunkSize = Math.max(1, Number(size) || 1);
  for (let i = 0; i < items.length; i += chunkSize) {
    result.push(items.slice(i, i + chunkSize));
  }
  return result;
}

function buildMondaiDefFromSlot(slot) {
  return {
    mondai_id: slot?.mondai_id,
    title_vi: slot?.title_vi || slot?.mondai_id || 'Mondai',
    types: Array.isArray(slot?.types) && slot.types.length > 0
      ? slot.types
      : [slot?.type || 'unknown'],
    count_official: slot?.count_official || slot?.question_count || 1,
    estimated_seconds: slot?.estimated_seconds || null,
    mondai_type: slot?.type || null
  };
}

function buildPromptExamSpecFromBlueprint(blueprint) {
  const meta = blueprint?.meta || {};
  return {
    exam_id: meta.exam_id || 'jlpt',
    display_name_vi: meta.display_name_vi || String(meta.exam_id || 'JLPT').toUpperCase(),
    language: meta.language || 'ja-JP',
    level: meta.level || 'N5',
    modes: meta.modes || DEFAULT_MODES
  };
}

async function generateMondaiForSlotBatch(params) {
  const {
    examSpec,
    level,
    mode,
    group,
    batchEntries,
    learnerHints = null
  } = params;

  if (!Array.isArray(batchEntries) || batchEntries.length === 0) return [];

  const promptGroup = group?.mondai
    ? group
    : {
      group_id: group?.group_id,
      title_vi: group?.title_vi,
      mondai: group?.mondai_slots || batchEntries.map((entry) => entry.slot)
    };
  const startMondaiIndex = batchEntries[0]?.slot?.slot_ordinal || 0;
  const mondaiBatch = batchEntries.map((entry) => entry.mondaiDef);
  const validateMondaiChunkResult = buildMondaiChunkValidator(mondaiBatch, examSpec, mode);

  const prompt = buildMondaiChunkPrompt(
    examSpec,
    mode,
    promptGroup,
    0,
    mondaiBatch,
    startMondaiIndex,
    [],
    learnerHints
  );

  const generationRunConfig = getMondaiGenerationRunConfig(mondaiBatch);
  const generation = await runJsonTask({
    task: 'generate',
    prompt,
    validateResult: validateMondaiChunkResult,
    buildRepairPrompt: (context) => buildMondaiChunkRepairPrompt({
      ...context,
      examSpec,
      mode,
      mondaiBatch
    }),
    maxTokens: GENERATE_MAX_TOKENS,
    temperature: generationRunConfig.temperature,
    preferredProviders: generationRunConfig.preferredProviders,
    preferredStageNames: generationRunConfig.preferredStageNames
  });

  const mondaiList = Array.isArray(generation?.result?.mondai) ? generation.result.mondai : [];
  if (mondaiList.length === 0) {
    throw createTemporaryUnavailableError(new Error('Batch generation returned no mondai'));
  }

  const unusedMondai = mondaiList.slice();
  const generatedAssignments = [];

  for (const entry of batchEntries) {
    const expectedMondaiId = String(entry?.mondaiDef?.mondai_id || '').toUpperCase();
    let matchIndex = unusedMondai.findIndex((mondai) =>
      String(mondai?.mondai_id || '').toUpperCase() === expectedMondaiId
    );
    if (matchIndex === -1) matchIndex = 0;

    const mondai = unusedMondai.splice(matchIndex, 1)[0];
    if (!mondai) continue;

    mondai.mondai_id = entry.mondaiDef.mondai_id;
    mondai.primary_type = entry.mondaiDef.types[0];
    canonicalizeMondaiQuestionIds(mondai, { mondaiId: entry.mondaiDef.mondai_id });

    const hash = generateMondaiHash(mondai);
    const itemType = mondai.mondai_type || entry.mondaiDef.mondai_type || entry.mondaiDef.types?.[0] || 'unknown';
    const estimatedCost = entry.mondaiDef.estimated_seconds || 60;

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
      entry.mondaiDef.mondai_id,
      entry.mondaiDef.types[0],
      itemType,
      estimatedCost,
      JSON.stringify(mondai),
      JSON.stringify({
        mode,
        generated_at: new Date().toISOString(),
        llm_provider: formatLlmProviderLabel(generation.meta),
        batch_strategy: `1x${batchEntries.length}`
      })
    ]);

    await db.query(`
      INSERT INTO pool_snapshot_items (snapshot_id, bucket_key, mondai_hash, group_id)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (snapshot_id, bucket_key, mondai_hash) DO NOTHING
    `, [entry.snapshotId, entry.slot.bucket_key, hash, group.group_id]);

    generatedAssignments.push({
      entry,
      hash
    });
  }

  return generatedAssignments;
}

/**
 * Ensure pool snapshot exists (Meta only)
 * Does NOT actively fill pool - on-demand generation in buildExamBlueprint handles this
 */
async function ensurePoolSnapshot(examSpec, level, dateYmd, plan, mode) {
  // Wait for DB initialization instead of checking boolean
  const ok = await db.initDb();
  if (!ok) return null;
  const expiresAt = new Date(`${addDaysToDateYmd(dateYmd, DAILY_BANK_RETENTION_DAYS)}T23:59:59.999Z`).toISOString();

  // UPSERT Snapshot (race-safe)
  const snapshotRes = await db.query(`
    INSERT INTO pool_snapshots (exam_id, level, mode, date_ymd, expires_at, params)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb)
    ON CONFLICT (exam_id, level, mode, date_ymd)
    DO UPDATE SET
      exam_id = EXCLUDED.exam_id,
      expires_at = EXCLUDED.expires_at,
      params = COALESCE(pool_snapshots.params, '{}'::jsonb) || EXCLUDED.params
    RETURNING id
  `, [
    examSpec.exam_id,
    level,
    mode,
    dateYmd,
    expiresAt,
    JSON.stringify({
      plan: plan || 'daily-bank',
      retention_days: DAILY_BANK_RETENTION_DAYS
    })
  ]);

  const snapshotId = snapshotRes.rows[0]?.id;

  // NOTE: No preroll here - on-demand generation in buildExamBlueprint handles missing items
  // This ensures /api/exam/start returns quickly without blocking Gemini calls
  if (!['daily-bank', 'warmup', 'startup-rare-warm'].includes(String(plan || '').toLowerCase())) {
    scheduleCurrentDayRareBucketWarmup({
      snapshotId,
      examSpec,
      level,
      mode,
      dateYmd,
      trigger: plan || 'ensure-pool-snapshot'
    });
  }

  return snapshotId;
}

function getSnapshotRareBucketBootstrapTarget(group, mondaiDef) {
  const mondaiId = String(mondaiDef?.mondai_id || '').toUpperCase();
  const groupId = String(group?.group_id || '').toLowerCase();

  if (groupId === 'listening' || mondaiId.startsWith('L')) {
    return SNAPSHOT_LISTENING_BUCKET_BOOTSTRAP_TARGET;
  }
  if (mondaiId === 'M12') {
    return SNAPSHOT_RARE_BUCKET_BOOTSTRAP_TARGET;
  }
  return 0;
}

function getCurrentDayRareBucketWarmTarget(group, mondaiDef) {
  const bootstrapTarget = getSnapshotRareBucketBootstrapTarget(group, mondaiDef);
  if (bootstrapTarget <= 0) return 0;
  return Math.min(bootstrapTarget, CURRENT_DAY_RARE_BUCKET_WARM_TARGET_PER_BUCKET);
}

async function copyBucketItemsFromRecentSnapshots({ snapshotId, bucketKey, groupId, limit, level = null, primaryType = null }) {
  const safeLimit = Math.max(0, Number(limit) || 0);
  if (!snapshotId || !bucketKey || safeLimit <= 0) return 0;

  const insertRes = await db.query(`
    WITH current_snapshot AS (
      SELECT exam_id, level, mode
      FROM pool_snapshots
      WHERE id = $1
    ),
    candidate_hashes AS (
      SELECT psi.mondai_hash, MAX(src.date_ymd) AS latest_date
      FROM pool_snapshot_items psi
      JOIN pool_snapshots src ON src.id = psi.snapshot_id
      JOIN current_snapshot current
        ON current.exam_id = src.exam_id
       AND current.level = src.level
       AND current.mode = src.mode
      JOIN mondai_bank mb ON mb.hash = psi.mondai_hash
      LEFT JOIN pool_snapshot_items existing
        ON existing.snapshot_id = $1
       AND existing.bucket_key = $2
       AND existing.mondai_hash = psi.mondai_hash
      WHERE psi.bucket_key = $2
        AND psi.snapshot_id <> $1
        AND existing.mondai_hash IS NULL
        AND (src.expires_at IS NULL OR src.expires_at > NOW())
        AND ($3::text IS NULL OR mb.level = $3 OR mb.level IS NULL)
        AND ($4::text IS NULL OR mb.primary_type = $4)
      GROUP BY psi.mondai_hash
      ORDER BY MAX(src.date_ymd) DESC, psi.mondai_hash ASC
      LIMIT $5
    )
    INSERT INTO pool_snapshot_items (snapshot_id, bucket_key, mondai_hash, group_id)
    SELECT $1, $2, candidate_hashes.mondai_hash, $6
    FROM candidate_hashes
    ON CONFLICT (snapshot_id, bucket_key, mondai_hash) DO NOTHING
    RETURNING mondai_hash
  `, [snapshotId, bucketKey, level, primaryType, safeLimit, groupId || null]);

  return Number(insertRes.rowCount || 0);
}

async function copyBucketItemsFromMondaiBank({
  snapshotId,
  bucketKey,
  groupId,
  limit,
  examId,
  level = null,
  mondaiId = null,
  primaryType = null
}) {
  const safeLimit = Math.max(0, Number(limit) || 0);
  if (!snapshotId || !bucketKey || !groupId || !examId || safeLimit <= 0) return 0;

  const insertRes = await db.query(`
    INSERT INTO pool_snapshot_items (snapshot_id, bucket_key, mondai_hash, group_id)
    SELECT $1, $2, mb.hash, $3
    FROM mondai_bank mb
    LEFT JOIN pool_snapshot_items existing
      ON existing.snapshot_id = $1
     AND existing.bucket_key = $2
     AND existing.mondai_hash = mb.hash
    WHERE mb.exam_id = $4
      AND mb.group_id = $3
      AND ($5::text IS NULL OR mb.level = $5 OR mb.level IS NULL)
      AND ($6::text IS NULL OR mb.mondai_id = $6)
      AND ($7::text IS NULL OR mb.primary_type = $7)
      AND existing.mondai_hash IS NULL
    ORDER BY mb.updated_at DESC NULLS LAST, mb.created_at DESC NULLS LAST, mb.hash ASC
    LIMIT $8
    ON CONFLICT (snapshot_id, bucket_key, mondai_hash) DO NOTHING
    RETURNING mondai_hash
  `, [snapshotId, bucketKey, groupId, examId, level, mondaiId, primaryType, safeLimit]);

  return Number(insertRes.rowCount || 0);
}

function getBucketWarmPriority(group, mondaiDef) {
  const mondaiId = String(mondaiDef?.mondai_id || '').toUpperCase();
  const groupId = String(group?.group_id || '').toLowerCase();

  if (groupId === 'listening' || mondaiId.startsWith('L')) return 0;
  if (mondaiId === 'M12') return 1;
  if (groupId === 'reading') return 2;
  return 3;
}

function sortBucketsForWarmup(buckets = []) {
  return ensureArray(buckets)
    .map((bucket, index) => ({ bucket, index }))
    .sort((left, right) => {
      const leftPriority = getBucketWarmPriority(left.bucket?.group, left.bucket?.mondaiDef);
      const rightPriority = getBucketWarmPriority(right.bucket?.group, right.bucket?.mondaiDef);
      if (leftPriority !== rightPriority) return leftPriority - rightPriority;
      return left.index - right.index;
    })
    .map((entry) => entry.bucket);
}

function buildRareBucketEntries(examSpec, targetResolver) {
  const rareBuckets = [];

  for (const group of ensureArray(examSpec?.groups)) {
    for (const mondaiDef of ensureArray(group?.mondai)) {
      const targetCount = Number(targetResolver(group, mondaiDef) || 0);
      if (targetCount <= 0 || !mondaiDef?.types?.[0]) continue;
      rareBuckets.push({
        group,
        mondaiDef,
        bucketKey: getBucketKey(group.group_id, mondaiDef.mondai_id, mondaiDef.types[0]),
        targetCount
      });
    }
  }

  return sortBucketsForWarmup(rareBuckets);
}

async function bootstrapRareBucketsForSnapshot(snapshotId, examSpec, level, mode) {
  if (!snapshotId || !examSpec) return { copied: 0, buckets: [] };

  const cacheKey = `${snapshotId}:rare-bootstrap`;
  if (snapshotRareBucketBootstrapState.has(cacheKey)) {
    return snapshotRareBucketBootstrapState.get(cacheKey);
  }

  const task = (async () => {
    const stats = { copied: 0, buckets: [] };

    for (const group of ensureArray(examSpec.groups)) {
      for (const mondaiDef of ensureArray(group?.mondai)) {
        const targetCount = getSnapshotRareBucketBootstrapTarget(group, mondaiDef);
        if (targetCount <= 0 || !mondaiDef?.types?.[0]) continue;

        const bucketKey = getBucketKey(group.group_id, mondaiDef.mondai_id, mondaiDef.types[0]);
        const countRes = await db.query(
          'SELECT COUNT(*) FROM pool_snapshot_items WHERE snapshot_id=$1 AND bucket_key=$2',
          [snapshotId, bucketKey]
        );
        const currentCount = Number.parseInt(countRes.rows?.[0]?.count || '0', 10) || 0;
        const needed = Math.max(0, targetCount - currentCount);
        if (needed <= 0) continue;

        const copiedFromSnapshots = await copyBucketItemsFromRecentSnapshots({
          snapshotId,
          bucketKey,
          groupId: group.group_id,
          limit: needed,
          level,
          primaryType: mondaiDef.types[0]
        });
        const remainingAfterSnapshots = Math.max(0, needed - copiedFromSnapshots);
        const copiedFromBank = remainingAfterSnapshots > 0
          ? await copyBucketItemsFromMondaiBank({
            snapshotId,
            bucketKey,
            groupId: group.group_id,
            limit: remainingAfterSnapshots,
            examId: examSpec.exam_id,
            level,
            mondaiId: mondaiDef.mondai_id,
            primaryType: mondaiDef.types[0]
          })
          : 0;
        const copied = copiedFromSnapshots + copiedFromBank;

        if (copied > 0) {
          stats.copied += copied;
          stats.buckets.push({
            bucketKey,
            copied,
            copiedFromSnapshots,
            copiedFromBank
          });
        }
      }
    }

    if (stats.copied > 0) {
      console.log(`[SnapshotBootstrap] Copied ${stats.copied} rare bucket items into snapshot ${String(snapshotId).slice(0, 8)}...`);
    }

    return stats;
  })().catch((error) => {
    console.warn('[SnapshotBootstrap] Failed:', error?.message || error);
    return { copied: 0, buckets: [] };
  });

  snapshotRareBucketBootstrapState.set(cacheKey, task);
  return task;
}

async function seedRareBucketsForSnapshot(snapshotId, examSpec, level, mode, dateYmd, options = {}) {
  if (!snapshotId || !examSpec) {
    return {
      ok: false,
      snapshotId,
      level,
      mode,
      dateYmd,
      copied: 0,
      generated: 0,
      bucketsProcessed: 0,
      skipped: 0
    };
  }

  const startedAt = Date.now();
  const bootstrapStats = await bootstrapRareBucketsForSnapshot(snapshotId, examSpec, level, mode);
  const rareBuckets = buildRareBucketEntries(examSpec, getCurrentDayRareBucketWarmTarget);
  let generated = 0;
  let bucketsProcessed = 0;
  let skipped = 0;

  for (const bucket of rareBuckets) {
    const { group, mondaiDef, bucketKey, targetCount } = bucket;
    const countRes = await db.query(
      'SELECT COUNT(*) FROM pool_snapshot_items WHERE snapshot_id=$1 AND bucket_key=$2',
      [snapshotId, bucketKey]
    );
    const currentCount = Number.parseInt(countRes.rows?.[0]?.count || '0', 10) || 0;
    const needed = Math.max(0, targetCount - currentCount);
    if (needed <= 0) {
      skipped += 1;
      continue;
    }

    console.log(`[RareWarm] Filling ${bucketKey}: ${currentCount} -> ${currentCount + needed} (target: ${targetCount})`);
    await generateMondaiForBucket({
      examSpec,
      level,
      mode,
      group,
      mondaiDef,
      bucketKey,
      snapshotId,
      count: needed
    });
    generated += needed;
    bucketsProcessed += 1;
  }

  return {
    ok: true,
    snapshotId,
    exam_id: examSpec.exam_id,
    level,
    mode,
    dateYmd,
    copied: Number(bootstrapStats?.copied || 0),
    generated,
    bucketsProcessed,
    skipped,
    targetBuckets: rareBuckets.length,
    durationMs: Date.now() - startedAt
  };
}

function shouldScheduleCurrentDayRareBucketWarmup(dateYmd) {
  if (!CURRENT_DAY_RARE_BUCKET_WARM_ENABLED || IS_VERCEL) return false;
  return String(dateYmd || '') === formatDateYmd();
}

function buildCurrentDayRareBucketWarmKey(examSpec, level, mode, dateYmd) {
  return [
    examSpec?.exam_id || 'unknown',
    String(level || examSpec?.level || '').toUpperCase(),
    String(mode || '').toLowerCase(),
    String(dateYmd || '')
  ].join('|');
}

function pumpCurrentDayRareBucketWarmQueue() {
  if (!CURRENT_DAY_RARE_BUCKET_WARM_ENABLED || IS_VERCEL) return;

  while (
    currentDayRareBucketWarmRuntimeState.activeCount < CURRENT_DAY_RARE_BUCKET_WARM_CONCURRENCY &&
    currentDayRareBucketWarmRuntimeState.queue.length > 0
  ) {
    const key = currentDayRareBucketWarmRuntimeState.queue.shift();
    const entry = currentDayRareBucketWarmRuntimeState.entries.get(key);
    if (!entry || entry.status !== 'scheduled') continue;

    entry.status = 'running';
    entry.startedAt = new Date().toISOString();
    currentDayRareBucketWarmRuntimeState.activeCount += 1;

    Promise.resolve()
      .then(async () => {
        const result = await seedRareBucketsForSnapshot(
          entry.snapshotId,
          entry.examSpec,
          entry.level,
          entry.mode,
          entry.dateYmd,
          { trigger: entry.trigger }
        );
        entry.status = 'completed';
        entry.finishedAt = new Date().toISOString();
        entry.result = result;
        currentDayRareBucketWarmRuntimeState.lastFinishedAt = entry.finishedAt;
        currentDayRareBucketWarmRuntimeState.lastResult = {
          key,
          trigger: entry.trigger,
          result
        };
        console.log(
          `[RareWarm] Completed ${entry.examSpec.exam_id} ${entry.level} ${entry.mode} ${entry.dateYmd}: ` +
          `copied=${result.copied} generated=${result.generated} processed=${result.bucketsProcessed}`
        );
      })
      .catch((error) => {
        entry.status = 'failed';
        entry.finishedAt = new Date().toISOString();
        entry.error = error?.message || String(error);
        currentDayRareBucketWarmRuntimeState.lastFinishedAt = entry.finishedAt;
        currentDayRareBucketWarmRuntimeState.lastResult = {
          key,
          trigger: entry.trigger,
          error: entry.error
        };
        console.error(
          `[RareWarm] Failed ${entry.examSpec.exam_id} ${entry.level} ${entry.mode} ${entry.dateYmd}:`,
          error?.message || error
        );
      })
      .finally(() => {
        currentDayRareBucketWarmRuntimeState.activeCount = Math.max(
          0,
          currentDayRareBucketWarmRuntimeState.activeCount - 1
        );
        pumpCurrentDayRareBucketWarmQueue();
      });
  }
}

function scheduleCurrentDayRareBucketWarmup(params = {}) {
  const {
    snapshotId,
    examSpec,
    level,
    mode,
    dateYmd,
    trigger = 'ensure-pool-snapshot'
  } = params;

  if (!snapshotId || !examSpec || !shouldScheduleCurrentDayRareBucketWarmup(dateYmd)) {
    return null;
  }

  const key = buildCurrentDayRareBucketWarmKey(examSpec, level, mode, dateYmd);
  const existing = currentDayRareBucketWarmRuntimeState.entries.get(key);
  if (
    existing &&
    existing.snapshotId === snapshotId &&
    ['scheduled', 'running', 'completed'].includes(existing.status)
  ) {
    return existing;
  }

  const entry = {
    key,
    snapshotId,
    examSpec: cloneJson(examSpec),
    level: String(level || examSpec?.level || '').toUpperCase(),
    mode: String(mode || '').toLowerCase(),
    dateYmd: String(dateYmd || ''),
    trigger,
    status: 'scheduled',
    scheduledAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    result: null,
    error: null
  };

  currentDayRareBucketWarmRuntimeState.entries.set(key, entry);
  currentDayRareBucketWarmRuntimeState.queue.push(key);
  currentDayRareBucketWarmRuntimeState.lastScheduledAt = entry.scheduledAt;

  console.log(`[RareWarm] Scheduled ${entry.examSpec.exam_id} ${entry.level} ${entry.mode} ${entry.dateYmd} via ${trigger}`);
  pumpCurrentDayRareBucketWarmQueue();
  return entry;
}

function summarizeCurrentDayRareBucketWarmState(limit = 10) {
  const entries = Array.from(currentDayRareBucketWarmRuntimeState.entries.values())
    .sort((left, right) => String(right.scheduledAt || '').localeCompare(String(left.scheduledAt || '')))
    .slice(0, limit)
    .map((entry) => ({
      key: entry.key,
      level: entry.level,
      mode: entry.mode,
      dateYmd: entry.dateYmd,
      trigger: entry.trigger,
      status: entry.status,
      scheduledAt: entry.scheduledAt,
      startedAt: entry.startedAt,
      finishedAt: entry.finishedAt,
      result: entry.result
        ? {
          copied: entry.result.copied,
          generated: entry.result.generated,
          bucketsProcessed: entry.result.bucketsProcessed,
          durationMs: entry.result.durationMs
        }
        : null,
      error: entry.error || null
    }));

  return {
    enabled: CURRENT_DAY_RARE_BUCKET_WARM_ENABLED,
    onStartup: CURRENT_DAY_RARE_BUCKET_WARM_ON_STARTUP,
    targetPerBucket: CURRENT_DAY_RARE_BUCKET_WARM_TARGET_PER_BUCKET,
    concurrency: CURRENT_DAY_RARE_BUCKET_WARM_CONCURRENCY,
    activeCount: currentDayRareBucketWarmRuntimeState.activeCount,
    queuedCount: currentDayRareBucketWarmRuntimeState.queue.length,
    lastScheduledAt: currentDayRareBucketWarmRuntimeState.lastScheduledAt,
    lastFinishedAt: currentDayRareBucketWarmRuntimeState.lastFinishedAt,
    lastResult: currentDayRareBucketWarmRuntimeState.lastResult,
    entries
  };
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
    const validateMondaiChunkResult = buildMondaiChunkValidator(mondaiBatch, examSpec, mode);

    try {
      const generationRunConfig = getMondaiGenerationRunConfig(mondaiBatch);
      const generation = await runJsonTask({
    task: 'generate',
    prompt,
    validateResult: validateMondaiChunkResult,
    buildRepairPrompt: (context) => buildMondaiChunkRepairPrompt({
      ...context,
      examSpec,
      mode,
      mondaiBatch
    }),
    maxTokens: GENERATE_MAX_TOKENS,
    temperature: generationRunConfig.temperature,
    preferredProviders: generationRunConfig.preferredProviders,
    preferredStageNames: generationRunConfig.preferredStageNames
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

  const prioritizedBuckets = sortBucketsForWarmup(buckets);

  // Process up to maxBuckets
  for (const bucket of prioritizedBuckets) {
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

async function publishBlueprintExam(params) {
  const {
    examSpec,
    level,
    mode,
    variantKey,
    bankDateYmd,
    setNo,
    snapshotId,
    blueprint
  } = params;
  const title = buildPublishedExamTitle({ level, mode, variantKey, setNo, bankDateYmd });
  const description = buildPublishedExamDescription({ level, mode, variantKey, bankDateYmd });
  const expiresAt = new Date(`${addDaysToDateYmd(bankDateYmd, DAILY_BANK_RETENTION_DAYS)}T23:59:59.999Z`).toISOString();
  const blueprintHashes = extractUniqueMondaiHashes(blueprint);
  const meta = {
    variant_key: variantKey,
    bank_date_ymd: bankDateYmd,
    set_no: setNo,
    source_snapshot_id: snapshotId,
    mondai_hashes: blueprintHashes,
    generated_at: new Date().toISOString()
  };

  const publishedRes = await db.query(`
    INSERT INTO published_exams (
      exam_id,
      level,
      mode,
      variant_key,
      set_no,
      bank_date_ymd,
      title,
      description,
      is_active,
      blueprint,
      meta,
      snapshot_id,
      expires_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9::jsonb, $10::jsonb, $11, $12)
    ON CONFLICT (exam_id, level, mode, variant_key, bank_date_ymd, set_no)
    DO UPDATE SET
      title = EXCLUDED.title,
      description = EXCLUDED.description,
      is_active = true,
      blueprint = EXCLUDED.blueprint,
      meta = EXCLUDED.meta,
      snapshot_id = EXCLUDED.snapshot_id,
      expires_at = EXCLUDED.expires_at
    RETURNING id
  `, [
    examSpec.exam_id,
    level,
    mode,
    variantKey,
    setNo,
    bankDateYmd,
    title,
    description,
    JSON.stringify(blueprint),
    JSON.stringify(meta),
    snapshotId,
    expiresAt
  ]);

  const publishedExamId = publishedRes.rows?.[0]?.id;
  if (!publishedExamId) {
    throw new Error(`Failed to publish daily bank exam ${examSpec.exam_id} ${level} ${mode} ${variantKey} #${setNo}`);
  }

  await db.query('DELETE FROM published_exam_parts WHERE published_exam_id = $1', [publishedExamId]);
  for (const group of ensureArray(blueprint?.groups)) {
    const hashes = ensureArray(group?.mondai_slots)
      .map((slot) => slot?.mondai_hash)
      .filter(Boolean);
    await db.query(`
      INSERT INTO published_exam_parts (published_exam_id, group_id, mondai_hashes, meta)
      VALUES ($1, $2, $3::jsonb, $4::jsonb)
    `, [
      publishedExamId,
      group.group_id,
      JSON.stringify(hashes),
      JSON.stringify({
        variant_key: variantKey,
        title_vi: group.title_vi || group.group_id,
        bank_date_ymd: bankDateYmd
      })
    ]);
  }

  return {
    id: publishedExamId,
    title,
    blueprintHashes
  };
}

async function recordPublishedExamServed(options) {
  const { userId, publishedExamId, instanceKey } = options || {};
  if (!userId || !publishedExamId) return;

  await db.query(`
    INSERT INTO user_published_exam_history (
      user_id,
      published_exam_id,
      first_served_at,
      last_served_at,
      serve_count,
      last_instance_key
    )
    VALUES ($1, $2, NOW(), NOW(), 1, $3)
    ON CONFLICT (user_id, published_exam_id)
    DO UPDATE SET
      last_served_at = CASE
        WHEN user_published_exam_history.last_instance_key IS DISTINCT FROM EXCLUDED.last_instance_key THEN NOW()
        ELSE user_published_exam_history.last_served_at
      END,
      serve_count = CASE
        WHEN user_published_exam_history.last_instance_key IS DISTINCT FROM EXCLUDED.last_instance_key THEN user_published_exam_history.serve_count + 1
        ELSE user_published_exam_history.serve_count
      END,
      last_instance_key = CASE
        WHEN user_published_exam_history.last_instance_key IS DISTINCT FROM EXCLUDED.last_instance_key THEN EXCLUDED.last_instance_key
        ELSE user_published_exam_history.last_instance_key
      END
  `, [userId, publishedExamId, instanceKey || null]);
}

async function selectPublishedExamBlueprint(options = {}) {
  const {
    userId,
    examId,
    level,
    mode,
    variantKey,
    fallbackVariantKeys = [],
    requestedMondaiIds = null,
    allowRepeat = false
  } = options;

  const normalizedRequestedIds = normalizeMondaiIdList(requestedMondaiIds, 64);
  const candidateVariantKeys = uniqueStrings([
    ...(variantKey && !String(variantKey).startsWith('custom:') ? [variantKey] : []),
    ...ensureArray(fallbackVariantKeys),
    ...inferPublishedVariantCandidates(normalizedRequestedIds)
  ], DAILY_BANK_VARIANTS.length + 2).filter((key) => key === 'full' || DAILY_BANK_VARIANT_MAP.has(key));

  if (!examId || !level || !mode || candidateVariantKeys.length === 0) {
    return null;
  }

  const candidatesRes = await db.query(`
    SELECT pe.*
    FROM published_exams pe
    WHERE pe.exam_id = $1
      AND pe.level = $2
      AND pe.mode = $3
      AND pe.variant_key = ANY($4::text[])
      AND pe.is_active = true
      AND (pe.expires_at IS NULL OR pe.expires_at > NOW())
      AND pe.bank_date_ymd >= $5
    ORDER BY pe.bank_date_ymd DESC, pe.set_no ASC
    LIMIT 60
  `, [
    examId,
    level,
    mode,
    candidateVariantKeys,
    addDaysToDateYmd(formatDateYmd(), -DAILY_BANK_RETENTION_DAYS)
  ]);

  const variantPriority = new Map(candidateVariantKeys.map((key, index) => [key, index]));
  const candidates = ensureArray(candidatesRes.rows)
    .map((row) => {
      const sourceBlueprint = parseJsonb(row.blueprint, null);
      if (!sourceBlueprint) return null;

      const trimmedBlueprint = normalizedRequestedIds.length > 0
        ? filterBlueprintByMondaiIds(sourceBlueprint, normalizedRequestedIds)
        : cloneJson(sourceBlueprint);
      if (!trimmedBlueprint) return null;

      if (!trimmedBlueprint.meta) trimmedBlueprint.meta = {};
      trimmedBlueprint.meta.variant_key = variantKey || row.variant_key || trimmedBlueprint.meta.variant_key || null;
      trimmedBlueprint.meta.source_variant_key = row.variant_key || trimmedBlueprint.meta.source_variant_key || null;
      if (normalizedRequestedIds.length > 0) {
        trimmedBlueprint.meta.requested_mondai_ids = normalizedRequestedIds;
      }

      return {
        id: row.id,
        exam_id: row.exam_id,
        level: row.level,
        mode: row.mode,
        variant_key: row.variant_key,
        set_no: row.set_no,
        bank_date_ymd: row.bank_date_ymd,
        blueprint: trimmedBlueprint,
        meta: parseJsonb(row.meta, {})
      };
    })
    .filter(Boolean);

  if (candidates.length === 0) return null;

  const candidateHashSet = new Set(
    candidates.flatMap((candidate) => extractUniqueMondaiHashes(candidate.blueprint))
  );
  const allCandidateHashes = Array.from(candidateHashSet);

  const [seenExamRes, seenHashRes] = await Promise.all([
    userId ? db.query(
      'SELECT published_exam_id, serve_count FROM user_published_exam_history WHERE user_id = $1 AND published_exam_id = ANY($2::uuid[])',
      [userId, candidates.map((candidate) => candidate.id)]
    ) : Promise.resolve({ rows: [] }),
    userId && allCandidateHashes.length > 0 ? db.query(
      'SELECT mondai_hash FROM user_mondai_history WHERE user_id = $1 AND mondai_hash = ANY($2::text[])',
      [userId, allCandidateHashes]
    ) : Promise.resolve({ rows: [] })
  ]);

  const seenExamCounts = new Map(
    ensureArray(seenExamRes.rows).map((row) => [row.published_exam_id, Number(row.serve_count || 0)])
  );
  const seenHashSet = new Set(ensureArray(seenHashRes.rows).map((row) => row.mondai_hash));

  const ranked = candidates.map((candidate) => {
    const hashes = extractUniqueMondaiHashes(candidate.blueprint);
    const overlapCount = hashes.filter((hash) => seenHashSet.has(hash)).length;
    const servedCount = Number(seenExamCounts.get(candidate.id) || 0);
    return {
      ...candidate,
      hashes,
      overlapCount,
      servedCount,
      variantPriority: variantPriority.has(candidate.variant_key)
        ? variantPriority.get(candidate.variant_key)
        : Number.MAX_SAFE_INTEGER
    };
  }).sort((left, right) => {
    if (left.variantPriority !== right.variantPriority) return left.variantPriority - right.variantPriority;
    if (left.servedCount !== right.servedCount) return left.servedCount - right.servedCount;
    if (left.overlapCount !== right.overlapCount) return left.overlapCount - right.overlapCount;
    if (left.bank_date_ymd !== right.bank_date_ymd) return String(right.bank_date_ymd).localeCompare(String(left.bank_date_ymd));
    return Number(left.set_no || 0) - Number(right.set_no || 0);
  });

  const unseenExact = allowRepeat ? ranked : ranked.filter((candidate) => candidate.servedCount === 0);
  const chosen = (unseenExact.length > 0 ? unseenExact : ranked)[0];
  return chosen || null;
}
async function cleanupExpiredDailyBankData(options = {}) {
  const keepDays = Math.max(1, Number.parseInt(options.keepDays || String(DAILY_BANK_RETENTION_DAYS), 10));
  const cutoffYmd = addDaysToDateYmd(formatDateYmd(), -keepDays);

  await db.query(
    `DELETE FROM published_exams
     WHERE bank_date_ymd IS NOT NULL
       AND bank_date_ymd < $1`,
    [cutoffYmd]
  );

  await db.query(
    `DELETE FROM pool_snapshot_items
     WHERE snapshot_id IN (
       SELECT id FROM pool_snapshots
       WHERE date_ymd < $1
          OR (expires_at IS NOT NULL AND expires_at < NOW())
     )`,
    [cutoffYmd]
  );

  await db.query(
    `DELETE FROM pool_snapshots
     WHERE date_ymd < $1
        OR (expires_at IS NOT NULL AND expires_at < NOW())`,
    [cutoffYmd]
  );

  return { cutoffYmd, keepDays };
}

async function warmSnapshotForDailyBank(examSpec, level, mode, dateYmd) {
  const snapshotId = await ensurePoolSnapshot(examSpec, level, dateYmd, 'daily-bank', mode);
  if (!snapshotId) {
    throw new Error(`Failed to ensure snapshot for ${examSpec.exam_id} ${level} ${mode}`);
  }

  await bootstrapRareBucketsForSnapshot(snapshotId, examSpec, level, mode);

  const bucketCount = ensureArray(examSpec.groups).reduce(
    (sum, group) => sum + ensureArray(group?.mondai).filter((mondaiDef) => mondaiDef?.types?.[0]).length,
    0
  );

  const warmStats = await warmPool(snapshotId, examSpec, level, mode, dateYmd, {
    targetPerBucket: DAILY_BANK_TARGET_PER_BUCKET,
    maxBuckets: bucketCount,
    maxGenerateTotal: Math.max(
      DAILY_BANK_WARM_MAX_GENERATE_TOTAL,
      bucketCount * DAILY_BANK_TARGET_PER_BUCKET
    )
  });

  return { snapshotId, warmStats };
}

async function generateDailyBankVariant(params) {
  const {
    baseSpec,
    level,
    mode,
    variantKey,
    dateYmd,
    snapshotId
  } = params;

  const variantSpec = buildExamVariantSpec(baseSpec, variantKey);
  const reservedHashes = new Set();
  const published = [];

  for (let setNo = 1; setNo <= DAILY_BANK_SET_COUNT; setNo += 1) {
    const seed = crypto.createHash('sha256')
      .update(`${variantSpec.exam_id}|${level}|${mode}|${variantKey}|${dateYmd}|${setNo}`)
      .digest('hex');

    const { blueprint } = await buildExamBlueprint(
      variantSpec,
      level,
      mode,
      seed,
      setNo,
      'daily-bank',
      snapshotId,
      {
        allowRepeat: false,
        reservedHashes: Array.from(reservedHashes)
      }
    );

    if (!blueprint.meta) blueprint.meta = {};
    blueprint.meta.variant_key = variantKey;
    blueprint.meta.bank_date_ymd = dateYmd;
    blueprint.meta.prebuilt_bank = true;
    blueprint.meta.seed = seed;

    extractUniqueMondaiHashes(blueprint).forEach((hash) => reservedHashes.add(hash));
    published.push(await publishBlueprintExam({
      examSpec: variantSpec,
      level,
      mode,
      variantKey,
      bankDateYmd: dateYmd,
      setNo,
      snapshotId,
      blueprint
    }));
  }

  return {
    variantKey,
    publishedCount: published.length,
    publishedExamIds: published.map((entry) => entry.id)
  };
}

async function runDailyBankWorkflow(options = {}) {
  if (dailyBankRuntimeState.running) {
    return {
      ok: false,
      skipped: true,
      reason: 'already_running',
      lastRunDateYmd: dailyBankRuntimeState.lastRunDateYmd
    };
  }

  dailyBankRuntimeState.running = true;
  dailyBankRuntimeState.lastStartedAt = new Date().toISOString();

  const dateYmd = String(options.dateYmd || formatDateYmd());
  const levels = uniqueStrings(options.levels || DAILY_BANK_LEVELS, DAILY_BANK_LEVELS.length);
  const modes = uniqueStrings(options.modes || DAILY_BANK_MODES, DAILY_BANK_MODES.length);
  const variantKeys = uniqueStrings(
    options.variants || DAILY_BANK_VARIANTS.map((variant) => variant.key),
    DAILY_BANK_VARIANTS.length
  );
  const results = [];

  try {
    if (!(await db.initDb())) {
      throw new Error('DB unavailable');
    }

    for (const level of levels) {
      const baseSpec = await buildDailyBankExamSpec(level);

      for (const mode of modes) {
        const { snapshotId, warmStats } = await warmSnapshotForDailyBank(baseSpec, level, mode, dateYmd);
        const variantResults = [];

        for (const variantKey of variantKeys) {
          variantResults.push(await generateDailyBankVariant({
            baseSpec,
            level,
            mode,
            variantKey,
            dateYmd,
            snapshotId
          }));
        }

        results.push({
          level,
          mode,
          snapshotId,
          warmStats,
          variants: variantResults
        });
      }
    }

    await cleanupExpiredDailyBankData({ keepDays: DAILY_BANK_RETENTION_DAYS });

    const finalResult = {
      ok: true,
      dateYmd,
      levels,
      modes,
      variants: variantKeys,
      retentionDays: DAILY_BANK_RETENTION_DAYS,
      setCount: DAILY_BANK_SET_COUNT,
      targetPerBucket: DAILY_BANK_TARGET_PER_BUCKET,
      results
    };
    dailyBankRuntimeState.lastRunDateYmd = dateYmd;
    dailyBankRuntimeState.lastFinishedAt = new Date().toISOString();
    dailyBankRuntimeState.lastResult = finalResult;
    return finalResult;
  } finally {
    dailyBankRuntimeState.running = false;
  }
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

function getInitialMondaiBufferCount(group) {
  const totalSlots = Array.isArray(group?.mondai_slots) ? group.mondai_slots.length : 0;
  if (totalSlots <= 0) return 2;
  if (totalSlots <= 4) return totalSlots;
  if (totalSlots <= 6) return 4;
  return 3;
}

function getInitialReadySlotIds(group) {
  const targetCount = getInitialMondaiBufferCount(group);
  const slots = Array.isArray(group?.mondai_slots) ? group.mondai_slots : [];
  const readyPrefix = [];

  for (const slot of slots) {
    if (!slot?.slot_id || !slot?.mondai_hash) break;
    readyPrefix.push(slot.slot_id);
    if (readyPrefix.length >= targetCount) break;
  }

  return readyPrefix;
}

function getCriticalStartPendingSlots(blueprint, pendingSlots) {
  const firstGroup = ensureArray(blueprint?.groups)[0];
  if (!firstGroup) return [];

  const initialBufferCount = getInitialMondaiBufferCount(firstGroup);
  return ensureArray(pendingSlots).filter((entry) => {
    const groupId = entry?.group?.group_id;
    const slotOrdinal = Number(entry?.slot?.slot_ordinal || 0);
    return groupId === firstGroup.group_id && slotOrdinal < initialBufferCount;
  });
}

function sortPendingSlotsForBackgroundPrefetch(blueprint, pendingSlots, excludedSlotIds = []) {
  const groups = ensureArray(blueprint?.groups);
  const groupIndexMap = new Map(groups.map((group, index) => [group?.group_id, index]));
  const excluded = new Set(ensureArray(excludedSlotIds).filter(Boolean));
  const groupCount = Math.max(groups.length, 1);

  return ensureArray(pendingSlots)
    .filter((entry) => !excluded.has(entry?.slot?.slot_id))
    .slice()
    .sort((left, right) => {
      const leftGroupIndex = groupIndexMap.has(left?.group?.group_id)
        ? groupIndexMap.get(left.group.group_id)
        : Number.MAX_SAFE_INTEGER;
      const rightGroupIndex = groupIndexMap.has(right?.group?.group_id)
        ? groupIndexMap.get(right.group.group_id)
        : Number.MAX_SAFE_INTEGER;

      const leftGroup = groups[leftGroupIndex] || left?.group || null;
      const rightGroup = groups[rightGroupIndex] || right?.group || null;
      const leftInitial = Number(left?.slot?.slot_ordinal || 0) < getInitialMondaiBufferCount(leftGroup);
      const rightInitial = Number(right?.slot?.slot_ordinal || 0) < getInitialMondaiBufferCount(rightGroup);
      const leftTier = leftInitial ? leftGroupIndex : leftGroupIndex + groupCount;
      const rightTier = rightInitial ? rightGroupIndex : rightGroupIndex + groupCount;

      if (leftTier !== rightTier) return leftTier - rightTier;
      if (leftGroupIndex !== rightGroupIndex) return leftGroupIndex - rightGroupIndex;
      return Number(left?.slot?.slot_ordinal || 0) - Number(right?.slot?.slot_ordinal || 0);
    });
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
    allowRepeat,
    learnerHints = null,
    concurrencyLimit = getEffectiveOnDemandRequestConcurrency()
  } = params;

  if (!Array.isArray(pendingSlots) || pendingSlots.length === 0) {
    return;
  }

  const groupedByGroup = new Map();
  for (const pending of pendingSlots) {
    const groupKey = pending?.group?.group_id || 'default';
    if (!groupedByGroup.has(groupKey)) groupedByGroup.set(groupKey, []);
    groupedByGroup.get(groupKey).push({ ...pending, snapshotId });
  }

  const generationTasks = [];
  for (const entries of groupedByGroup.values()) {
    const batches = chunkArray(entries, BLUEPRINT_ON_DEMAND_BATCH_SIZE);
    for (const batchEntries of batches) {
      generationTasks.push(async () => {
        try {
          const batchLabel = batchEntries.map((entry) => entry.slot?.mondai_id || entry.slot?.slot_id).join(', ');
          console.log(`[Blueprint] Triggering on-demand generation batch (${batchEntries.length} mondai): ${batchLabel}`);
          const generatedAssignments = await generateMondaiForSlotBatch({
            examSpec,
            level,
            mode,
            group: batchEntries[0].group,
            batchEntries,
            learnerHints
          });
          return { ok: true, batchEntries, generatedAssignments };
        } catch (error) {
          return { ok: false, batchEntries, error };
        }
      });
    }
  }

  const generationResults = await runTasksWithConcurrency(
    generationTasks,
    concurrencyLimit
  );

  for (const result of generationResults) {
    if (!result?.ok || !Array.isArray(result.generatedAssignments)) continue;

    for (const assignment of result.generatedAssignments) {
      const hash = assignment?.hash;
      const slot = assignment?.entry?.slot;
      if (!hash || !slot || usedHashes.has(hash)) continue;

      usedHashes.add(hash);
      slot.mondai_hash = hash;
      slot.status = 'ready';
    }
  }

  for (const result of generationResults) {
    if (result?.ok) continue;
    if (isTemporaryUnavailableError(result?.error)) {
      throw result.error;
    }

    const failedLabels = (result?.batchEntries || [])
      .map((entry) => entry?.slot?.bucket_key || entry?.slot?.slot_id || 'unknown')
      .join(', ');
    console.warn(`Failed to generate pending slots ${failedLabels}:`, result?.error?.message || result?.error);
    throw createTemporaryUnavailableError(
      result?.error || new Error(`Failed to generate pending slots ${failedLabels || 'unknown'}`)
    );
  }

  for (const pending of pendingSlots) {
    const { mondaiDef, slot } = pending;
    if (slot._failed || slot?.mondai_hash) continue;

    try {
      const hash = await sampleMondaiFromBucket(
        snapshotId,
        slot.bucket_key,
        rng,
        Array.from(usedHashes),
        {
          userId,
          allowRepeat,
          strictFresh: !allowRepeat && !!userId,
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

  const {
    userId = null,
    allowRepeat = false,
    learnerHints = null,
    reservedHashes = []
  } = selectionOptions;

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
      exam_id: examSpec.exam_id,
      display_name_vi: examSpec.display_name_vi || String(examSpec.exam_id || 'JLPT').toUpperCase(),
      language: examSpec.language || 'ja-JP',
      modes: examSpec.modes || DEFAULT_MODES,
      level,
      mode,
      plan,
      seed,
      set_no: setNo,
      snapshot_id: snapshotId,
      date_ymd: new Date().toISOString().split('T')[0],
      generated_at: new Date().toISOString(),
      learner_hints: learnerHints || null
    }
  };



  const modeConfig = examSpec.modes?.[mode] || DEFAULT_MODES[mode] || DEFAULT_MODES.official || { question_scale: 1.0, time_scale: 1.0 };
  const qScale = modeConfig.question_scale || 1.0;

  // Track used hashes to avoid duplicates across exam
  const usedHashes = new Set(ensureArray(reservedHashes).filter(Boolean));
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
        slot_ordinal: groupBlueprint.mondai_slots.length,
        bucket_key: bucketKey,
        mondai_id: mondaiDef.mondai_id,
        title_vi: mondaiDef.title_vi,
        types: Array.isArray(mondaiDef.types) ? mondaiDef.types : [mondaiDef.types].filter(Boolean),
        type: mondaiDef.types[0],
        count_official: mondaiDef.count_official,
        question_count: targetCount,
        estimated_seconds: mondaiDef.estimated_seconds || null,
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
          {
            userId,
            allowRepeat,
            strictFresh: !allowRepeat && !!userId,
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
        pendingSlots.push({ group, mondaiDef, slot });
      }
    }
    blueprint.groups.push(groupBlueprint);
  }

  const criticalPendingSlots = getCriticalStartPendingSlots(blueprint, pendingSlots);
  const criticalSlotIds = new Set(criticalPendingSlots.map((entry) => entry?.slot?.slot_id).filter(Boolean));
  const backgroundPendingSlots = sortPendingSlotsForBackgroundPrefetch(
    blueprint,
    pendingSlots,
    Array.from(criticalSlotIds)
  );

  let startPrefetchPromise = null;
  if (backgroundPendingSlots.length > 0) {
    backgroundPendingSlots.forEach(({ slot }) => {
      if (!slot?.mondai_hash) slot.status = 'prefetching';
    });

    startPrefetchPromise = hydratePendingBlueprintSlots({
      pendingSlots: backgroundPendingSlots,
      examSpec,
      level,
      mode,
      snapshotId,
      plan,
      rng,
      usedHashes,
      userId,
      allowRepeat,
      learnerHints,
      concurrencyLimit: 1
    }).then(() => {
      let changed = false;
      backgroundPendingSlots.forEach(({ slot }) => {
        if (slot?.mondai_hash) {
          slot.status = 'ready';
          changed = true;
          return;
        }
        slot.status = 'deferred';
      });
      return changed;
    }).catch((error) => {
      console.warn('[Blueprint] Start prefetch wave failed:', error?.message || error);
      backgroundPendingSlots.forEach(({ slot }) => {
        if (!slot?.mondai_hash) slot.status = 'deferred';
      });
      return false;
    });
  }

  await hydratePendingBlueprintSlots({
    pendingSlots: criticalPendingSlots,
    examSpec,
    level,
    mode,
    snapshotId,
    plan,
    rng,
    usedHashes,
    userId,
    allowRepeat,
    learnerHints
  });

  criticalPendingSlots.forEach(({ slot }) => {
    if (slot?.mondai_hash) slot.status = 'ready';
  });

  const missingSlots = blueprint.groups.flatMap((group) =>
    (group.mondai_slots || []).filter((slot) =>
      !slot.mondai_hash &&
      slot.status !== 'deferred' &&
      slot.status !== 'prefetching'
    )
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

  return { blueprint, startPrefetchPromise };
}

async function sampleMondaiFromBucket(snapshotId, bucketKey, rng, usedHashes, options = {}) {
  return selectMondaiFromBucket(db, {
    snapshotId,
    bucketKey,
    rng,
    usedHashes,
    userId: options.userId || null,
    allowRepeat: !!options.allowRepeat,
    strictFresh: !!options.strictFresh,
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

const READING_TYPE_SET = new Set(['reading_short', 'reading_mid', 'reading_long', 'reading_compare', 'reading_info']);
const LISTENING_TYPES = ['listening_task', 'listening_main', 'listening_general', 'listening_quick', 'listening_integrated', 'listening_dialogue', 'listening_mono', 'listen_respond', 'listen_integration', 'listen_task'];
const LISTENING_TYPE_SET = new Set(LISTENING_TYPES);
const PASSAGE_REQUIRED_TYPE_SET = new Set(['grammar_passage', ...READING_TYPE_SET]);
const PASSAGE_FORBIDDEN_TYPE_SET = new Set(['kanji', 'vocab_context', 'vocab_synonym', 'vocab_usage', 'grammar_select', 'grammar_order', ...LISTENING_TYPES]);
const ORDER_PATTERN_RE = /^\s*(?:[1-4][\-\s,>]{1,3}){3}[1-4]\s*$/;

function containsForbiddenPromptMarkup(text) {
  const value = String(text || '');
  return /<\/?[a-z][^>]*>/i.test(value) || /\*\*|__/.test(value);
}

function looksJapaneseHeavyText(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  const japaneseChars = (value.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/g) || []).length;
  return japaneseChars >= 6 && (japaneseChars / Math.max(value.length, 1)) >= 0.2;
}

function buildMondaiInstructionsFallback(expectedDef) {
  const expectedTypes = ensureArray(expectedDef?.types);
  if (expectedTypes.some((type) => LISTENING_TYPE_SET.has(type))) {
    return 'Nghe nội dung rồi chọn đáp án đúng nhất.';
  }
  if (
    expectedTypes.some((type) => READING_TYPE_SET.has(type)) ||
    expectedTypes.includes('grammar_passage')
  ) {
    return 'Đọc đoạn văn rồi chọn đáp án đúng nhất.';
  }
  return 'Chọn đáp án đúng nhất.';
}

function buildExplainBriefFallback(expectedPrimaryType, expectedTypes = []) {
  if (ensureArray(expectedTypes).some((type) => LISTENING_TYPE_SET.has(type))) {
    return 'Nghe kỹ từ khóa trong lời thoại rồi đối chiếu với đáp án phù hợp nhất.';
  }
  if (ensureArray(expectedTypes).some((type) => READING_TYPE_SET.has(type))) {
    return 'Dựa vào chi tiết trong đoạn văn để loại trừ đáp án không khớp.';
  }
  if (expectedPrimaryType === 'grammar_order') {
    return 'Sắp xếp các mảnh theo trật tự tự nhiên rồi đối chiếu với đáp án.';
  }
  if (expectedPrimaryType === 'grammar_passage' || expectedPrimaryType === 'grammar_select') {
    return 'Xác định điểm ngữ pháp cần dùng rồi chọn mẫu phù hợp với ngữ cảnh.';
  }
  if (expectedPrimaryType === 'kanji') {
    return 'Nhìn vào chữ được đánh dấu rồi chọn cách đọc đúng.';
  }
  if (String(expectedPrimaryType || '').startsWith('vocab')) {
    return 'Dựa vào ngữ cảnh và sắc thái nghĩa để chọn từ phù hợp nhất.';
  }
  return 'Dựa vào ngữ cảnh và loại câu hỏi để chọn đáp án phù hợp nhất.';
}

function buildQuestionTagsFallback(expectedPrimaryType, expectedTypes = []) {
  const tags = [];
  if (ensureArray(expectedTypes).some((type) => LISTENING_TYPE_SET.has(type))) tags.push('listening');
  if (ensureArray(expectedTypes).some((type) => READING_TYPE_SET.has(type))) tags.push('reading');
  if (expectedPrimaryType) tags.push(String(expectedPrimaryType));
  if (tags.length === 0 && ensureArray(expectedTypes).length > 0) {
    tags.push(String(expectedTypes[0]));
  }
  if (tags.length === 0) tags.push('practice');
  return uniqueStrings(tags, 3);
}

function normalizeMondaiBeforeValidation(mondai, expectedDef) {
  if (!mondai || typeof mondai !== 'object') return;

  const expectedTypes = ensureArray(expectedDef?.types);
  const primaryType = expectedTypes[0] || null;
  const isListening = expectedTypes.some((type) => LISTENING_TYPE_SET.has(type));

  if (!mondai.title_vi || looksJapaneseHeavyText(mondai.title_vi)) {
    mondai.title_vi = String(expectedDef?.title_vi || mondai.title_vi || expectedDef?.mondai_id || 'Bài tập');
  }
  if (!mondai.instructions_vi || looksJapaneseHeavyText(mondai.instructions_vi)) {
    mondai.instructions_vi = buildMondaiInstructionsFallback(expectedDef);
  }

  if (isListening) {
    const passageText = String(mondai?.passage?.text || '').trim();
    const scriptText = String(mondai?.media?.script_text || '').trim();
    if (!scriptText && passageText) {
      mondai.media = { ...(mondai.media || {}), script_text: passageText };
    }
    if (mondai?.passage && typeof mondai.passage === 'object') {
      delete mondai.passage.text;
      if (!String(mondai.passage.title || '').trim()) {
        delete mondai.passage;
      }
    }
  }

  ensureArray(mondai.items).forEach((item) => {
    if (!item || typeof item !== 'object') return;
    if (isListening && item.media) {
      delete item.media;
    }
    if (!item.explain_brief || looksJapaneseHeavyText(item.explain_brief)) {
      item.explain_brief = buildExplainBriefFallback(primaryType, expectedTypes);
    }
  });
}
function validateQuestionItem(item, options = {}) {
  const errors = [];
  const expectedTypes = Array.isArray(options.expectedTypes) ? options.expectedTypes : [];
  const expectedPrimaryType = options.expectedPrimaryType || expectedTypes[0] || null;
  if (!item || typeof item !== 'object') return ['item_not_object'];
  if (item.id !== undefined && typeof item.id !== 'string') errors.push('id_invalid');
  if (!item.type || typeof item.type !== 'string') errors.push('missing_type');
  if (item.type && expectedTypes.length > 0 && !expectedTypes.includes(item.type)) errors.push('type_mismatch');
  if (!item.prompt || typeof item.prompt !== 'string') errors.push('missing_prompt');
  if (item.prompt && containsForbiddenPromptMarkup(item.prompt)) errors.push('prompt_has_forbidden_markup');
  if (!Array.isArray(item.choices) || item.choices.length !== 4) errors.push('choices_not_4');
  if (Array.isArray(item.choices)) {
    const normalizedChoices = item.choices.map((choice) => String(choice || '').trim().toLowerCase());
    for (let i = 0; i < item.choices.length; i++) {
      if (typeof item.choices[i] !== 'string' || item.choices[i].trim() === '') {
        errors.push(`choice_${i}_invalid`);
      }
      if (item.choices[i] === 'A' || item.choices[i] === 'B' || item.choices[i] === 'C' || item.choices[i] === 'D') {
        errors.push('choices_are_letters');
        break;
      }
      if (containsForbiddenPromptMarkup(item.choices[i])) {
        errors.push(`choice_${i}_forbidden_markup`);
      }
    }
    if (new Set(normalizedChoices).size !== normalizedChoices.length) errors.push('choices_duplicate');
  }
  if (typeof item.answer_index !== 'number' || item.answer_index < 0 || item.answer_index > 3) errors.push('answer_index_invalid');
  if (!item.explain_brief || typeof item.explain_brief !== 'string' || looksJapaneseHeavyText(item.explain_brief)) {
    item.explain_brief = buildExplainBriefFallback(expectedPrimaryType, expectedTypes);
  }
  if (!item.explain_brief || typeof item.explain_brief !== 'string') errors.push('missing_explain_brief');
  if (item.explain_brief && looksJapaneseHeavyText(item.explain_brief)) errors.push('explain_not_vietnamese');
  if (!Array.isArray(item.tags) || item.tags.length === 0) {
    item.tags = buildQuestionTagsFallback(expectedPrimaryType, expectedTypes);
  }
  if (!Array.isArray(item.tags) || item.tags.length === 0) errors.push('missing_tags');
  if (item.media && typeof item.media !== 'object') errors.push('media_invalid');
  if (expectedPrimaryType === 'kanji' && item.prompt && !/\[\[[^\]]+\]\]/.test(item.prompt)) errors.push('kanji_missing_highlight');
  if (expectedPrimaryType === 'grammar_order') {
    if (item.prompt && !(/[1-4][\.\)]/.test(item.prompt) || /①|②|③|④/.test(item.prompt))) errors.push('grammar_order_missing_fragments');
    if (Array.isArray(item.choices) && item.choices.some((choice) => !ORDER_PATTERN_RE.test(choice))) errors.push('grammar_order_choices_invalid');
  }
  if ((expectedPrimaryType === 'vocab_synonym' || expectedPrimaryType === 'vocab_usage') && item.prompt && !/\[\[[^\]]+\]\]/.test(item.prompt)) {
    errors.push('vocab_target_missing_highlight');
  }
  return errors;
}

function buildMondaiChunkValidator(mondaiToGenerate, examSpec, mode) {
  const expectedDefs = Array.isArray(mondaiToGenerate) ? mondaiToGenerate : [];

  return function validateMondaiChunkResult(result) {
    const errors = [];
    if (!result || typeof result !== 'object') return ['chunk_not_object'];
    if (!Array.isArray(result.mondai) || result.mondai.length === 0) errors.push('missing_mondai');
    if (!Array.isArray(result.mondai)) return errors;
    if (expectedDefs.length > 0 && result.mondai.length < expectedDefs.length) {
      errors.push('mondai_count_too_small');
    }

    const modeConfig = examSpec?.modes?.[mode] || DEFAULT_MODES[mode] || DEFAULT_MODES.official || { question_scale: 1 };

    expectedDefs.forEach((expectedDef, expectedIndex) => {
      const mondai = result.mondai.find((entry) =>
        String(entry?.mondai_id || '').toUpperCase() === String(expectedDef?.mondai_id || '').toUpperCase()
      ) || result.mondai[expectedIndex];

      if (!mondai || typeof mondai !== 'object') {
        errors.push(`mondai_${expectedIndex}_missing`);
        return;
      }

      const primaryType = expectedDef?.types?.[0] || null;
      const expectedQuestionCount = Math.max(1, Math.round((expectedDef?.count_official || 1) * (modeConfig.question_scale || 1)));
      const isReading = expectedDef?.types?.some((type) => READING_TYPE_SET.has(type));
      const isListening = expectedDef?.types?.some((type) => LISTENING_TYPE_SET.has(type));
      const requiresPassage = expectedDef?.types?.some((type) => PASSAGE_REQUIRED_TYPE_SET.has(type));
      const forbidsPassage = expectedDef?.types?.every((type) => PASSAGE_FORBIDDEN_TYPE_SET.has(type));

      normalizeMondaiBeforeValidation(mondai, expectedDef);

      if (!mondai.mondai_id || typeof mondai.mondai_id !== 'string') errors.push(`mondai_${expectedIndex}_missing_mondai_id`);
      if (!mondai.title_vi || typeof mondai.title_vi !== 'string') errors.push(`mondai_${expectedIndex}_missing_title_vi`);
      if (mondai.title_vi && looksJapaneseHeavyText(mondai.title_vi)) errors.push(`mondai_${expectedIndex}_title_not_vietnamese`);
      if (!mondai.instructions_vi || typeof mondai.instructions_vi !== 'string') errors.push(`mondai_${expectedIndex}_missing_instructions_vi`);
      if (mondai.instructions_vi && looksJapaneseHeavyText(mondai.instructions_vi)) errors.push(`mondai_${expectedIndex}_instructions_not_vietnamese`);
      if (!Array.isArray(mondai.items) || mondai.items.length === 0) errors.push(`mondai_${expectedIndex}_missing_items`);
      if (Array.isArray(mondai.items) && mondai.items.length !== expectedQuestionCount) {
        errors.push(`mondai_${expectedIndex}_question_count_mismatch`);
      }

      const hasPassageText = !!String(mondai?.passage?.text || '').trim();
      const hasScriptText = !!String(mondai?.media?.script_text || '').trim();

      if (requiresPassage && !hasPassageText) errors.push(`mondai_${expectedIndex}_missing_passage`);
      if (forbidsPassage && hasPassageText) errors.push(`mondai_${expectedIndex}_unexpected_passage`);
      if (isListening && !hasScriptText) errors.push(`mondai_${expectedIndex}_missing_script_text`);
      if (!isListening && hasScriptText) errors.push(`mondai_${expectedIndex}_unexpected_script_text`);
      if (hasPassageText && containsForbiddenPromptMarkup(mondai.passage.text)) errors.push(`mondai_${expectedIndex}_passage_forbidden_markup`);
      if (hasScriptText && containsForbiddenPromptMarkup(mondai.media.script_text)) errors.push(`mondai_${expectedIndex}_script_forbidden_markup`);

      if (Array.isArray(mondai.items)) {
        mondai.items.forEach((item, itemIndex) => {
          const itemErrors = validateQuestionItem(item, {
            expectedTypes: expectedDef?.types || [],
            expectedPrimaryType: primaryType
          });
          if (isListening && item?.media) itemErrors.push('listening_item_media_forbidden');
          if (itemErrors.length > 0) {
            errors.push(`mondai_${expectedIndex}_item_${itemIndex}:${itemErrors.join(',')}`);
          }
        });
      }

      if (isReading && Array.isArray(mondai.items) && mondai.items.some((item) => item?.type && !READING_TYPE_SET.has(item.type))) {
        errors.push(`mondai_${expectedIndex}_reading_type_mismatch`);
      }
    });

    return errors;
  };
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

function buildDetailedGradeAnalysisValidator(questionIds = []) {
  return function validateDetailedGradeAnalysis(result) {
    const errors = [];
    if (!result || typeof result !== 'object' || Array.isArray(result)) return ['result_not_object'];

    const summary = ensureObject(result.summary);
    if (!summary || Object.keys(summary).length === 0) {
      errors.push('missing_summary');
    } else {
      if (typeof summary.recommendation !== 'string' || !summary.recommendation.trim()) {
        errors.push('invalid_summary_recommendation');
      }
      if (typeof summary.learner_summary !== 'string' || !summary.learner_summary.trim()) {
        errors.push('invalid_summary_learner_summary');
      }
      ['study_plan', 'strength_tags', 'weak_tags', 'focus_tags', 'confusion_patterns', 'personalization_hints', 'next_goals'].forEach((field) => {
        if (!Array.isArray(summary[field])) errors.push(`invalid_summary_${field}`);
      });
      if (!['step_by_step', 'contrastive', 'example_first'].includes(summary.explanation_style)) {
        errors.push('invalid_summary_explanation_style');
      }
    }

    const questionFeedback = ensureObject(result.question_feedback);
    if (!questionFeedback || Object.keys(questionFeedback).length === 0) {
      errors.push('missing_question_feedback');
    }

    questionIds.forEach((questionId) => {
      const feedback = ensureObject(questionFeedback[questionId]);
      if (!feedback || Object.keys(feedback).length === 0) {
        errors.push(`missing_feedback:${questionId}`);
        return;
      }
      ['why_wrong', 'key_point', 'mini_lesson'].forEach((field) => {
        if (typeof feedback[field] !== 'string' || !feedback[field].trim()) {
          errors.push(`invalid_${field}:${questionId}`);
        }
      });
      if (!Array.isArray(feedback.review_tasks) || feedback.review_tasks.length === 0) {
        errors.push(`invalid_review_tasks:${questionId}`);
      }
      if (!Array.isArray(feedback.extra_examples)) {
        errors.push(`invalid_extra_examples:${questionId}`);
      }
    });

    return errors;
  };
}

function setLocalizedStringField(target, fieldName, locale, text) {
  const value = String(text || '').trim();
  if (!value) return;
  target[fieldName] = { ...ensureObject(target[fieldName]), [locale]: value };
  target[`${fieldName}_${locale}`] = value;
}

function setLocalizedArrayField(target, fieldName, locale, values) {
  const list = uniqueStrings(values, 8);
  if (list.length === 0) return;
  target[fieldName] = { ...ensureObject(target[fieldName]), [locale]: list };
  target[`${fieldName}_${locale}`] = list;
}

function normalizeExtraExamples(examples, uiLocale) {
  return ensureArray(examples)
    .map((entry) => {
      if (typeof entry === 'string') {
        const target = String(entry || '').trim();
        return target ? { target } : null;
      }

      const value = ensureObject(entry);
      const target = String(value.target || value.ja || '').trim();
      const translation = String(value[uiLocale] || value.vi || value.en || value.translation || '').trim();
      if (!target) return null;
      return translation ? { target, [uiLocale]: translation } : { target };
    })
    .filter(Boolean)
    .slice(0, 3);
}

function formatLlmProviderLabel(meta) {
  if (!meta?.provider) return 'llm-router';
  return meta.model ? `${meta.provider}:${meta.model}` : meta.provider;
}

function normalizeUiLocale(value) {
  return String(value || '').toLowerCase() === 'en' ? 'en' : 'vi';
}

function getFeedbackLanguageName(uiLocale) {
  return uiLocale === 'en' ? 'English' : 'Vietnamese';
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
    const uiLocale = normalizeUiLocale(req.body?.uiLanguage);

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
          try {
            const cachedUserData = await loadUserData(req.user.userId, req.user.email);
            if (!cached.learning_profile) {
              cached.learning_profile = normalizeLearningProfile(cachedUserData?.learningProfile);
            }
          } catch (profileErr) {
            console.warn('[Grade V2] Failed to enrich cached learning profile:', profileErr.message);
          }
          console.log('[Grade V2] Returning cached AI result');
          cached.cached = true;
          return res.json(cached);
        }
      }

      const userData = normalizeUserDataShape(await loadUserData(req.user.userId, req.user.email));
      const examMeta = {
        exam_id: blueprint?.meta?.exam_id || null,
        level: blueprint?.meta?.level || null,
        mode: blueprint?.meta?.mode || 'official'
      };
      const previousSignals = buildUserLearningSignals(userData, examMeta);
      const hashToGroupId = {};
      (blueprint.groups || []).forEach((group) => {
        (group.mondai_slots || []).forEach((slot) => {
          if (slot?.mondai_hash) hashToGroupId[slot.mondai_hash] = group.group_id;
        });
      });

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
                passage: mondai.passage || '',
                group_id: hashToGroupId[row.hash] || null
              };
            }
          });
        }
      });

      let correctCount = 0;
      let totalCount = 0;
      const scoreByGroup = Object.fromEntries((blueprint.groups || []).map((group) => [group.group_id, 0]));
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

      for (const questionId of Object.keys(questionMap)) {
        const question = questionMap[questionId];
        if (!question) continue;
        const userAnswer = Object.prototype.hasOwnProperty.call(answers || {}, questionId)
          ? answers[questionId]
          : null;

        totalCount += 1;
        const isCorrect = userAnswer === question.correct_index;
        if (isCorrect) correctCount += 1;
        if (isCorrect && question.group_id) {
          scoreByGroup[question.group_id] = (scoreByGroup[question.group_id] || 0) + 1;
        }
        const explainBrief = String(question.explain_brief || '').trim();

        const questionResult = {
          id: questionId,
          is_correct: isCorrect,
          user_answer_index: userAnswer,
          correct_index: question.correct_index,
          prompt: question.prompt,
          choices: question.choices,
          tags: question.tags
        };
        if (explainBrief) {
          questionResult.key_point = { [uiLocale]: explainBrief };
          if (uiLocale === 'en') questionResult.key_point_en = explainBrief;
          else questionResult.key_point_vi = explainBrief;
        }

        byQuestion.push(questionResult);

        if (!isCorrect) {
          wrongQuestions.push({
            id: questionId,
            prompt: question.prompt,
            tags: question.tags,
            explain_brief: explainBrief,
            choices: question.choices,
            user_answer: userAnswer !== null && userAnswer !== undefined
              ? question.choices[userAnswer]
              : (uiLocale === 'en' ? '(unanswered)' : '(chưa trả lời)'),
            correct_answer: question.choices[question.correct_index],
            passage_snippet: question.passage ? shortText(question.passage, 140) : ''
          });
        }
      }

      const weakTags = countTagsFromItems(
        byQuestion.filter((question) => !question.is_correct).map((question) => question.tags),
        10
      );
      const strongTags = countTagsFromItems(
        byQuestion.filter((question) => question.is_correct).map((question) => question.tags),
        6
      ).filter((tag) => !weakTags.includes(tag));
      let analysisSummary = buildFallbackGradeAnalysis({
        uiLocale,
        correctCount,
        totalCount,
        weakTags,
        strongTags,
        previousSignals
      });

      if (wrongQuestions.length > 0) {
        const analysisConfig = getDetailedGradeAnalysisRunConfig({
          wrongQuestions,
          totalCount
        });
        const detailedPrompt = buildDetailedGradeAnalysisPrompt({
          uiLocale,
          examMeta: {
            ...examMeta,
            total_score: correctCount,
            max_score: totalCount
          },
          wrongQuestions,
          weakTags,
          strongTags,
          scoreByGroup,
          userLearningContext: buildUserLearningContext(userData, examMeta, uiLocale),
          fallbackSummary: analysisSummary,
          responseProfile: analysisConfig.responseProfile
        });
        const analysisResult = await runJsonTask({
          task: 'explain',
          prompt: detailedPrompt,
          validateResult: buildDetailedGradeAnalysisValidator(wrongQuestions.map((question) => question.id)),
          maxTokens: analysisConfig.maxTokens,
          timeoutMs: analysisConfig.timeoutMs,
          preferredProviders: analysisConfig.preferredProviders,
          preferredStageNames: analysisConfig.preferredStageNames,
          temperature: 0.2
        });

        const analysis = analysisResult?.result || {};
        analysisSummary = {
          ...analysisSummary,
          ...ensureObject(analysis.summary),
          weak_tags: uniqueStrings([
            ...weakTags,
            ...ensureArray(analysis?.summary?.weak_tags)
          ], 10),
          strength_tags: uniqueStrings([
            ...strongTags,
            ...ensureArray(analysis?.summary?.strength_tags)
          ], 8),
          focus_tags: uniqueStrings([
            ...ensureArray(analysis?.summary?.focus_tags),
            ...weakTags
          ], 6)
        };
        const questionFeedback = ensureObject(analysis.question_feedback);
        byQuestion.forEach((question) => {
          const feedback = ensureObject(questionFeedback[question.id]);
          if (!feedback || Object.keys(feedback).length === 0) return;

          setLocalizedStringField(question, 'why_wrong', uiLocale, feedback.why_wrong);
          setLocalizedStringField(question, 'key_point', uiLocale, feedback.key_point || question.key_point?.[uiLocale] || question[`key_point_${uiLocale}`]);
          setLocalizedStringField(question, 'mini_lesson', uiLocale, feedback.mini_lesson);
          setLocalizedArrayField(question, 'review_tasks', uiLocale, feedback.review_tasks);

          const examples = normalizeExtraExamples(feedback.extra_examples, uiLocale);
          if (examples.length > 0) {
            question.extra_examples = examples;
            question.extra_examples_target = examples
              .map((example) => example.target)
              .filter(Boolean);
          }
        });
      }

      const updatedLearningProfile = mergeLearningProfile(userData, analysisSummary, {
        ...examMeta,
        total_score: correctCount,
        max_score: totalCount
      });

      try {
        await saveUserData(req.user.userId, {
          ...userData,
          learningProfile: updatedLearningProfile
        });
      } catch (profileSaveErr) {
        console.error('Failed to save learning profile:', profileSaveErr);
      }

      const result = {
        score_summary: {
          total_score: correctCount,
          max_score: totalCount,
          percentage: totalCount ? Math.round(correctCount / totalCount * 100) : 0,
          score_by_group: scoreByGroup,
          weak_tags: uniqueStrings([
            ...weakTags,
            ...ensureArray(analysisSummary.weak_tags)
          ], 10),
          focus_tags: uniqueStrings(analysisSummary.focus_tags, 6),
          strength_tags: uniqueStrings(analysisSummary.strength_tags, 6),
          ...(uiLocale === 'en'
            ? {
              recommendation_en: analysisSummary.recommendation
            }
            : {
              recommendation_vi: analysisSummary.recommendation
            })
        },
        by_question: byQuestion,
        learning_profile_summary: analysisSummary,
        learning_profile: updatedLearningProfile,
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
    const prompt = buildGradeTestPrompt(test, answers, uiLocale);
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

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function formatDateYmd(date = new Date()) {
  const value = new Date(date);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDaysToDateYmd(dateYmd, days) {
  const date = new Date(`${dateYmd}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return formatDateYmd(date);
}

async function loadExamBaseSpec(examType = 'jlpt') {
  const normalizedExamType = String(examType || 'jlpt').toLowerCase();
  if (examSpecTemplateCache.has(normalizedExamType)) {
    return cloneJson(examSpecTemplateCache.get(normalizedExamType));
  }

  const specPath = path.join(__dirname, '../web/public/exams', `${normalizedExamType}_base.json`);
  const raw = await fs.readFile(specPath, 'utf-8');
  const spec = JSON.parse(raw);
  examSpecTemplateCache.set(normalizedExamType, spec);
  return cloneJson(spec);
}

async function buildDailyBankExamSpec(level, examType = 'jlpt') {
  const normalizedLevel = String(level || 'N5').toUpperCase();
  const baseSpec = await loadExamBaseSpec(examType);
  return {
    ...baseSpec,
    exam_id: `${String(examType || 'jlpt').toLowerCase()}_${normalizedLevel}`,
    level: normalizedLevel,
    display_name_vi: `${baseSpec.display_name_vi || String(examType || 'JLPT').toUpperCase()} ${normalizedLevel}`
  };
}

function getExamMondaiIds(examSpec) {
  return ensureArray(examSpec?.groups)
    .flatMap((group) => ensureArray(group?.mondai).map((mondai) => String(mondai?.mondai_id || '').toUpperCase()))
    .filter(Boolean);
}

function filterExamSpecByMondaiIds(examSpec, allowedMondaiIds) {
  if (!Array.isArray(allowedMondaiIds) || allowedMondaiIds.length === 0) return cloneJson(examSpec);

  const allowed = new Set(allowedMondaiIds.map((item) => String(item || '').toUpperCase()));
  const filteredSpec = cloneJson(examSpec);
  filteredSpec.groups = ensureArray(filteredSpec.groups)
    .map((group) => ({
      ...group,
      mondai: ensureArray(group?.mondai).filter((mondai) => allowed.has(String(mondai?.mondai_id || '').toUpperCase()))
    }))
    .filter((group) => ensureArray(group.mondai).length > 0);

  if (filteredSpec?.official_time_limits_sec?.groups) {
    filteredSpec.official_time_limits_sec.groups = ensureArray(filteredSpec.official_time_limits_sec.groups)
      .filter((group) => filteredSpec.groups.some((entry) => entry.group_id === group.group_id));
    filteredSpec.official_time_limits_sec.overall_time_sec = ensureArray(filteredSpec.official_time_limits_sec.groups)
      .reduce((sum, group) => sum + Number(group?.time_sec || 0), 0);
  }

  return filteredSpec;
}

function buildExamVariantSpec(examSpec, variantKey) {
  const variant = DAILY_BANK_VARIANT_MAP.get(variantKey);
  if (!variant) {
    throw new Error(`Unsupported daily bank variant: ${variantKey}`);
  }
  if (!Array.isArray(variant.mondaiIds) || variant.mondaiIds.length === 0) {
    return cloneJson(examSpec);
  }
  return filterExamSpecByMondaiIds(examSpec, variant.mondaiIds);
}

function normalizeMondaiIdList(values, limit = 64) {
  return uniqueStrings(
    ensureArray(values).map((value) => String(value || '').toUpperCase()),
    limit
  ).sort();
}

function getDailyBankFullVariantMondaiIds() {
  return normalizeMondaiIdList(
    DAILY_BANK_VARIANTS.flatMap((variant) => Array.isArray(variant.mondaiIds) ? variant.mondaiIds : []),
    64
  );
}

function getRequestedMondaiIds(examSpec) {
  return normalizeMondaiIdList(getExamMondaiIds(examSpec), 64);
}

function inferExamVariantKey(examSpec) {
  const normalizedIds = getRequestedMondaiIds(examSpec);
  if (normalizedIds.length === 0) return 'custom:empty';

  const joined = normalizedIds.join('|');
  if (joined === getDailyBankFullVariantMondaiIds().join('|')) {
    return 'full';
  }
  if (DAILY_BANK_EXACT_VARIANT_LOOKUP.has(joined)) {
    return DAILY_BANK_EXACT_VARIANT_LOOKUP.get(joined);
  }
  return `custom:${joined}`;
}

function filterBlueprintByMondaiIds(blueprint, allowedMondaiIds) {
  const normalizedIds = normalizeMondaiIdList(allowedMondaiIds, 64);
  if (normalizedIds.length === 0) return cloneJson(blueprint);

  const allowed = new Set(normalizedIds);
  const filteredBlueprint = cloneJson(blueprint);
  filteredBlueprint.groups = ensureArray(filteredBlueprint?.groups)
    .map((group) => ({
      ...group,
      mondai_slots: ensureArray(group?.mondai_slots)
        .filter((slot) => allowed.has(String(slot?.mondai_id || '').toUpperCase()))
    }))
    .filter((group) => ensureArray(group?.mondai_slots).length > 0);

  if (filteredBlueprint.groups.length === 0) return null;
  if (!filteredBlueprint.meta) filteredBlueprint.meta = {};
  filteredBlueprint.meta.requested_mondai_ids = normalizedIds;
  return filteredBlueprint;
}

function inferPublishedVariantCandidates(examSpecOrMondaiIds) {
  const normalizedIds = Array.isArray(examSpecOrMondaiIds)
    ? normalizeMondaiIdList(examSpecOrMondaiIds, 64)
    : getRequestedMondaiIds(examSpecOrMondaiIds);

  if (normalizedIds.length === 0) return [];

  const joined = normalizedIds.join('|');
  const fullJoined = getDailyBankFullVariantMondaiIds().join('|');
  if (joined === fullJoined) {
    return ['full'];
  }

  const exact = DAILY_BANK_EXACT_VARIANT_LOOKUP.get(joined);
  if (exact) {
    return exact === 'full' ? ['full'] : [exact, 'full'];
  }

  const containingKeys = DAILY_BANK_VARIANTS
    .filter((variant) => variant.key !== 'full' && Array.isArray(variant.mondaiIds))
    .filter((variant) => {
      const variantIds = normalizeMondaiIdList(variant.mondaiIds, 64);
      return normalizedIds.every((id) => variantIds.includes(id));
    })
    .sort((left, right) => ensureArray(left.mondaiIds).length - ensureArray(right.mondaiIds).length)
    .map((variant) => variant.key);

  return uniqueStrings([...containingKeys, 'full'], DAILY_BANK_VARIANTS.length + 1);
}

function buildPublishedExamTitle({ level, mode, variantKey, setNo, bankDateYmd }) {
  const variant = DAILY_BANK_VARIANT_MAP.get(variantKey);
  const variantLabel = variant?.title || variantKey;
  return `[DailyBank ${bankDateYmd}] JLPT ${level} ${mode} ${variantLabel} #${setNo}`;
}

function buildPublishedExamDescription({ level, mode, variantKey, bankDateYmd }) {
  const variant = DAILY_BANK_VARIANT_MAP.get(variantKey);
  const variantLabel = variant?.title || variantKey;
  return `Prebuilt daily bank for JLPT ${level} ${mode} ${variantLabel} on ${bankDateYmd}`;
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

function buildLearnerHintPromptBlock(learnerHints) {
  if (!learnerHints) return '';

  const lines = [];
  if (ensureArray(learnerHints.weak_tags).length > 0) {
    lines.push(`- Gently reinforce these weak areas when natural: ${uniqueStrings(learnerHints.weak_tags, 5).join(', ')}`);
  }
  if (ensureArray(learnerHints.strong_tags).length > 0) {
    lines.push(`- The learner is relatively steadier in: ${uniqueStrings(learnerHints.strong_tags, 4).join(', ')}`);
  }
  if (ensureArray(learnerHints.confusion_patterns).length > 0) {
    lines.push(`- Frequent confusion patterns to address lightly: ${uniqueStrings(learnerHints.confusion_patterns, 4).join(', ')}`);
  }
  if (ensureArray(learnerHints.personalization_hints).length > 0) {
    lines.push(`- Helpful explanation preferences: ${uniqueStrings(learnerHints.personalization_hints, 4).join(', ')}`);
  }
  if (learnerHints.learner_summary) {
    lines.push(`- Learner snapshot: ${learnerHints.learner_summary}`);
  }

  if (lines.length === 0) return '';

  return `
-------------------------
LIGHT PERSONALIZATION HINTS
-------------------------
Use these hints as a light bias only. Keep official exam standards, difficulty, structure, and coverage intact.
Do NOT overfit the whole exam to one learner profile.
${lines.join('\n')}
- If you write explain_brief, prefer the declared explanation style: ${learnerHints.explanation_style || 'step_by_step'}.`;
}

// Build prompt for generating a chunk of mondai (2-3 at a time)
function buildMondaiChunkPrompt(examSpec, mode, group, groupIndex, mondaiToGenerate, startMondaiIndex, previousMondai = [], learnerHints = null) {
  const modeConfig = examSpec.modes[mode];
  const questionScale = modeConfig.question_scale;
  const promptProfile = getExamPromptProfile(examSpec);

  // Reading type IDs for special handling
  const readingTypes = ['reading_short', 'reading_mid', 'reading_long', 'reading_compare', 'reading_info'];
  // Listening type IDs
  const listeningTypes = LISTENING_TYPES;

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
    - This is a listening mondai. It MUST include mondai.media.script_text.
    - Put script_text at MONDAI level only: mondai.media.script_text (NOT in items)
    - Use natural Japanese audio transcript only. No headers, no explanations inside script_text.
    - Preferred script format for dialogue: "A: こんにちは\nB: はい、こんにちは"
    - If monologue, still place the full transcript in mondai.media.script_text
    - For listening mondai, omit passage.text entirely
    - items[].media MUST be null or omitted
    - title_vi, instructions_vi, and every explain_brief MUST stay in Vietnamese`;
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
  const typeSpecificRules = mondaiToGenerate.map((m) => {
    const primaryType = m.types?.[0] || 'unknown';
    const isReading = m.types?.some((type) => readingTypes.includes(type));
    const isListening = m.types?.some((type) => listeningTypes.includes(type));
    const totalQuestions = Math.max(1, Math.round(m.count_official * questionScale));

    if (isReading) {
      return `- ${m.mondai_id}: exactly ${totalQuestions} questions sharing ONE passage.text only; every item must test information from that passage; no unrelated standalone items.`;
    }
    if (primaryType === 'grammar_passage') {
      return `- ${m.mondai_id}: include a short passage.text and make all ${totalQuestions} questions depend on that passage context; do not generate isolated grammar questions here.`;
    }
    if (isListening) {
      return `- ${m.mondai_id}: this is listening content, so put all audio transcript in mondai.media.script_text only; items must not contain item.media; do not create passage.text; keep explain_brief in Vietnamese and keep script_text as natural Japanese audio lines only.`;
    }
    if (primaryType === 'grammar_order') {
      return `- ${m.mondai_id}: each prompt must show 4 numbered fragments (1.-4. or ①-④) and all choices must be order patterns such as "1-3-2-4", not full sentences.`;
    }
    if (primaryType === 'kanji') {
      return `- ${m.mondai_id}: each prompt must highlight exactly one target with [[...]] and answer choices should be plausible readings, not letters or duplicate kana strings.`;
    }
    if (primaryType === 'vocab_synonym') {
      return `- ${m.mondai_id}: highlight the target expression with [[...]] and make choices short synonym candidates, not full explanatory sentences.`;
    }
    if (primaryType === 'vocab_context') {
      return `- ${m.mondai_id}: make each item a natural sentence with one clear blank/context target; choices must fit the same grammatical slot.`;
    }
    if (primaryType === 'vocab_usage') {
      return `- ${m.mondai_id}: all choices should be full example sentences using the target word; only one sentence may sound natural and semantically correct.`;
    }
    if (primaryType === 'grammar_select') {
      return `- ${m.mondai_id}: each item tests one grammar point in one sentence; choices must be grammatically comparable and differ for a clear reason.`;
    }
    return `- ${m.mondai_id}: obey the requested type "${primaryType}" exactly and keep all ${totalQuestions} items aligned with that type.`;
  }).join('\n');
  const learnerHintBlock = buildLearnerHintPromptBlock(learnerHints);

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
Use the previous context above to keep variety, avoid repeating the same target words, grammar points, or passage themes, and keep the full exam balanced.

-------------------------
TYPE-SPECIFIC INTEGRITY RULES
-------------------------
${typeSpecificRules}

If any mondai mixes structures from another type, the output is INVALID and must be rewritten.
${learnerHintBlock}

-------------------------
OUTPUT RULE
-------------------------
Return RAW JSON ONLY. 
- DO NOT use markdown code blocks (no \`\`\`json).
- DO NOT start with "Here is the JSON...".
- DO NOT end with explanations.
- The output must start clearly with '{' and end with '}'.

-------------------------
SUPPORT TEXT LANGUAGE RULES
-------------------------
- "title_vi", "instructions_vi", and "explain_brief" MUST be written in Vietnamese.
- "explain_brief" should be a short Vietnamese teaching note for the learner.
- NEVER write "explain_brief" in Japanese or English.

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
          "explain_brief": "<brief explanation in Vietnamese>",
          "tags": ["<tag1>", "<tag2>"]
        }
      ]
    }
  ]
}

GENERATE JSON NOW (NO MARKDOWN):`;
}

function mondaiBatchIncludesListening(mondaiBatch = []) {
  return ensureArray(mondaiBatch).some((mondai) =>
    ensureArray(mondai?.types).some((type) => LISTENING_TYPE_SET.has(type))
  );
}

function getMondaiGenerationRunConfig(mondaiBatch = []) {
  const includesListening = mondaiBatchIncludesListening(mondaiBatch);
  if (!includesListening) {
    return {
      temperature: 0.8,
      preferredProviders: undefined,
      preferredStageNames: undefined
    };
  }

  return {
    temperature: 0.6,
    preferredProviders: ['gemini', 'openrouter'],
    preferredStageNames: [
      'gemini-key-a',
      'gemini-key-b',
      'gemini-key-a-compat',
      'gemini-key-b-compat',
      'openrouter-secondary',
      'openrouter-primary'
    ]
  };
}

function buildMondaiChunkRepairPrompt({
  originalPrompt,
  rawText,
  validationErrors = [],
  mondaiBatch = [],
  examSpec,
  mode
}) {
  const modeConfig = examSpec?.modes?.[mode] || DEFAULT_MODES[mode] || DEFAULT_MODES.official || { question_scale: 1 };
  const includesListening = mondaiBatchIncludesListening(mondaiBatch);
  const expectedSummary = ensureArray(mondaiBatch).map((mondaiDef) => {
    const expectedCount = Math.max(1, Math.round((mondaiDef?.count_official || 1) * (modeConfig.question_scale || 1)));
    const typeList = ensureArray(mondaiDef?.types).join(', ') || 'unknown';
    return `- ${mondaiDef?.mondai_id || 'unknown'}: ${expectedCount} questions, types: ${typeList}`;
  }).join('\n');

  return `You are repairing a generated exam JSON payload for a strict validator.

EXPECTED MONDAI IN THIS BATCH:
${expectedSummary || '- unknown'}

ORIGINAL TASK:
${String(originalPrompt || '').slice(0, 12000)}

CURRENT OUTPUT:
${String(rawText || '').slice(0, 12000)}

VALIDATION ERRORS:
${validationErrors.length > 0 ? validationErrors.join('\n') : 'invalid_json'}

STRICT REPAIR RULES:
1. Return valid JSON only.
2. Preserve the same mondai order and same question counts unless the validator requires a fix.
3. Keep prompts and choices in ${examSpec?.language || 'ja-JP'} unless the schema says Vietnamese.
4. title_vi, instructions_vi, and explain_brief must be Vietnamese.
5. explain_brief must be a short Vietnamese teaching note, not Japanese.
6. Non-listening mondai must not contain media.script_text.
${includesListening ? '7. Listening mondai must store the full transcript only at mondai.media.script_text.\n8. Listening mondai must not use passage.text.\n9. items[].media must be null or omitted for listening.\n10. script_text must be natural Japanese transcript lines only, with no Vietnamese notes or headings.' : '7. Do not add script_text unless the mondai is a listening type.'}

FIX THE JSON NOW.`;
}

function buildGradeTestPrompt(test, answers, uiLocale = 'vi') {
  const locale = normalizeUiLocale(uiLocale);
  const feedbackLanguage = getFeedbackLanguageName(locale);
  const recommendationKey = locale === 'en' ? 'recommendation_en' : 'recommendation_vi';
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

  return `You are an expert exam grader and a supportive private tutor. Grade the following test and provide detailed feedback in ${feedbackLanguage}.

TEST: ${test.meta.exam_id} ${test.meta.level}
MODE: ${test.meta.mode}

QUESTIONS AND ANSWERS:
${JSON.stringify(questionsWithAnswers, null, 2)}

For each incorrect answer, provide:
1. why_wrong: Explain why the user's choice was wrong ({"${locale}": "<text>"})
2. key_point: The key grammar/vocab point being tested ({"${locale}": "<text>"})
3. mini_lesson: A mini lesson to help the user understand ({"${locale}": "<text>"})
4. extra_examples: 2-3 example sentences in the target language with translation ([{"ja": "<example>", "${locale}": "<translation>"}])
5. review_tasks: Suggested review tasks ({"${locale}": ["<task1>"]})

Style rules:
- Write like a warm one-on-one tutor speaking directly to the learner, not like a cold answer key.
- In "why_wrong", first identify the likely confusion, then contrast the chosen answer with the correct answer.
- In "mini_lesson", teach the clue to notice next time, not just the definition.
- Whenever possible, end the explanation with a practical next-time signal such as what word, grammar clue, or passage evidence to look for.
- "review_tasks" must be short, concrete, and immediately doable.
- "extra_examples" should reinforce the same target pattern and avoid introducing side variants or exceptions unless absolutely necessary.
- "${recommendationKey}" should sound encouraging and specific, ideally 2-3 sentences, not generic.

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
              "${recommendationKey}": "<personalized study recommendation in ${feedbackLanguage}>"
  },
                "by_question": [
                {
                  "id": "<question_id>",
                    "is_correct": true/false,
                    "why_wrong": { "${locale}": "<explanation>" },
                    "key_point": { "${locale}": "<key point>" },
                    "mini_lesson": { "${locale}": "<mini lesson>" },
                    "extra_examples": [ { "ja": "<example>", "${locale}": "<translation>" } ],
                    "review_tasks": { "${locale}": ["<task1>"] }
    }
                              ]
}

                              GENERATE JSON NOW:`;
}

function getDetailedGradeAnalysisRunConfig(options = {}) {
  const wrongCount = Math.max(0, ensureArray(options.wrongQuestions).length);

  return {
    maxTokens: wrongCount <= 1 ? 2304 : wrongCount <= 3 ? 3072 : wrongCount <= 6 ? 4608 : 6144,
    timeoutMs: wrongCount <= 1 ? 45000 : wrongCount <= 3 ? 60000 : 90000,
    preferredProviders: wrongCount <= 3 ? ['gemini', 'openrouter'] : ['openrouter', 'gemini'],
    preferredStageNames: wrongCount <= 3
      ? ['gemini-key-a', 'gemini-key-b', 'gemini-key-a-compat', 'gemini-key-b-compat', 'openrouter-secondary', 'openrouter-primary']
      : ['openrouter-secondary', 'gemini-key-a', 'gemini-key-b', 'gemini-key-a-compat', 'gemini-key-b-compat', 'openrouter-primary'],
    responseProfile: {
      maxStudyPlanSteps: wrongCount <= 3 ? 2 : 3,
      maxFocusTags: wrongCount <= 3 ? 4 : 6,
      maxExamplesPerQuestion: wrongCount <= 2 ? 1 : 2,
      maxReviewTasksPerQuestion: 2,
      maxPersonalizationHints: 3,
      maxNextGoals: wrongCount <= 3 ? 2 : 3
    }
  };
}

function buildDetailedGradeAnalysisPrompt({
  uiLocale = 'vi',
  examMeta = {},
  wrongQuestions = [],
  weakTags = [],
  strongTags = [],
  scoreByGroup = {},
  userLearningContext = '',
  fallbackSummary = {},
  responseProfile = {}
}) {
  const locale = normalizeUiLocale(uiLocale);
  const feedbackLanguage = getFeedbackLanguageName(locale);
  const maxStudyPlanSteps = Math.max(1, Number(responseProfile.maxStudyPlanSteps || 2));
  const maxFocusTags = Math.max(1, Number(responseProfile.maxFocusTags || 4));
  const maxExamplesPerQuestion = Math.max(1, Number(responseProfile.maxExamplesPerQuestion || 1));
  const maxReviewTasksPerQuestion = Math.max(1, Number(responseProfile.maxReviewTasksPerQuestion || 2));
  const maxPersonalizationHints = Math.max(1, Number(responseProfile.maxPersonalizationHints || 3));
  const maxNextGoals = Math.max(1, Number(responseProfile.maxNextGoals || 2));
  const summaryJson = JSON.stringify({
    weak_tags: uniqueStrings(weakTags, 8),
    strong_tags: uniqueStrings(strongTags, 6),
    score_by_group: scoreByGroup,
    fallback_summary: fallbackSummary
  }, null, 2);

  return `You are a patient JLPT coach and a supportive private tutor.
Analyze this learner's incorrect answers and produce highly actionable feedback in ${feedbackLanguage}.

The scoring is already final. Do NOT change correctness, scores, or answer keys.
Your task is to explain mistakes, suggest how the learner should improve, and update a lightweight learner profile for future personalization.
Write as if you are speaking directly to one learner after class: warm, clear, practical, and specific.
Do NOT sound like a dictionary, rubric, or generic answer key.

EXAM META:
- Exam: ${examMeta.exam_id || 'unknown'}
- Level: ${examMeta.level || 'unknown'}
- Mode: ${examMeta.mode || 'official'}
- Score: ${examMeta.total_score ?? 0}/${examMeta.max_score ?? 0}

PRIOR LEARNER CONTEXT:
${userLearningContext}

DETERMINISTIC OBSERVATIONS:
${summaryJson}

INCORRECT QUESTIONS:
${wrongQuestions.map((question, index) => `[${index + 1}] id="${question.id}"
Prompt: ${question.prompt}
Tags: ${ensureArray(question.tags).join(', ') || '(none)'}
Student chose: ${question.user_answer}
Correct answer: ${question.correct_answer}
Brief author hint: ${question.explain_brief || '(none)'}
${question.passage_snippet ? `Context snippet: ${question.passage_snippet}` : ''}`).join('\n\n')}

Return RAW JSON ONLY with this schema:
{
  "summary": {
    "recommendation": "<personalized study recommendation in ${feedbackLanguage}>",
    "learner_summary": "<short diagnostic summary in ${feedbackLanguage}>",
    "study_plan": ["<up to ${maxStudyPlanSteps} steps>"],
    "strength_tags": ["<tag>"],
    "weak_tags": ["<tag>"],
    "focus_tags": ["<up to ${maxFocusTags} tags>"],
    "confusion_patterns": ["<pattern>"],
    "personalization_hints": ["<up to ${maxPersonalizationHints} hints>"],
    "explanation_style": "step_by_step",
    "next_goals": ["<up to ${maxNextGoals} goals>"]
  },
  "question_feedback": {
    "<question_id>": {
      "why_wrong": "<why the learner got this wrong in ${feedbackLanguage}>",
      "key_point": "<core grammar/vocab/listening point in ${feedbackLanguage}>",
      "mini_lesson": "<2-4 short teaching sentences in ${feedbackLanguage}>",
      "extra_examples": [
        { "target": "<Japanese example>", "${locale}": "<translation in ${feedbackLanguage}>" }
      ],
      "review_tasks": ["<specific review task>", "<specific review task>"]
    }
  }
}

Rules:
- Be concrete and constructive, not generic.
- Do not merely restate "fallback_summary"; refine it so it matches the actual mistakes in this attempt.
- "recommendation" should sound like a tutor talking to the learner: 2-3 sentences, encouraging but specific.
- "learner_summary" should mention one meaningful weakness and, if possible, one retained strength.
- "why_wrong" must compare the learner's chosen answer against the correct answer.
- "why_wrong" should identify the likely confusion first, then point out the exact clue that resolves it.
- "key_point" should be brief, memorable, and sound like a recall hook.
- "mini_lesson" should feel like a short coaching note, not a dictionary entry.
- "mini_lesson" should explicitly tell the learner what clue to notice next time.
- If the question is reading/listening, mention the exact evidence phrase or keyword from the context when possible.
- "review_tasks" must be actionable, not abstract.
- The first review task should be a small action the learner can do in about 2 minutes.
- The second review task should make the learner produce, compare, or explain something.
- Return at most ${maxReviewTasksPerQuestion} review tasks per question.
- "extra_examples" should be short, natural, and directly related to the mistake.
- Return at most ${maxExamplesPerQuestion} extra examples per question.
- "extra_examples" should reinforce the same target pattern and avoid introducing adjacent variants or exceptions unless truly necessary.
- Keep "focus_tags" narrower than "weak_tags" and limit them to ${maxFocusTags}.
- Limit "study_plan" to ${maxStudyPlanSteps} short steps.
- Limit "personalization_hints" to ${maxPersonalizationHints} short hints.
- Limit "next_goals" to ${maxNextGoals} clear goals.
- "personalization_hints" should help future explanations fit this learner, for example: validate the likely intuition first, then contrast, then give one next-time clue.
- "explanation_style" must be one of: step_by_step, contrastive, example_first.
- Prefer short sentences and direct learner-facing language.
- Output valid JSON only. No markdown. No commentary outside JSON.`;
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

function getNextDailyBankRunDelayMs(now = new Date()) {
  const next = new Date(now);
  next.setHours(DAILY_BANK_SCHEDULE_HOUR, DAILY_BANK_SCHEDULE_MINUTE, 0, 0);
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime() - now.getTime();
}

function scheduleDailyBankWorkflowLoop() {
  if (!DAILY_BANK_ENABLED || IS_VERCEL) return;

  if (dailyBankRuntimeState.timer) {
    clearTimeout(dailyBankRuntimeState.timer);
    dailyBankRuntimeState.timer = null;
  }

  const delayMs = getNextDailyBankRunDelayMs();
  dailyBankRuntimeState.timer = setTimeout(async () => {
    try {
      await runDailyBankWorkflow({ dateYmd: formatDateYmd() });
    } catch (error) {
      console.error('[DailyBank] Scheduled run failed:', error);
    } finally {
      scheduleDailyBankWorkflowLoop();
    }
  }, delayMs);

  if (typeof dailyBankRuntimeState.timer.unref === 'function') {
    dailyBankRuntimeState.timer.unref();
  }

  console.log(`[DailyBank] Next scheduled run in ${Math.round(delayMs / 1000)}s`);
}

async function maybeRunDailyBankOnStartup() {
  if (!DAILY_BANK_ENABLED || !DAILY_BANK_RUN_ON_STARTUP) return;
  if (!(await db.initDb())) return;

  const today = formatDateYmd();
  const existingRes = await db.query(
    'SELECT id FROM published_exams WHERE bank_date_ymd = $1 AND is_active = true LIMIT 1',
    [today]
  );
  if (existingRes.rows.length > 0) {
    dailyBankRuntimeState.lastRunDateYmd = today;
    return;
  }

  try {
    console.log(`[DailyBank] Startup catch-up run for ${today}`);
    await runDailyBankWorkflow({ dateYmd: today });
  } catch (error) {
    console.error('[DailyBank] Startup run failed:', error);
  }
}

async function maybeSeedCurrentDayRareBucketsOnStartup() {
  if (!CURRENT_DAY_RARE_BUCKET_WARM_ENABLED || !CURRENT_DAY_RARE_BUCKET_WARM_ON_STARTUP || IS_VERCEL) return;
  if (!(await db.initDb())) return;

  const today = formatDateYmd();
  const taskFactories = [];

  for (const level of DAILY_BANK_LEVELS) {
    for (const mode of DAILY_BANK_MODES) {
      taskFactories.push(async () => {
        const examSpec = await buildDailyBankExamSpec(level);
        const snapshotId = await ensurePoolSnapshot(examSpec, level, today, 'startup-rare-warm', mode);
        scheduleCurrentDayRareBucketWarmup({
          snapshotId,
          examSpec,
          level,
          mode,
          dateYmd: today,
          trigger: 'startup-rare-warm'
        });
        return { level, mode, snapshotId };
      });
    }
  }

  const scheduled = await runTasksWithConcurrency(taskFactories, CURRENT_DAY_RARE_BUCKET_WARM_CONCURRENCY);
  const scheduledCount = ensureArray(scheduled).filter((entry) => !!entry?.snapshotId).length;
  console.log(`[RareWarm] Startup scheduled current-day rare seeding for ${scheduledCount} snapshots on ${today}`);
}

app.get('/api/admin/daily-bank/status', async (req, res) => {
  if (!isAuthorizedAdminRequest(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  return res.json({
    enabled: DAILY_BANK_ENABLED,
    runOnStartup: DAILY_BANK_RUN_ON_STARTUP,
    retentionDays: DAILY_BANK_RETENTION_DAYS,
    setCount: DAILY_BANK_SET_COUNT,
    targetPerBucket: DAILY_BANK_TARGET_PER_BUCKET,
    levels: DAILY_BANK_LEVELS,
    modes: DAILY_BANK_MODES,
    variants: DAILY_BANK_VARIANTS.map((variant) => variant.key),
    lastRunDateYmd: dailyBankRuntimeState.lastRunDateYmd,
    lastStartedAt: dailyBankRuntimeState.lastStartedAt,
    lastFinishedAt: dailyBankRuntimeState.lastFinishedAt,
    running: dailyBankRuntimeState.running,
    scheduledHour: DAILY_BANK_SCHEDULE_HOUR,
    scheduledMinute: DAILY_BANK_SCHEDULE_MINUTE,
    lastResult: dailyBankRuntimeState.lastResult,
    currentDayRareWarm: summarizeCurrentDayRareBucketWarmState(8)
  });
});

app.post('/api/admin/daily-bank/run', async (req, res) => {
  if (!isAuthorizedAdminRequest(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const result = await runDailyBankWorkflow({
      dateYmd: req.body?.dateYmd || req.body?.date_ymd || formatDateYmd(),
      levels: req.body?.levels,
      modes: req.body?.modes,
      variants: req.body?.variants
    });
    return res.json(result);
  } catch (error) {
    console.error('[DailyBank] Manual run failed:', error);
    if (isTemporaryUnavailableError(error)) {
      return res.status(503).json(getTemporaryUnavailablePayload(error));
    }
    return res.status(500).json({ error: error.message });
  }
});

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

    await bootstrapRareBucketsForSnapshot(snapshotId, examSpec, level, mode);

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

    await bootstrapRareBucketsForSnapshot(snapshotId, examSpec, level, mode);

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
    const bucketsToProcess = sortBucketsForWarmup(interleaved).slice(0, maxBuckets);
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
 * Body: { keepDays?: number } (default 30)
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

    const keepDays = Math.max(1, parseInt(req.body?.keepDays) || DAILY_BANK_RETENTION_DAYS);
    const result = await cleanupExpiredDailyBankData({ keepDays });
    console.log(`[Cleanup] Done for cutoff ${result.cutoffYmd} (${result.keepDays} days)`);
    res.json({ ok: true, ...result });

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

function collectBlueprintHashes(blueprint) {
  const hashes = new Set();
  for (const group of blueprint?.groups || []) {
    for (const slot of group?.mondai_slots || []) {
      if (slot?.mondai_hash) hashes.add(slot.mondai_hash);
    }
  }
  return hashes;
}

async function hydrateDeferredSlotsForChunk({ blueprint, group, slotsToConsider, userId }) {
  const pendingSlots = (slotsToConsider || [])
    .filter(({ slot }) => !slot?.mondai_hash)
    .map(({ slot }) => ({
      group: {
        group_id: group.group_id,
        title_vi: group.title_vi,
        mondai_slots: group.mondai_slots
      },
      mondaiDef: buildMondaiDefFromSlot(slot),
      slot
    }));

  if (pendingSlots.length === 0) return false;

  const examSpec = buildPromptExamSpecFromBlueprint(blueprint);
  const snapshotId = blueprint?.meta?.snapshot_id || await ensurePoolSnapshot(
    examSpec,
    blueprint?.meta?.level || examSpec.level,
    blueprint?.meta?.date_ymd || new Date().toISOString().split('T')[0],
    blueprint?.meta?.plan || 'free',
    blueprint?.meta?.mode || 'official'
  );
  const usedHashes = collectBlueprintHashes(blueprint);

  await hydratePendingBlueprintSlots({
    pendingSlots,
    examSpec,
    level: blueprint?.meta?.level || examSpec.level,
    mode: blueprint?.meta?.mode || 'official',
    snapshotId,
    plan: blueprint?.meta?.plan || 'free',
    rng: Math.random,
    usedHashes,
    userId: userId || null,
    allowRepeat: false,
    learnerHints: blueprint?.meta?.learner_hints || null
  });

  if (!blueprint.meta) blueprint.meta = {};
  blueprint.meta.snapshot_id = snapshotId;

  pendingSlots.forEach(({ slot }) => {
    if (slot?.mondai_hash) slot.status = 'ready';
  });

  return pendingSlots.some(({ slot }) => !!slot?.mondai_hash);
}

function getSlotEntriesByIds(group, slotIds) {
  const wantedIds = Array.from(new Set((slotIds || []).filter(Boolean)));
  if (!group || wantedIds.length === 0) return { entries: [], missing: [] };

  const slotMap = new Map(
    (group.mondai_slots || []).map((slot, idx) => [slot?.slot_id, { slot, idx }])
  );

  const entries = [];
  const missing = [];
  for (const slotId of wantedIds) {
    const match = slotMap.get(slotId);
    if (!match) {
      missing.push(slotId);
      continue;
    }
    entries.push(match);
  }

  entries.sort((a, b) => a.idx - b.idx);
  return { entries, missing };
}

function attachStartPrefetchPersistence(instanceKey, userId, blueprint, startPrefetchPromise) {
  if (!instanceKey || !blueprint || typeof startPrefetchPromise?.then !== 'function') return;

  Promise.resolve(startPrefetchPromise)
    .then(async (prefetchReady) => {
      if (!prefetchReady) return;

      await db.query(
        'UPDATE exam_instances_cache SET blueprint=$1 WHERE instance_key=$2',
        [JSON.stringify(blueprint), instanceKey]
      );

      await recordServedMondaiHistory(db, {
        userId: userId || null,
        instanceKey,
        blueprint
      });

      console.log(`[Blueprint] Prefetch wave persisted for instance ${instanceKey.substring(0, 8)}...`);
    })
    .catch((error) => {
      console.warn('[Blueprint] Persisting start prefetch wave failed:', error?.message || error);
    });
}

async function prepareSlotContentsForDelivery({ blueprint, group, groupIdx, slotsToConsider, userId }) {
  let blueprintModified = false;

  if (!Array.isArray(slotsToConsider) || slotsToConsider.length === 0) {
    return { mondaiToDeliver: [], blueprintModified };
  }

  if (slotsToConsider.some(({ slot }) => !slot?.mondai_hash)) {
    const hydrated = await hydrateDeferredSlotsForChunk({
      blueprint,
      group,
      slotsToConsider,
      userId: userId || null
    });
    if (hydrated || blueprint?.meta?.snapshot_id) blueprintModified = true;
    blueprint.groups[groupIdx] = group;
  }

  const unresolvedSlots = slotsToConsider.filter(({ slot }) => !slot?.mondai_hash);
  if (unresolvedSlots.length > 0) {
    throw createTemporaryUnavailableError(
      new Error(`Deferred slots not ready: ${unresolvedSlots.map(({ slot }) => slot?.slot_id || slot?.mondai_id || 'unknown').join(', ')}`)
    );
  }

  const hashesToFetch = slotsToConsider.map(({ slot }) => slot?.mondai_hash).filter(Boolean);
  const contentMap = {};
  if (hashesToFetch.length > 0) {
    const batchRes = await db.query(
      'SELECT hash, content FROM mondai_bank WHERE hash = ANY($1)',
      [hashesToFetch]
    );
    batchRes.rows.forEach((row) => {
      contentMap[row.hash] = parseJsonb(row.content);
    });
  }

  const mondaiToDeliver = [];

  for (const { slot, idx } of slotsToConsider) {
    let content = contentMap[slot.mondai_hash] || null;

    if (!content && slot?.mondai_hash) {
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
      } catch (error) {
        console.error('[Chunk] Repair failed:', error.message);
      }
    }

    if (content) {
      mondaiToDeliver.push(attachSlotMetaToMondai(content, slot, group.group_id, idx));
    }
  }

  const deliveredSlotIds = new Set(
    mondaiToDeliver
      .map((mondai) => mondai?.slot_id || mondai?.meta?.slot_id)
      .filter(Boolean)
  );
  const missingSlotIds = slotsToConsider
    .map(({ slot }) => slot?.slot_id)
    .filter((slotId) => slotId && !deliveredSlotIds.has(slotId));

  if (missingSlotIds.length > 0) {
    throw createTemporaryUnavailableError(
      new Error(`Requested slots not ready: ${missingSlotIds.join(', ')}`)
    );
  }

  return { mondaiToDeliver, blueprintModified };
}

/**
 * Compatibility helper for legacy count-based chunk delivery.
 * The active web client now requests explicit slot_ids instead.
 */
async function deliverNextChunk(instanceKey, want) {
  await db.query('BEGIN');
  try {
    // Load instance + blueprint using FOR UPDATE to prevent race conditions
    const inst = await db.query(
      'SELECT blueprint, delivery_state, user_id FROM exam_instances_cache WHERE instance_key=$1 FOR UPDATE',
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

    const { mondaiToDeliver, blueprintModified } = await prepareSlotContentsForDelivery({
      blueprint,
      group,
      groupIdx,
      slotsToConsider,
      userId: inst.rows[0]?.user_id || null
    });

    if (slotsToConsider.length > 0) {
      cursor = Math.max(...slotsToConsider.map(({ idx }) => idx)) + 1;
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

    if (blueprintModified) {
      await recordServedMondaiHistory(db, {
        userId: inst.rows[0]?.user_id || null,
        instanceKey,
        blueprint
      });
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

async function deliverRequestedSlots(instanceKey, want) {
  await db.query('BEGIN');
  try {
    const inst = await db.query(
      'SELECT blueprint, user_id FROM exam_instances_cache WHERE instance_key=$1 FOR UPDATE',
      [instanceKey]
    );

    if (inst.rows.length === 0) {
      await db.query('ROLLBACK');
      throw new Error('Instance not found');
    }

    const blueprint = parseJsonb(inst.rows[0].blueprint);
    const reqId = Date.now() + '_' + Math.random().toString(36).substr(2, 4);

    const groupIdx = blueprint.groups.findIndex((group) => group.group_id === want.group_id);
    if (groupIdx === -1) {
      await db.query('ROLLBACK');
      throw new Error('Group not found in blueprint');
    }

    const group = blueprint.groups[groupIdx];
    const { entries: slotsToConsider, missing } = getSlotEntriesByIds(group, want.slot_ids);
    if (missing.length > 0) {
      await db.query('ROLLBACK');
      throw new Error(`Unknown slot ids requested: ${missing.join(', ')}`);
    }

    const requestedSlotIds = slotsToConsider.map(({ slot }) => slot.slot_id);
    console.log(`[SlotReq ${reqId}] Start: ${instanceKey} group=${want.group_id} slots=${requestedSlotIds.join(', ')}`);

    const { mondaiToDeliver, blueprintModified } = await prepareSlotContentsForDelivery({
      blueprint,
      group,
      groupIdx,
      slotsToConsider,
      userId: inst.rows[0]?.user_id || null
    });

    if (blueprintModified) {
      await db.query(
        'UPDATE exam_instances_cache SET blueprint=$1 WHERE instance_key=$2',
        [JSON.stringify(blueprint), instanceKey]
      );

      await recordServedMondaiHistory(db, {
        userId: inst.rows[0]?.user_id || null,
        instanceKey,
        blueprint
      });
    }

    await db.query('COMMIT');

    console.log(`[SlotReq ${reqId}] End: returned ${mondaiToDeliver.length} items: ${mondaiToDeliver.map((m) => m.slot_id || m.mondai_id).join(', ')}`);

    return {
      mondai: mondaiToDeliver,
      requestedSlotIds,
      readySlotIds: mondaiToDeliver.map((m) => m.slot_id || m.meta?.slot_id).filter(Boolean),
      done: group.mondai_slots.every((slot) => !!slot?.mondai_hash)
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
    const learnerHints = buildUserExamGenerationHints(user, { exam_id: examSpec.exam_id, level, mode });
    const variantKey = inferExamVariantKey(examSpec);
    const requestedMondaiIds = getRequestedMondaiIds(examSpec);
    const fallbackVariantKeys = inferPublishedVariantCandidates(requestedMondaiIds).filter((key) => key !== variantKey);
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

    const trySelectPublishedBlueprint = async () => {
      if (explicitRetake) return null;
      return selectPublishedExamBlueprint({
        userId,
        examId: examSpec.exam_id,
        level,
        mode,
        variantKey,
        fallbackVariantKeys,
        requestedMondaiIds,
        allowRepeat: repeatAllowed
      });
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

        const today = formatDateYmd();
        const publishedSelection = await trySelectPublishedBlueprint();
        let newBlueprint;
        let startPrefetchPromise = null;
        let seed = crypto.randomUUID();

        if (publishedSelection?.blueprint) {
          newBlueprint = cloneJson(publishedSelection.blueprint);
          if (!newBlueprint.meta) newBlueprint.meta = {};
          newBlueprint.meta.source = 'published-bank';
          newBlueprint.meta.published_exam_id = publishedSelection.id;
          newBlueprint.meta.variant_key = publishedSelection.variant_key || variantKey;
          newBlueprint.meta.bank_date_ymd = publishedSelection.bank_date_ymd || today;
          seed = newBlueprint.meta.seed || seed;
        } else {
          const snapshotId = await ensurePoolSnapshot(examSpec, level, today, plan, mode);
          await bootstrapRareBucketsForSnapshot(snapshotId, examSpec, level, mode);
          const generated = await buildExamBlueprint(
            examSpec,
            level,
            mode,
            seed,
            finalSetNo,
            plan,
            snapshotId,
            { userId, allowRepeat: repeatAllowed || explicitRetake, learnerHints }
          );
          newBlueprint = generated.blueprint;
          startPrefetchPromise = generated.startPrefetchPromise;
        }
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
          if (publishedSelection?.id) {
            await recordPublishedExamServed({
              userId,
              publishedExamId: publishedSelection.id,
              instanceKey: newInstanceKey
            });
          }

          instanceKey = newInstanceKey;
          blueprint = newBlueprint;
          attachStartPrefetchPersistence(instanceKey, userId, blueprint, startPrefetchPromise);
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
        const today = formatDateYmd();
        const publishedSelection = await trySelectPublishedBlueprint();
        let newBlueprint;
        let startPrefetchPromise = null;
        let seed = crypto.randomUUID();

        if (publishedSelection?.blueprint) {
          newBlueprint = cloneJson(publishedSelection.blueprint);
          if (!newBlueprint.meta) newBlueprint.meta = {};
          newBlueprint.meta.source = 'published-bank';
          newBlueprint.meta.published_exam_id = publishedSelection.id;
          newBlueprint.meta.variant_key = publishedSelection.variant_key || variantKey;
          newBlueprint.meta.bank_date_ymd = publishedSelection.bank_date_ymd || today;
          seed = newBlueprint.meta.seed || seed;
        } else {
          const snapshotId = await ensurePoolSnapshot(examSpec, level, today, plan, mode);
          await bootstrapRareBucketsForSnapshot(snapshotId, examSpec, level, mode);
          const generated = await buildExamBlueprint(
            examSpec,
            level,
            mode,
            seed,
            finalSetNo,
            plan,
            snapshotId,
            { userId, allowRepeat: repeatAllowed || explicitRetake, learnerHints }
          );
          newBlueprint = generated.blueprint;
          startPrefetchPromise = generated.startPrefetchPromise;
        }
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
          if (publishedSelection?.id) {
            await recordPublishedExamServed({
              userId,
              publishedExamId: publishedSelection.id,
              instanceKey: newInstanceKey
            });
          }

          instanceKey = newInstanceKey;
          blueprint = newBlueprint;
          attachStartPrefetchPersistence(instanceKey, userId, blueprint, startPrefetchPromise);
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
    const initialSlotIds = getInitialReadySlotIds(firstGroup);
    if (initialSlotIds.length === 0) {
      throw createTemporaryUnavailableError(new Error('Initial slots not ready'));
    }
    const firstChunk = await deliverRequestedSlots(instanceKey, {
      group_id: firstGroup.group_id,
      slot_ids: initialSlotIds
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

    const chunk = Array.isArray(want.slot_ids) && want.slot_ids.length > 0
      ? await deliverRequestedSlots(instanceKey, want)
      : await deliverNextChunk(instanceKey, want);

    res.json({
      chunk: sanitizeMondaiForClient({ mondai: chunk.mondai }).mondai,
      nextCursor: chunk.nextCursor,
      requestedSlotIds: chunk.requestedSlotIds,
      readySlotIds: chunk.readySlotIds,
      done: chunk.done
    });
  } catch (err) {
    console.error('Chunk V2 error:', err);
    if (isTemporaryUnavailableError(err)) {
      return res.status(503).json(getTemporaryUnavailablePayload(err));
    }
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

    for (const qId of Object.keys(answerMap)) {
      const correct = answerMap[qId];
      const userAns = Object.prototype.hasOwnProperty.call(answers || {}, qId) ? answers[qId] : null;
      const isCorrect = (userAns === correct);
      const isUnanswered = userAns === null || userAns === undefined;
      if (isCorrect) correctCount++;
      totalCount++;
      // Return full info for UI highlighting
      byQuestion[qId] = {
        is_correct: isCorrect,
        is_unanswered: isUnanswered,
        user_index: userAns,
        user_answer_index: userAns,
        correct_index: correct
      };
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
        total_score: correctCount,
        max_score: totalCount,
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
      console.log(`Daily Bank: ${DAILY_BANK_ENABLED ? (IS_VERCEL ? 'external-cron/admin endpoint' : 'startup+scheduler enabled') : 'disabled'}`);
      console.log(`Current-Day Rare Warm: ${CURRENT_DAY_RARE_BUCKET_WARM_ENABLED ? (IS_VERCEL ? 'disabled on vercel' : 'enabled') : 'disabled'}`);
    });

    if (!IS_VERCEL) {
      if (DAILY_BANK_ENABLED) {
        const dailyBankStartupPromise = maybeRunDailyBankOnStartup();
        void dailyBankStartupPromise.catch((error) => {
          console.error('[DailyBank] Startup catch-up failed:', error);
        });
        void dailyBankStartupPromise.finally(() => {
          void maybeSeedCurrentDayRareBucketsOnStartup().catch((error) => {
            console.error('[RareWarm] Startup scheduling failed:', error);
          });
        });
        scheduleDailyBankWorkflowLoop();
      } else {
        void maybeSeedCurrentDayRareBucketsOnStartup().catch((error) => {
          console.error('[RareWarm] Startup scheduling failed:', error);
        });
      }
    }
  })();
}

module.exports = app;



















































