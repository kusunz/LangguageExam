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

async function ensureCriticalSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS user_mondai_history (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT NOT NULL,
      mondai_hash TEXT NOT NULL REFERENCES mondai_bank(hash) ON DELETE CASCADE,
      first_served_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      last_served_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      serve_count INTEGER DEFAULT 1,
      last_instance_key TEXT,
      UNIQUE(user_id, mondai_hash)
    )
  `);

  await query(`
    ALTER TABLE user_mondai_history
      ADD COLUMN IF NOT EXISTS first_served_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      ADD COLUMN IF NOT EXISTS last_served_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      ADD COLUMN IF NOT EXISTS serve_count INTEGER DEFAULT 1,
      ADD COLUMN IF NOT EXISTS last_instance_key TEXT
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_user_mondai_history_user
    ON user_mondai_history(user_id, last_served_at)
  `);

  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_mondai_history_unique
    ON user_mondai_history(user_id, mondai_hash)
  `);
}

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
      await ensureCriticalSchema();

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
        `DO $$ BEGIN
          CREATE INDEX IF NOT EXISTS idx_questions_exam ON questions(exam_type, level, group_type);
         EXCEPTION WHEN others THEN NULL; END $$`,

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
          expires_at TIMESTAMPTZ DEFAULT (CURRENT_TIMESTAMP + INTERVAL '30 days'),
          UNIQUE(exam_id, level, mode, date_ymd)
        )`,
        `CREATE INDEX IF NOT EXISTS idx_pool_snapshots_lookup
          ON pool_snapshots(exam_id, level, mode, date_ymd)`,
        `DO $$ BEGIN
            CREATE INDEX IF NOT EXISTS idx_pool_snapshots_expiry
            ON pool_snapshots(expires_at);
          EXCEPTION WHEN undefined_column THEN NULL; WHEN others THEN NULL; END $$`,


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
          plan TEXT,
          seed TEXT,
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
        `CREATE INDEX IF NOT EXISTS idx_instances_lookup
          ON exam_instances_cache(user_id, exam_id, level, mode, set_no)`,
        `CREATE INDEX IF NOT EXISTS idx_instances_resume
          ON exam_instances_cache(user_id, exam_id, level, mode, created_at DESC)`,

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

        // User mondai history table (anti-repeat)
        `CREATE TABLE IF NOT EXISTS user_mondai_history (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id TEXT NOT NULL,
          mondai_hash TEXT NOT NULL REFERENCES mondai_bank(hash) ON DELETE CASCADE,
          first_served_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          last_served_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          serve_count INTEGER DEFAULT 1,
          last_instance_key TEXT,
          UNIQUE(user_id, mondai_hash)
        )`,
        `CREATE INDEX IF NOT EXISTS idx_user_mondai_history_user
          ON user_mondai_history(user_id, last_served_at)`,
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_user_mondai_history_unique
          ON user_mondai_history(user_id, mondai_hash)`,

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
          mode TEXT,
          variant_key TEXT,
          set_no INTEGER,
          bank_date_ymd TEXT,
          title TEXT NOT NULL,
          description TEXT,
          is_active BOOLEAN DEFAULT true,
          blueprint JSONB,
          meta JSONB,
          snapshot_id UUID REFERENCES pool_snapshots(id) ON DELETE SET NULL,
          expires_at TIMESTAMPTZ DEFAULT (CURRENT_TIMESTAMP + INTERVAL '30 days'),
          created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(exam_id, level, mode, variant_key, bank_date_ymd, set_no)
        )`,
        `DO $$ BEGIN
            CREATE INDEX IF NOT EXISTS idx_published_exams_lookup
            ON published_exams(exam_id, level, mode, variant_key, bank_date_ymd);
          EXCEPTION WHEN undefined_column THEN NULL; WHEN others THEN NULL; END $$`,
        `DO $$ BEGIN
            CREATE INDEX IF NOT EXISTS idx_published_exams_expiry
            ON published_exams(expires_at);
          EXCEPTION WHEN undefined_column THEN NULL; WHEN others THEN NULL; END $$`,

        // Published exam parts table
        `CREATE TABLE IF NOT EXISTS published_exam_parts (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          published_exam_id UUID REFERENCES published_exams(id) ON DELETE CASCADE,
          group_id TEXT NOT NULL,
          mondai_hashes JSONB NOT NULL,
          meta JSONB
        )`,
        `CREATE INDEX IF NOT EXISTS idx_published_parts_exam ON published_exam_parts(published_exam_id)`,

        // User published exam history table
        `CREATE TABLE IF NOT EXISTS user_published_exam_history (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id TEXT NOT NULL,
          published_exam_id UUID NOT NULL REFERENCES published_exams(id) ON DELETE CASCADE,
          first_served_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          last_served_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          serve_count INTEGER DEFAULT 1,
          last_instance_key TEXT,
          UNIQUE(user_id, published_exam_id)
        )`,
        `CREATE INDEX IF NOT EXISTS idx_user_published_exam_history_user
          ON user_published_exam_history(user_id, last_served_at)`,

        /* ================= SELF-HEALING MIGRATIONS (Safe ALTERs) ================= */
        /* Ensures existing tables (from prior deployments) get new columns */

        `DO $$ BEGIN
          -- pool_snapshots: ensure date_ymd exists (TEXT)
          BEGIN
            ALTER TABLE pool_snapshots ADD COLUMN IF NOT EXISTS date_ymd TEXT;
            ALTER TABLE pool_snapshots ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'ready';
            ALTER TABLE pool_snapshots ADD COLUMN IF NOT EXISTS seed BIGINT;
            ALTER TABLE pool_snapshots ADD COLUMN IF NOT EXISTS prompt_hash TEXT;
            ALTER TABLE pool_snapshots ADD COLUMN IF NOT EXISTS model TEXT;
            ALTER TABLE pool_snapshots ADD COLUMN IF NOT EXISTS params JSONB;
            ALTER TABLE pool_snapshots ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ DEFAULT (CURRENT_TIMESTAMP + INTERVAL '30 days');
            CREATE INDEX IF NOT EXISTS idx_pool_snapshots_lookup ON pool_snapshots(exam_id, level, mode, date_ymd);
            CREATE INDEX IF NOT EXISTS idx_pool_snapshots_expiry ON pool_snapshots(expires_at);
            ALTER TABLE pool_snapshots
              ADD CONSTRAINT pool_snapshots_exam_level_mode_date_unique
              UNIQUE (exam_id, level, mode, date_ymd);
          EXCEPTION WHEN duplicate_object THEN NULL; WHEN others THEN NULL; END;

          BEGIN
            ALTER TABLE pool_snapshots
              ADD CONSTRAINT pool_snapshots_exam_level_mode_date_ymd_key
              UNIQUE (exam_id, level, mode, date_ymd);
          EXCEPTION WHEN others THEN NULL; END;
          
           -- mondai_bank: ensure estimated_cost and other new cols
          BEGIN
            ALTER TABLE mondai_bank ADD COLUMN IF NOT EXISTS estimated_cost INTEGER;
            ALTER TABLE mondai_bank ADD COLUMN IF NOT EXISTS embedding VECTOR(768);
            ALTER TABLE mondai_bank ADD COLUMN IF NOT EXISTS primary_type TEXT;
            ALTER TABLE mondai_bank ADD COLUMN IF NOT EXISTS item_type TEXT;
            ALTER TABLE mondai_bank ADD COLUMN IF NOT EXISTS base_type TEXT;
          EXCEPTION WHEN others THEN NULL; END;

          -- exam_instances_cache: ensure answer_keys + runtime columns
          BEGIN
            ALTER TABLE exam_instances_cache ADD COLUMN IF NOT EXISTS answer_keys JSONB;
            ALTER TABLE exam_instances_cache ADD COLUMN IF NOT EXISTS plan TEXT;
            ALTER TABLE exam_instances_cache ADD COLUMN IF NOT EXISTS seed TEXT;
            CREATE INDEX IF NOT EXISTS idx_instances_lookup ON exam_instances_cache(user_id, exam_id, level, mode, set_no);
            CREATE INDEX IF NOT EXISTS idx_instances_resume ON exam_instances_cache(user_id, exam_id, level, mode, created_at DESC);
          EXCEPTION WHEN others THEN NULL; END;

          -- attempts: ensure status, summary, answers_hash, ai_grade columns for V2 grading
          BEGIN
            ALTER TABLE attempts ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'started';
            ALTER TABLE attempts ADD COLUMN IF NOT EXISTS summary JSONB;
            ALTER TABLE attempts ADD COLUMN IF NOT EXISTS answers_hash TEXT;
            ALTER TABLE attempts ADD COLUMN IF NOT EXISTS ai_grade JSONB;
          EXCEPTION WHEN others THEN NULL; END;

          -- attempts: add unique constraint if missing (for UPSERT)
          BEGIN
            ALTER TABLE attempts ADD CONSTRAINT attempts_user_instance_unique UNIQUE (user_id, instance_key);
          EXCEPTION WHEN duplicate_object THEN NULL; WHEN others THEN NULL; END;

          -- user_mondai_history: ensure anti-repeat columns and constraint
          BEGIN
            CREATE TABLE IF NOT EXISTS user_mondai_history (
              id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
              user_id TEXT NOT NULL,
              mondai_hash TEXT NOT NULL REFERENCES mondai_bank(hash) ON DELETE CASCADE,
              first_served_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
              last_served_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
              serve_count INTEGER DEFAULT 1,
              last_instance_key TEXT,
              UNIQUE(user_id, mondai_hash)
            );
            ALTER TABLE user_mondai_history ADD COLUMN IF NOT EXISTS first_served_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP;
            ALTER TABLE user_mondai_history ADD COLUMN IF NOT EXISTS last_served_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP;
            ALTER TABLE user_mondai_history ADD COLUMN IF NOT EXISTS serve_count INTEGER DEFAULT 1;
            ALTER TABLE user_mondai_history ADD COLUMN IF NOT EXISTS last_instance_key TEXT;
            CREATE INDEX IF NOT EXISTS idx_user_mondai_history_user ON user_mondai_history(user_id, last_served_at);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_user_mondai_history_unique ON user_mondai_history(user_id, mondai_hash);
          EXCEPTION WHEN others THEN NULL; END;

          -- published_exams + daily bank support columns
          BEGIN
            ALTER TABLE published_exams ADD COLUMN IF NOT EXISTS mode TEXT;
            ALTER TABLE published_exams ADD COLUMN IF NOT EXISTS variant_key TEXT;
            ALTER TABLE published_exams ADD COLUMN IF NOT EXISTS set_no INTEGER;
            ALTER TABLE published_exams ADD COLUMN IF NOT EXISTS bank_date_ymd TEXT;
            ALTER TABLE published_exams ADD COLUMN IF NOT EXISTS blueprint JSONB;
            ALTER TABLE published_exams ADD COLUMN IF NOT EXISTS meta JSONB;
            ALTER TABLE published_exams ADD COLUMN IF NOT EXISTS snapshot_id UUID;
            ALTER TABLE published_exams ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ DEFAULT (CURRENT_TIMESTAMP + INTERVAL '30 days');
            CREATE INDEX IF NOT EXISTS idx_published_exams_lookup ON published_exams(exam_id, level, mode, variant_key, bank_date_ymd);
            CREATE INDEX IF NOT EXISTS idx_published_exams_expiry ON published_exams(expires_at);
            ALTER TABLE published_exams DROP CONSTRAINT IF EXISTS published_exams_exam_id_level_title_key;
            ALTER TABLE published_exams ADD CONSTRAINT published_exams_daily_variant_unique UNIQUE (exam_id, level, mode, variant_key, bank_date_ymd, set_no);
          EXCEPTION WHEN duplicate_object THEN NULL; WHEN others THEN NULL; END;

          -- user published exam history
          BEGIN
            CREATE TABLE IF NOT EXISTS user_published_exam_history (
              id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
              user_id TEXT NOT NULL,
              published_exam_id UUID NOT NULL REFERENCES published_exams(id) ON DELETE CASCADE,
              first_served_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
              last_served_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
              serve_count INTEGER DEFAULT 1,
              last_instance_key TEXT,
              UNIQUE(user_id, published_exam_id)
            );
            ALTER TABLE user_published_exam_history ADD COLUMN IF NOT EXISTS first_served_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP;
            ALTER TABLE user_published_exam_history ADD COLUMN IF NOT EXISTS last_served_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP;
            ALTER TABLE user_published_exam_history ADD COLUMN IF NOT EXISTS serve_count INTEGER DEFAULT 1;
            ALTER TABLE user_published_exam_history ADD COLUMN IF NOT EXISTS last_instance_key TEXT;
            CREATE INDEX IF NOT EXISTS idx_user_published_exam_history_user ON user_published_exam_history(user_id, last_served_at);
          EXCEPTION WHEN others THEN NULL; END;
          
        END $$;`
      ];

      for (const statement of migrations) {
        await query(statement);
      }

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


