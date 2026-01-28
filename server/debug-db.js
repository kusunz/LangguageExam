require('dotenv').config();
const { Pool } = require('pg');

console.log('DB_SSL:', process.env.DB_SSL);
console.log('DATABASE_URL length:', process.env.DATABASE_URL?.length);

const sslConfig = process.env.DB_SSL === 'false' ? undefined : {
    rejectUnauthorized: false
};

console.log('SSL Config:', sslConfig);

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: sslConfig
});

pool.connect()
    .then(client => {
        console.log('Connected successfully');
        return client.query('SELECT NOW()').then(res => {
            console.log('Query result:', res.rows[0]);
            client.release();
            process.exit(0);
        });
    })
    .catch(err => {
        console.error('Connection failed:', err);
        process.exit(1);
    });
