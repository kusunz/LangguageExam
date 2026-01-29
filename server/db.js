// Use Neon serverless driver on Vercel for better cold start handling
const IS_VERCEL = process.env.VERCEL === '1' || process.env.VERCEL_ENV;
const { Pool } = IS_VERCEL
  ? require('@neondatabase/serverless')
  : require('pg');

// Log which driver is being used
console.log(`[DB] Using ${IS_VERCEL ? '@neondatabase/serverless' : 'pg'} driver`);
console.log(`[DB] DATABASE_URL set: ${!!process.env.DATABASE_URL}`);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'false' ? undefined : {
    rejectUnauthorized: false // Required for Neon
  },
  // Neon serverless handles timeouts internally, but keep for pg fallback
  connectionTimeoutMillis: 30000,
  idleTimeoutMillis: 30000,
  max: 10
});

async function initDb() {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    // Users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        nickname TEXT,
        data JSONB DEFAULT '{}',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        last_login_at TIMESTAMP WITH TIME ZONE
      );
    `);

    // Sessions table
    await client.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id TEXT REFERENCES users(id),
        token TEXT NOT NULL,
        expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Exam Results table
    await client.query(`
      CREATE TABLE IF NOT EXISTS exam_results (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id TEXT REFERENCES users(id),
        exam_id TEXT NOT NULL,
        score INTEGER,
        summary JSONB,
        data JSONB,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Questions Bank table (Deduplicated)
    await client.query(`
      CREATE TABLE IF NOT EXISTS questions (
        hash TEXT PRIMARY KEY,
        content JSONB NOT NULL,
        keywords JSONB,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // User Notebook table
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_notebook (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id TEXT REFERENCES users(id),
        question_hash TEXT REFERENCES questions(hash),
        note TEXT,
        tags JSONB DEFAULT '[]',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, question_hash)
      );
    `);

    // Exam Sessions table (for secure answer storage)
    await client.query(`
      CREATE TABLE IF NOT EXISTS exam_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id TEXT REFERENCES users(id),
        exam_id TEXT NOT NULL,
        answers JSONB NOT NULL,
        is_practice_mode BOOLEAN DEFAULT false,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP WITH TIME ZONE DEFAULT (CURRENT_TIMESTAMP + INTERVAL '4 hours')
      );
    `);

    // Create index for faster lookups
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_exam_sessions_expires 
      ON exam_sessions(expires_at);
    `);

    // ==========================================
    // Pool Snapshot Architecture Tables (v2)
    // ==========================================

    // A) Mondai Bank (Server-only question store)
    await client.query(`
      CREATE TABLE IF NOT EXISTS mondai_bank (
        hash TEXT PRIMARY KEY,
        exam_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        mondai_id TEXT NOT NULL,
        item_type TEXT,
        primary_type TEXT NOT NULL,
        content JSONB NOT NULL,
        meta JSONB,
        estimated_cost INTEGER DEFAULT 60,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Migration for existing tables
    await client.query('ALTER TABLE mondai_bank ADD COLUMN IF NOT EXISTS item_type TEXT;');
    await client.query('ALTER TABLE mondai_bank ADD COLUMN IF NOT EXISTS estimated_cost INTEGER DEFAULT 60;');

    await client.query('CREATE INDEX IF NOT EXISTS idx_mondai_bank_exam ON mondai_bank(exam_id, group_id, mondai_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_mondai_bank_type ON mondai_bank(primary_type);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_mondai_bank_item_type ON mondai_bank(item_type);');

    // B) Pool Snapshots (Daily sets catalog)
    await client.query(`
      CREATE TABLE IF NOT EXISTS pool_snapshots (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        exam_id TEXT NOT NULL,
        level TEXT NOT NULL,
        date_ymd TEXT NOT NULL,
        mode TEXT,
        bucket_spec JSONB,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(exam_id, level, date_ymd, mode)
      );
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_pool_snapshots_lookup ON pool_snapshots(exam_id, level, date_ymd);');

    // C) Pool Snapshot Items (Bucket contents)
    await client.query(`
      CREATE TABLE IF NOT EXISTS pool_snapshot_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        snapshot_id UUID REFERENCES pool_snapshots(id) ON DELETE CASCADE,
        bucket_key TEXT NOT NULL,
        mondai_hash TEXT REFERENCES mondai_bank(hash),
        weight INTEGER DEFAULT 1,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_pool_items_snapshot ON pool_snapshot_items(snapshot_id, bucket_key);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_pool_items_hash ON pool_snapshot_items(mondai_hash);');

    // D) Exam Instances Cache (Assembled exam blueprints)
    await client.query(`
      CREATE TABLE IF NOT EXISTS exam_instances_cache (
        instance_key TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id),
        exam_id TEXT NOT NULL,
        level TEXT NOT NULL,
        mode TEXT NOT NULL,
        plan TEXT NOT NULL,
        seed TEXT NOT NULL,
        set_no INTEGER NOT NULL,
        blueprint JSONB NOT NULL,
        delivery_state JSONB,
        answer_keys JSONB,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP WITH TIME ZONE DEFAULT (CURRENT_TIMESTAMP + INTERVAL '3 days'),
        UNIQUE(user_id, exam_id, level, mode, set_no)
      );
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_instances_user ON exam_instances_cache(user_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_instances_expires ON exam_instances_cache(expires_at);');

    // E) Attempts (Exam attempt tracking)
    await client.query(`
      CREATE TABLE IF NOT EXISTS attempts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        instance_key TEXT REFERENCES exam_instances_cache(instance_key),
        user_id TEXT REFERENCES users(id),
        status TEXT NOT NULL,
        started_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        submitted_at TIMESTAMP WITH TIME ZONE,
        summary JSONB
      );
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_attempts_instance ON attempts(instance_key);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_attempts_user ON attempts(user_id, status);');

    // F) Coupons & Redemptions
    await client.query(`
      CREATE TABLE IF NOT EXISTS coupons (
        code TEXT PRIMARY KEY,
        meta JSONB NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS coupon_redemptions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        code TEXT REFERENCES coupons(code),
        user_id TEXT REFERENCES users(id),
        redeemed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        meta JSONB,
        UNIQUE(code, user_id)
      );
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_redemptions_user ON coupon_redemptions(user_id);');

    // G) TTS Metrics
    await client.query(`
      CREATE TABLE IF NOT EXISTS tts_metrics (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        provider TEXT NOT NULL,
        voice TEXT,
        language TEXT,
        text_len INTEGER,
        latency_ms INTEGER,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_tts_metrics_provider ON tts_metrics(provider, created_at);');

    // H) Published Exams (Paid-only)
    await client.query(`
      CREATE TABLE IF NOT EXISTS published_exams (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        exam_code TEXT UNIQUE NOT NULL,
        year INTEGER,
        level TEXT,
        language TEXT,
        meta JSONB,
        is_paid_only BOOLEAN DEFAULT true,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS published_exam_parts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        published_exam_id UUID REFERENCES published_exams(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL,
        mondai_hashes JSONB NOT NULL,
        meta JSONB
      );
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_published_parts_exam ON published_exam_parts(published_exam_id);');

    await client.query('COMMIT');
    console.log('Database initialized successfully');
    return true;
  } catch (e) {
    if (client) await client.query('ROLLBACK');
    console.error('DB Init Error:', {
      message: e.message,
      code: e.code,
      routine: e.routine,
      detail: e.detail,
      stack: e.stack?.substring(0, 500)
    });
    // Do not throw, return false to indicate DB is not available
    return false;
  } finally {
    if (client) client.release();
  }
}

module.exports = { pool, initDb };
