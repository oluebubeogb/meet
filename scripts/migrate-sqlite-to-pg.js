/**
 * One-time migration: SQLite meet.db → PostgreSQL (DATABASE_URL)
 *
 * Usage:
 *   DATABASE_URL=postgresql://user:pass@host:5432/meet \
 *   DATA_DIR=/path/to/data \
 *   node scripts/migrate-sqlite-to-pg.js
 */
const path = require('path');
const fs = require('fs');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Set DATABASE_URL to the target PostgreSQL connection string.');
  process.exit(1);
}

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'meet.db');
if (!fs.existsSync(DB_PATH)) {
  console.error('SQLite file not found at', DB_PATH);
  process.exit(1);
}

async function main() {
  const Database = require('better-sqlite3');
  const { Pool } = require('pg');
  const sqlite = new Database(DB_PATH, { readonly: true });
  const pool = new Pool({ connectionString: DATABASE_URL });

  // Ensure PG schema exists via app init
  process.env.DATABASE_URL = DATABASE_URL;
  const db = require('../db');
  await db.ensureReady();

  const tables = [
    'users',
    'meeting_history',
    'meeting_participants_log',
    'scheduled_meetings',
    'meeting_activity',
    'meeting_recordings',
    'meeting_membership',
    'meeting_templates',
    'meeting_artifacts',
    'chat_messages',
    'personal_notes',
  ];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const table of tables) {
      let rows = [];
      try {
        rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
      } catch (e) {
        console.warn('skip table', table, e.message);
        continue;
      }
      if (!rows.length) {
        console.log(table, '0 rows');
        continue;
      }
      const cols = Object.keys(rows[0]);
      // clear target (fresh migrate)
      await client.query(`TRUNCATE ${table} RESTART IDENTITY CASCADE`).catch(() =>
        client.query(`DELETE FROM ${table}`)
      );
      for (const row of rows) {
        const vals = cols.map((c) => row[c]);
        const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
        await client.query(
          `INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
          vals
        );
      }
      console.log(table, rows.length, 'rows');
    }
    // Reset sequences
    for (const table of tables) {
      await client
        .query(
          `SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1))`
        )
        .catch(() => {});
    }
    await client.query('COMMIT');
    console.log('Migration complete.');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Migration failed', e);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
    sqlite.close();
  }
}

main();
