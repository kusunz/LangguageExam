'use strict';

/**
 * Credit / quota system for exam generation.
 * Plan key comes from dasun.app entitlements (global_plan_keys / app_plan_keys).
 * Credits reset daily at UTC midnight.
 */

const VALID_LEVELS = ['N5', 'N4', 'N3', 'N2', 'N1'];
const DEFAULT_TIER = 'free';

const TIER_DAILY_CREDITS = {
  demo: 15,
  free: 30,
  pro: 100,
  premium: 300,
  elite: 300
};

const LEVEL_COSTS = {
  N5: 3,
  N4: 5,
  N3: 7,
  N2: 10,
  N1: 15
};

const MODE_MULTIPLIERS = {
  official: 1.0,
  standard: 0.7,
  basic: 0.5
};

const SECTION_FRACTION = 0.2;

function getDailyCredits(planKey) {
  const key = String(planKey || DEFAULT_TIER).toLowerCase();
  if (key === 'demo') return 15;
  return TIER_DAILY_CREDITS[key] || TIER_DAILY_CREDITS[DEFAULT_TIER];
}

function getLevelBaseCost(level) {
  return LEVEL_COSTS[level] || LEVEL_COSTS.N2;
}

function getModeMultiplier(mode) {
  const key = String(mode || 'official').toLowerCase();
  return MODE_MULTIPLIERS[key] || 1.0;
}

function isFullExam(sections) {
  if (!sections || sections.length === 0) return true;
  return sections.includes('full');
}

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
    baseCost,
    modeMultiplier: modeMult,
    sectionFraction,
    fullExam: full,
    creditCost: Math.max(1, Math.round(rawCost))
  };
}

const CREDITS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS user_credit_usage (
  user_id TEXT NOT NULL,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  credits_used INTEGER DEFAULT 0,
  credits_total INTEGER NOT NULL,
  plan_key TEXT NOT NULL DEFAULT 'free',
  PRIMARY KEY (user_id, date)
)
`;

const CREDITS_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_user_credit_usage_date
ON user_credit_usage(user_id, date DESC)
`;

async function initCreditsTable(db) {
  try {
    await db.query(CREDITS_TABLE_SQL);
    await db.query(CREDITS_INDEX_SQL);
  } catch (e) {
    console.error('[CREDITS] Failed to init credits table:', e?.message || e);
  }
}

function getUtcDateKey() {
  return new Date().toISOString().split('T')[0];
}

async function getUserUsage(db, userId) {
  const dateKey = getUtcDateKey();
  try {
    const res = await db.query(
      'SELECT credits_used, credits_total, plan_key FROM user_credit_usage WHERE user_id=$1 AND date=$2',
      [userId, dateKey]
    );
    if (res.rows.length === 0) return null;
    return {
      date: dateKey,
      used: Number.parseInt(res.rows[0].credits_used || '0', 10),
      total: Number.parseInt(res.rows[0].credits_total || '0', 10),
      planKey: res.rows[0].plan_key || DEFAULT_TIER
    };
  } catch (e) {
    console.error('[CREDITS] getUserUsage error:', e?.message || e);
    return null;
  }
}

function getRemainingCredits(usage) {
  const defaultDaily = TIER_DAILY_CREDITS[DEFAULT_TIER];
  if (!usage) return { used: 0, total: defaultDaily, remaining: defaultDaily, planKey: DEFAULT_TIER };
  const total = usage.total || TIER_DAILY_CREDITS[usage.planKey] || defaultDaily;
  return {
    used: usage.used,
    total: total,
    remaining: Math.max(0, total - usage.used),
    planKey: usage.planKey
  };
}

async function checkAndDeductCredits(db, userId, planKey, cost) {
  const dateKey = getUtcDateKey();
  const isDemo = !userId || String(userId).startsWith('demo') || userId === 'demo-user';
  const effectivePlan = isDemo ? 'demo' : (planKey || DEFAULT_TIER);
  const dailyTotal = getDailyCredits(effectivePlan);

  try {
    await db.query(
      `INSERT INTO user_credit_usage (user_id, date, credits_used, credits_total, plan_key)
       VALUES ($1, $2, 0, $3, $4)
       ON CONFLICT (user_id, date) DO UPDATE SET plan_key = $4, credits_total = $3`,
      [userId, dateKey, dailyTotal, planKey || DEFAULT_TIER]
    );

    const res = await db.query(
      'SELECT credits_used, credits_total FROM user_credit_usage WHERE user_id=$1 AND date=$2',
      [userId, dateKey]
    );

    const used = Number.parseInt(res.rows[0].credits_used || '0', 10);
    const total = Number.parseInt(res.rows[0].credits_total || String(dailyTotal), 10);
    const remaining = Math.max(0, total - used);

    if (remaining < cost) {
      return {
        ok: false,
        code: 'CREDITS_EXHAUSTED',
        message: 'Credit quota exhausted for today. Resets at UTC midnight.',
        remaining,
        used,
        total,
        cost
      };
    }

    await db.query(
      'UPDATE user_credit_usage SET credits_used = credits_used + $1 WHERE user_id=$2 AND date=$3',
      [cost, userId, dateKey]
    );

    return {
      ok: true,
      remaining: remaining - cost,
      used: used + cost,
      total,
      cost
    };
  } catch (e) {
    console.error('[CREDITS] checkAndDeduct error:', e?.message || e);
    return {
      ok: false,
      code: 'CREDITS_ERROR',
      message: 'Unable to verify credit quota.',
      remaining: 0,
      used: 0,
      total: dailyTotal,
      cost
    };
  }
}

module.exports = {
  DEFAULT_TIER,
  TIER_DAILY_CREDITS,
  LEVEL_COSTS,
  MODE_MULTIPLIERS,
  SECTION_FRACTION,
  VALID_LEVELS,
  CREDITS_TABLE_SQL,
  CREDITS_INDEX_SQL,
  initCreditsTable,
  getDailyCredits,
  getLevelBaseCost,
  getModeMultiplier,
  isFullExam,
  calculateExamCost,
  getCreditCostBreakdown,
  getUtcDateKey,
  getUserUsage,
  getRemainingCredits,
  checkAndDeductCredits
};
