const crypto = require("crypto");
function toUserUuid(userId) {
  if (typeof userId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
    return userId;
  }
  const hash = crypto.createHash("sha256").update(String(userId || "anonymous-user")).digest("hex");
  return hash.slice(0, 8) + "-" + hash.slice(8, 12) + "-4" + hash.slice(13, 16) + "-8" + hash.slice(17, 20) + "-" + hash.slice(20, 32);
}


'use strict';

const fetch = require('node-fetch'); // wait, node v22 has global fetch

const DASHBOARD_API_URL = process.env.DASHBOARD_API_URL || 'https://dasun.app';
const DASHBOARD_APP_KEY = process.env.DASHBOARD_APP_KEY || process.env.INTERNAL_APP_KEY || 'japanesePractice';
const DASHBOARD_SERVICE_TOKEN = process.env.DASHBOARD_SERVICE_TOKEN || process.env.INTERNAL_SERVICE_TOKEN || process.env.OAUTH_SERVICE_TOKEN || '';

const VALID_LEVELS = ['N5', 'N4', 'N3', 'N2', 'N1', 'HSK1', 'HSK2', 'HSK3', 'HSK4', 'HSK5', 'HSK6'];
const DEFAULT_TIER = 'free';

const LEVEL_COSTS = {
  N5: 3, N4: 5, N3: 7, N2: 10, N1: 15,
  HSK1: 2, HSK2: 3, HSK3: 5, HSK4: 7, HSK5: 10, HSK6: 15
};

const MODE_MULTIPLIERS = {
  official: 1.0, standard: 0.7, basic: 0.5
};

const SECTION_FRACTION = 0.2;

function getLevelBaseCost(level) { return LEVEL_COSTS[level] || LEVEL_COSTS.N2; }
function getModeMultiplier(mode) { const key = String(mode || 'official').toLowerCase(); return MODE_MULTIPLIERS[key] || 1.0; }
function isFullExam(sections) { if (!sections || sections.length === 0) return true; return sections.includes('full'); }

function calculateExamCost(level, mode, sections) {
  const baseCost = getLevelBaseCost(level);
  const modeMult = getModeMultiplier(mode);
  const full = isFullExam(sections);
  const rawCost = baseCost * modeMult * (full ? 1.0 : SECTION_FRACTION);
  return Math.max(1, Math.round(rawCost));
}

function getCreditCostBreakdown(level, mode, sections) {
  const baseCost = getLevelBaseCost(level);
  const modeMult = getModeMultiplier(mode);
  const full = isFullExam(sections);
  const sectionFraction = full ? 1.0 : SECTION_FRACTION;
  const rawCost = baseCost * modeMult * sectionFraction;
  return {
    baseCost, modeMultiplier: modeMult, sectionFraction, fullExam: full,
    creditCost: Math.max(1, Math.round(rawCost))
  };
}

// Remove local DB init
async function initCreditsTable(db) {
  console.log('[CREDITS] Using remote Dashboard API for credits. No local table init needed.');
}

async function getUserUsage(db, userId) {
  if (!userId) {
    return { daily_quota_allowance: 15, daily_quota_consumed: 0, daily_quota_remaining: 15, shared_purchased_credit_balance: 0 };
  }
  const targetUuid = toUserUuid(userId);

  try {
    const res = await fetch(`${DASHBOARD_API_URL}/api/internal/credits/balance?user_id=${targetUuid}`, {
      headers: {
        'x-app-key': DASHBOARD_APP_KEY,
        'x-service-token': DASHBOARD_SERVICE_TOKEN,
      },
    });

    if (!res.ok) {
      console.warn('[CREDITS] Balance API error:', res.status, await res.text());
      return null;
    }

    const data = await res.json();
    return data;
  } catch (e) {
    console.error('[CREDITS] getUserUsage error:', e?.message || e);
    return null;
  }
}

async function checkAndDeductCredits(db, userId, planKey, cost, idempotencyKey) {
  if (!userId || String(userId).startsWith('demo') || userId === 'demo-user') {
    return { ok: true, used: cost, total: 15, remaining: 15 - cost, cost }; // Mock for demo
  }

  try {
    const res = await fetch(`${DASHBOARD_API_URL}/api/internal/credits/consume`, {
      method: 'POST',
      headers: {
        'x-app-key': DASHBOARD_APP_KEY,
        'x-service-token': DASHBOARD_SERVICE_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        user_id: userId,
        app_key: DASHBOARD_APP_KEY,
        amount: cost,
        idempotency_key: idempotencyKey || `exam_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
        description: 'Practice Exam Generation'
      })
    });

    const data = await res.json();
    if (!res.ok) {
      if (res.status === 402) {
        return {
          ok: false,
          code: 'CREDITS_EXHAUSTED',
          message: data.message || 'Credit quota exhausted. Please upgrade or purchase credits.',
          cost
        };
      }
      return { ok: false, code: 'CREDITS_ERROR', message: data.message || 'Failed to consume credits', cost };
    }

    return {
      ok: true,
      remaining: data.remainingDaily + data.remainingPurchased, // combined visual for legacy usage if needed
      used: cost,
      total: data.consumedFromDaily + data.consumedFromPurchased, // not exactly total but enough to satisfy old return type
      cost,
      breakdown: data
    };
  } catch (e) {
    console.error('[CREDITS] checkAndDeduct error:', e?.message || e);
    return {
      ok: false,
      code: 'CREDITS_ERROR',
      message: 'Unable to verify credit quota.',
      cost
    };
  }
}

module.exports = {
  DEFAULT_TIER,
  LEVEL_COSTS,
  MODE_MULTIPLIERS,
  SECTION_FRACTION,
  VALID_LEVELS,
  initCreditsTable,
  getLevelBaseCost,
  getModeMultiplier,
  isFullExam,
  calculateExamCost,
  getCreditCostBreakdown,
  getUserUsage,
  checkAndDeductCredits
};
