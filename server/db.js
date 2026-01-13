const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      console.error('DATABASE_URL environment variable is not set!');
      throw new Error('DATABASE_URL is required');
    }
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: {
        rejectUnauthorized: false // Required for Neon
      }
    });
  }
  return pool;
}

async function initDb() {
  const client = await getPool().connect();
  try {
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

    await client.query('COMMIT');
    console.log('Database initialized successfully');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Failed to initialize database:', e);
    throw e;
  } finally {
    client.release();
  }
}

// Export with getter for lazy initialization
module.exports = {
  get pool() { return getPool(); },
  initDb
};
