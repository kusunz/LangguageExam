const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'false' ? undefined : {
    rejectUnauthorized: false // Required for Neon
  }
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

    await client.query('COMMIT');
    console.log('Database initialized successfully');
    return true;
  } catch (e) {
    if (client) await client.query('ROLLBACK');
    console.warn('Failed to initialize database (running in filesystem fallback mode):', e.message);
    // Do not throw, return false to indicate DB is not available
    return false;
  } finally {
    if (client) client.release();
  }
}

module.exports = { pool, initDb };
