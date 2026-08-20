const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false }
});

const db = {
  prepare: (sql) => {
    let index = 1;
    const pgSql = sql.replace(/\?/g, () => `$${index++}`);
    return {
      get: async (...params) => {
        const result = await pool.query(pgSql, params);
        return result.rows[0];
      },
      all: async (...params) => {
        const result = await pool.query(pgSql, params);
        return result.rows;
      },
      run: async (...params) => {
        const result = await pool.query(pgSql, params);
        return { changes: result.rowCount };
      }
    };
  },
  exec: async (sql) => {
    return await pool.query(sql);
  }
};

async function initDb() {
  if (!connectionString) {
    console.log('[db] Aucun DATABASE_URL configuré. En attente...');
    return;
  }
  
  await db.exec(`
    CREATE TABLE IF NOT EXISTS hubiflow_tokens (
      espace_login TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

module.exports = { db, initDb };
