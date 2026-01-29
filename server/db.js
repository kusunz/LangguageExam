// Use Neon serverless driver on Vercel for better cold start handling
const IS_VERCEL = process.env.VERCEL === '1' || process.env.VERCEL_ENV;

// Log environment
console.log(`[DB] Environment: ${IS_VERCEL ? 'Vercel' : 'Local'}`);
console.log(`[DB] DATABASE_URL set: ${!!process.env.DATABASE_URL}`);

let pool = null;
let sql = null; // Neon SQL function for serverless

try {
  if (process.env.DATABASE_URL) {
    // Log masked URL for debugging (show host only)
    try {
      const url = new URL(process.env.DATABASE_URL);
      console.log(`[DB] Database host: ${url.hostname}`);
    } catch (e) {
      console.log('[DB] Could not parse DATABASE_URL');
    }
  }

  if (IS_VERCEL && process.env.DATABASE_URL) {
    // Neon serverless - use neon() SQL function (recommended for serverless)
    const { neon } = require('@neondatabase/serverless');
    sql = neon(process.env.DATABASE_URL);
    console.log('[DB] Using @neondatabase/serverless neon() function');
  } else if (process.env.DATABASE_URL) {
    // Local development uses standard pg Pool
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DB_SSL === 'false' ? undefined : {
        rejectUnauthorized: false
      },
      connectionTimeoutMillis: 30000,
      idleTimeoutMillis: 30000,
      max: 10
    });
    console.log('[DB] Using pg driver');
  } else {
    console.log('[DB] No DATABASE_URL set, DB features disabled');
  }
} catch (e) {
  console.error('[DB] Driver creation error:', e.message);
}

// Wrapper to execute queries - works with both pool and sql function
async function query(text, params) {
  if (sql) {
    // Neon serverless - use tagged template or raw query
    if (params && params.length > 0) {
      // For parameterized queries, we need to use the sql function differently
      return sql(text, params);
    }
    return sql(text);
  } else if (pool) {
    return pool.query(text, params);
  } else {
    throw new Error('No database connection available');
  }
}

async function initDb() {
  // Check if any connection method is available
  if (!pool && !sql) {
    console.error('[DB] No database connection configured');
    return false;
  }

  try {
    console.log('[DB] Attempting to connect and initialize...');

    // Test connection with simple query
    if (sql) {
      await sql`SELECT 1 as test`;
    } else {
      await pool.query('SELECT 1 as test');
    }
    console.log('[DB] Connection successful!');

    // Run migrations using raw SQL (works with both)
    const migrations = [
      // Users table
      `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        nickname TEXT,
        data JSONB DEFAULT '{}',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        last_login_at TIMESTAMP WITH TIME ZONE
      )`,

      // Sessions table
      `CREATE TABLE IF NOT EXISTS sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        token TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP WITH TIME ZONE NOT NULL
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
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE INDEX IF NOT EXISTS idx_results_user ON exam_results(user_id)`,

      // Questions table (for storing generated questions)
      `CREATE TABLE IF NOT EXISTS questions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        exam_type TEXT NOT NULL,
        level TEXT NOT NULL,
        group_type TEXT NOT NULL,
        content JSONB NOT NULL,
        hash TEXT UNIQUE,
        usage_count INTEGER DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
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
        last_reviewed_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
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
        started_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP WITH TIME ZONE
      )`,

      // Mondai bank table
      `CREATE TABLE IF NOT EXISTS mondai_bank (
        hash TEXT PRIMARY KEY,
        exam_id TEXT NOT NULL,
        level TEXT NOT NULL,
        group_id TEXT NOT NULL,
        mondai_idx INTEGER NOT NULL,
        base_type TEXT,
        content JSONB NOT NULL,
        embedding VECTOR(768),
        usage_count INTEGER DEFAULT 0,
        avg_score REAL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE INDEX IF NOT EXISTS idx_mondai_lookup ON mondai_bank(exam_id, level, group_id)`,

      // Pool snapshots table
      `CREATE TABLE IF NOT EXISTS pool_snapshots (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        exam_id TEXT NOT NULL,
        level TEXT NOT NULL,
        snapshot_date DATE NOT NULL,
        UNIQUE(exam_id, level, snapshot_date)
      )`,

      // Pool snapshot items table
      `CREATE TABLE IF NOT EXISTS pool_snapshot_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        snapshot_id UUID REFERENCES pool_snapshots(id) ON DELETE CASCADE,
        mondai_hash TEXT REFERENCES mondai_bank(hash) ON DELETE CASCADE,
        group_id TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_snapshot_items_snapshot ON pool_snapshot_items(snapshot_id)`,

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
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP WITH TIME ZONE DEFAULT (CURRENT_TIMESTAMP + INTERVAL '3 days'),
        UNIQUE(user_id, exam_id, level, mode, set_no)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_instances_user ON exam_instances_cache(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_instances_expires ON exam_instances_cache(expires_at)`,

      // Attempts table
      `CREATE TABLE IF NOT EXISTS attempts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id TEXT NOT NULL,
        instance_key TEXT REFERENCES exam_instances_cache(instance_key) ON DELETE CASCADE,
        started_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        submitted_at TIMESTAMP WITH TIME ZONE,
        answers JSONB,
        score INTEGER,
        total INTEGER,
        time_spent INTEGER
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
        expires_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE INDEX IF NOT EXISTS idx_coupons_code ON coupons(code)`,

      // Coupon redemptions table
      `CREATE TABLE IF NOT EXISTS coupon_redemptions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        coupon_id UUID REFERENCES coupons(id),
        user_id TEXT REFERENCES users(id),
        redeemed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
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
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )`,

      // Published exams table
      `CREATE TABLE IF NOT EXISTS published_exams (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        exam_id TEXT NOT NULL,
        level TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
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
      `CREATE INDEX IF NOT EXISTS idx_published_parts_exam ON published_exam_parts(published_exam_id)`
    ];

    console.log(`[DB] Running ${migrations.length} migrations...`);

    for (const migration of migrations) {
      if (sql) {
        await sql(migration);
      } else {
        await pool.query(migration);
      }
    }

    console.log('Database initialized successfully');
    return true;
  } catch (e) {
    console.error('DB Init Error:', {
      message: e.message,
      code: e.code,
      routine: e.routine,
      detail: e.detail,
      stack: e.stack?.substring(0, 500)
    });
    return false;
  }
}

module.exports = { pool, sql, query, initDb };
