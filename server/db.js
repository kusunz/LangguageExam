// Database module with Neon DB mode support
// DB_MODE: 'neon' = strict DB-required mode, 'auto' = fallback allowed

const DB_MODE = process.env.DB_MODE || 'auto';
const IS_NEON_MODE = DB_MODE === 'neon';
const IS_VERCEL = process.env.VERCEL === '1' || !!process.env.VERCEL_ENV;

let pool = null;
let sql = null;
let driverType = 'none';

console.log(`[DB] Mode: ${DB_MODE}, Neon strict: ${IS_NEON_MODE}`);

try {
  // In Neon mode or on Vercel, prefer serverless driver
  if ((IS_NEON_MODE || IS_VERCEL) && process.env.DATABASE_URL) {
    const neonModule = require('@neondatabase/serverless');
    sql = neonModule.neon(process.env.DATABASE_URL);
    driverType = 'neon-serverless';
    console.log('[DB] Driver: @neondatabase/serverless');
  } else if (process.env.DATABASE_URL) {
    const pg = require('pg');
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DB_SSL === 'false' ? undefined : { rejectUnauthorized: false },
      connectionTimeoutMillis: 30000,
      idleTimeoutMillis: 30000,
      max: 10
    });
    driverType = 'pg';
    console.log('[DB] Driver: pg Pool');
  } else {
    console.log('[DB] No DATABASE_URL configured');
    if (IS_NEON_MODE) {
      console.error('[DB] FATAL: Neon mode requires DATABASE_URL');
    }
  }
} catch (e) {
  console.error('[DB] Driver creation error:', e?.message || e);
}

async function query(text, params = []) {
  if (sql) {
    // Neon serverless driver: handle both callable `sql(text, params)` and `sql.query(text, params)`
    // Some versions/configurations differ.
    let result;
    if (typeof sql === 'function') {
      result = await sql(text, params); // Tagged template literal style or function call
    } else {
      result = await sql.query(text, params);
    }

    // Normalize: Neon usually returns just the array of rows
    return { rows: Array.isArray(result) ? result : (result?.rows || []) };
  }
  if (pool) {
    // pg Pool already returns { rows, fields, etc }
    return pool.query(text, params);
  }
  throw new Error('No database connection available');
}

let initPromise = null;

async function initDb() {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    if (!pool && !sql) {
      console.error('[DB] No connection configured');
      return false;
    }

    try {
      // Fast connectivity check using wrapper
      await query('SELECT 1 AS test');
      console.log('[DB] Connection OK');

      // Only run migrations if explicitly requested via env var
      // Default: DO NOT run migrations (assume manual SQL or production setup)
      const runMigrations = process.env.DB_RUN_MIGRATIONS === '1';

      if (!runMigrations) {
        console.log('[DB] Skipping migrations (DB_RUN_MIGRATIONS != 1)');
        return true;
      }

      console.log('[DB] Running migrations...');

      const migrations = [
        `CREATE EXTENSION IF NOT EXISTS pgcrypto`,
        `CREATE EXTENSION IF NOT EXISTS vector`,

        // Users table
        `CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL,
          nickname TEXT,
          data JSONB DEFAULT '{}',
          created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          last_login_at TIMESTAMPTZ
        )`,

        // Sessions table
        `CREATE TABLE IF NOT EXISTS sessions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
          token TEXT NOT NULL,
          created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          expires_at TIMESTAMPTZ NOT NULL
        )`,
        `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
        `CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`,

        // Exam results table
        `CREATE TABLE IF NOT EXISTS exam_results (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
          exam_type TEXT NOT NULL,
          level TEXT NOT NULL,
          mode TEXT NOT NULL,
          section TEXT,
          score INTEGER NOT NULL,
          total INTEGER NOT NULL,
          duration INTEGER,
          details JSONB,
          created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE INDEX IF NOT EXISTS idx_results_user ON exam_results(user_id)`,

        // Questions table
        `CREATE TABLE IF NOT EXISTS questions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          exam_type TEXT NOT NULL,
          level TEXT NOT NULL,
          group_type TEXT NOT NULL,
          content JSONB NOT NULL,
          hash TEXT UNIQUE,
          usage_count INTEGER DEFAULT 0,
          created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE INDEX IF NOT EXISTS idx_questions_exam ON questions(exam_type, level, group_type)`,

        // User notebook table
        `CREATE TABLE IF NOT EXISTS user_notebook (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
          question_id UUID REFERENCES questions(id),
          item_type TEXT NOT NULL,
          content JSONB NOT NULL,
          tags TEXT[],
          mastery_level INTEGER DEFAULT 0,
          last_reviewed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE INDEX IF NOT EXISTS idx_notebook_user ON user_notebook(user_id)`,

        // Exam sessions table
        `CREATE TABLE IF NOT EXISTS exam_sessions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
          exam_type TEXT NOT NULL,
          level TEXT NOT NULL,
          mode TEXT NOT NULL,
          state JSONB,
          started_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          completed_at TIMESTAMPTZ
        )`,

        // Pool snapshots table (V2) - uses date_ymd TEXT for consistency
        `CREATE TABLE IF NOT EXISTS pool_snapshots (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          exam_id TEXT NOT NULL,
          level TEXT NOT NULL,
          mode TEXT NOT NULL,
          date_ymd TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'ready',
          seed BIGINT,
          prompt_hash TEXT,
          model TEXT,
          params JSONB,
          UNIQUE(exam_id, level, mode, date_ymd)
        )`,
        `CREATE INDEX IF NOT EXISTS idx_pool_snapshots_lookup
          ON pool_snapshots(exam_id, level, mode, date_ymd)`,


        // Mondai bank table (V2)
        `CREATE TABLE IF NOT EXISTS mondai_bank (
          hash TEXT PRIMARY KEY,
          exam_id TEXT NOT NULL,
          level TEXT,
          group_id TEXT NOT NULL,
          mondai_id TEXT,
          mondai_idx INTEGER,
          base_type TEXT,
          primary_type TEXT,
          content JSONB NOT NULL,
          meta JSONB,
          embedding VECTOR(768),
          usage_count INTEGER DEFAULT 0,
          avg_score REAL,
          created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE INDEX IF NOT EXISTS idx_mondai_lookup ON mondai_bank(exam_id, group_id)`,

        // Pool snapshot items table (V2)
        `CREATE TABLE IF NOT EXISTS pool_snapshot_items (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          snapshot_id UUID NOT NULL REFERENCES pool_snapshots(id) ON DELETE CASCADE,
          mondai_hash TEXT NOT NULL REFERENCES mondai_bank(hash) ON DELETE CASCADE,
          group_id TEXT NOT NULL,
          bucket_key TEXT NOT NULL,
          created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(snapshot_id, bucket_key, mondai_hash)
        )`,
        `CREATE INDEX IF NOT EXISTS idx_snapshot_items_lookup
          ON pool_snapshot_items(snapshot_id, bucket_key)`,

        // Exam instances cache table
        `CREATE TABLE IF NOT EXISTS exam_instances_cache (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          instance_key TEXT UNIQUE NOT NULL,
          user_id TEXT NOT NULL,
          exam_id TEXT NOT NULL,
          level TEXT NOT NULL,
          mode TEXT NOT NULL,
          set_no INTEGER NOT NULL,
          blueprint JSONB NOT NULL,
          delivery_state JSONB,
          answer_keys JSONB,
          created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          expires_at TIMESTAMPTZ DEFAULT (CURRENT_TIMESTAMP + INTERVAL '3 days'),
          UNIQUE(user_id, exam_id, level, mode, set_no)
        )`,
        `CREATE INDEX IF NOT EXISTS idx_instances_user ON exam_instances_cache(user_id)`,
        `CREATE INDEX IF NOT EXISTS idx_instances_expires ON exam_instances_cache(expires_at)`,

        // Attempts table (V2: added status, summary for quickgrade)
        `CREATE TABLE IF NOT EXISTS attempts (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id TEXT NOT NULL,
          instance_key TEXT REFERENCES exam_instances_cache(instance_key) ON DELETE CASCADE,
          status TEXT DEFAULT 'started',
          summary JSONB,
          started_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          submitted_at TIMESTAMPTZ,
          answers JSONB,
          score INTEGER,
          total INTEGER,
          time_spent INTEGER,
          UNIQUE(user_id, instance_key)
        )`,
        `CREATE INDEX IF NOT EXISTS idx_attempts_user ON attempts(user_id)`,
        `CREATE INDEX IF NOT EXISTS idx_attempts_instance ON attempts(instance_key)`,

        // Coupons table
        `CREATE TABLE IF NOT EXISTS coupons (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          code TEXT UNIQUE NOT NULL,
          type TEXT NOT NULL,
          value JSONB NOT NULL,
          max_uses INTEGER,
          current_uses INTEGER DEFAULT 0,
          expires_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE INDEX IF NOT EXISTS idx_coupons_code ON coupons(code)`,

        // Coupon redemptions table
        `CREATE TABLE IF NOT EXISTS coupon_redemptions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          coupon_id UUID REFERENCES coupons(id),
          user_id TEXT REFERENCES users(id),
          redeemed_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(coupon_id, user_id)
        )`,

        // TTS metrics table
        `CREATE TABLE IF NOT EXISTS tts_metrics (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          provider TEXT NOT NULL,
          text_length INTEGER NOT NULL,
          latency_ms INTEGER NOT NULL,
          success BOOLEAN NOT NULL,
          error TEXT,
          created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`,

        // Published exams table
        `CREATE TABLE IF NOT EXISTS published_exams (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          exam_id TEXT NOT NULL,
          level TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT,
          is_active BOOLEAN DEFAULT true,
          created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(exam_id, level, title)
        )`,

        // Published exam parts table
        `CREATE TABLE IF NOT EXISTS published_exam_parts (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          published_exam_id UUID REFERENCES published_exams(id) ON DELETE CASCADE,
          group_id TEXT NOT NULL,
          mondai_hashes JSONB NOT NULL,
          meta JSONB
        )`,
        `CREATE INDEX IF NOT EXISTS idx_published_parts_exam ON published_exam_parts(published_exam_id)`,

        /* ================= SELF-HEALING MIGRATIONS (Safe ALTERs) ================= */
        /* Ensures existing tables (from prior deployments) get new columns */

        `DO $$ BEGIN
          -- pool_snapshots: ensure date_ymd exists (TEXT)
          BEGIN
            ALTER TABLE pool_snapshots ADD COLUMN IF NOT EXISTS date_ymd TEXT;
          EXCEPTION WHEN others THEN NULL; END;
          
           -- mondai_bank: ensure estimated_cost and other new cols
          BEGIN
            ALTER TABLE mondai_bank ADD COLUMN IF NOT EXISTS estimated_cost INTEGER;
            ALTER TABLE mondai_bank ADD COLUMN IF NOT EXISTS embedding VECTOR(768);
            ALTER TABLE mondai_bank ADD COLUMN IF NOT EXISTS primary_type TEXT;
            ALTER TABLE mondai_bank ADD COLUMN IF NOT EXISTS item_type TEXT;
            ALTER TABLE mondai_bank ADD COLUMN IF NOT EXISTS base_type TEXT;
          EXCEPTION WHEN others THEN NULL; END;

          -- exam_instances_cache: ensure answer_keys
          BEGIN
            ALTER TABLE exam_instances_cache ADD COLUMN IF NOT EXISTS answer_keys JSONB;
          EXCEPTION WHEN others THEN NULL; END;

          -- attempts: ensure status, summary columns for quickgrade (V2)
          BEGIN
            ALTER TABLE attempts ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'started';
            ALTER TABLE attempts ADD COLUMN IF NOT EXISTS summary JSONB;
          EXCEPTION WHEN others THEN NULL; END;

          -- attempts: add unique constraint if missing (for UPSERT)
          BEGIN
            ALTER TABLE attempts ADD CONSTRAINT attempts_user_instance_unique UNIQUE (user_id, instance_key);
          EXCEPTION WHEN duplicate_object THEN NULL; WHEN others THEN NULL; END;
          
        END $$;`
      ];

      const combined = migrations.join(';\n');
      await query(combined);

      console.log('[DB] Migrations complete');
      return true;
    } catch (e) {
      console.error('[DB] initDb error:', {
        message: e?.message,
        code: e?.code,
        detail: e?.detail
      });
      return false;
    }
  })();

  return initPromise;
}

/**
 * Check if DB is configured and init has been attempted
 */
function isDbReady() {
  return !!(pool || sql);
}

module.exports = {
  pool,
  sql,
  query,
  initDb,
  isDbReady,
  DB_MODE,
  IS_NEON_MODE,
  IS_VERCEL,
  driverType
};

