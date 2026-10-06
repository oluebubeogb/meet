/**
 * Meet data layer — Phase 1
 * - PostgreSQL when DATABASE_URL is set (production target)
 * - SQLite fallback when not set (local dev without Postgres)
 * All exported functions are async and return Promises.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATABASE_URL = process.env.DATABASE_URL || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'meet.db');
const USE_PG = !!DATABASE_URL;

let pool = null;
let sqlite = null;
let ready = null;

function nowIso() {
  return new Date().toISOString();
}

function slugArtifact() {
  return crypto.randomBytes(8).toString('base64url').slice(0, 12);
}

/* ───────────────────────── PostgreSQL ───────────────────────── */

async function initPg() {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: DATABASE_URL,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
  pool.on('error', (err) => console.error('[pg] pool error', err.message));

  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_users_username_lower ON users (LOWER(username));
      CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users (LOWER(email));

      CREATE TABLE IF NOT EXISTS meeting_history (
        id SERIAL PRIMARY KEY,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        host_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        host_display_name TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ended_at TIMESTAMPTZ,
        max_participants INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_meeting_history_host ON meeting_history(host_user_id);
      CREATE INDEX IF NOT EXISTS idx_meeting_history_code ON meeting_history(code);
      CREATE INDEX IF NOT EXISTS idx_meeting_history_created ON meeting_history(created_at DESC);

      CREATE TABLE IF NOT EXISTS meeting_participants_log (
        id SERIAL PRIMARY KEY,
        meeting_history_id INTEGER NOT NULL REFERENCES meeting_history(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        display_name TEXT NOT NULL,
        participant_id TEXT,
        joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        left_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_mpl_meeting ON meeting_participants_log(meeting_history_id);
      CREATE INDEX IF NOT EXISTS idx_mpl_user ON meeting_participants_log(user_id);

      CREATE TABLE IF NOT EXISTS scheduled_meetings (
        id SERIAL PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        host_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        host_display_name TEXT,
        scheduled_start TIMESTAMPTZ NOT NULL,
        scheduled_end TIMESTAMPTZ,
        status TEXT NOT NULL DEFAULT 'scheduled',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at TIMESTAMPTZ,
        ended_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_scheduled_host ON scheduled_meetings(host_user_id);
      CREATE INDEX IF NOT EXISTS idx_scheduled_start ON scheduled_meetings(scheduled_start);
      CREATE INDEX IF NOT EXISTS idx_scheduled_status ON scheduled_meetings(status);

      CREATE TABLE IF NOT EXISTS meeting_activity (
        id SERIAL PRIMARY KEY,
        meeting_history_id INTEGER REFERENCES meeting_history(id) ON DELETE CASCADE,
        code TEXT NOT NULL,
        at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        actor_id TEXT,
        actor_name TEXT,
        event_type TEXT NOT NULL,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_activity_code ON meeting_activity(code);
      CREATE INDEX IF NOT EXISTS idx_activity_meeting ON meeting_activity(meeting_history_id);

      CREATE TABLE IF NOT EXISTS meeting_recordings (
        id SERIAL PRIMARY KEY,
        meeting_history_id INTEGER REFERENCES meeting_history(id) ON DELETE SET NULL,
        code TEXT NOT NULL,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ended_at TIMESTAMPTZ,
        started_by_user_id INTEGER,
        started_by_name TEXT,
        options_json TEXT,
        status TEXT NOT NULL DEFAULT 'recording',
        file_path TEXT,
        file_url TEXT,
        artifact_id INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_rec_code ON meeting_recordings(code);

      CREATE TABLE IF NOT EXISTS meeting_membership (
        id SERIAL PRIMARY KEY,
        code TEXT NOT NULL,
        user_id INTEGER,
        participant_id TEXT,
        display_name TEXT,
        role TEXT NOT NULL DEFAULT 'participant',
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        email TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(code, user_id),
        UNIQUE(code, participant_id)
      );
      CREATE INDEX IF NOT EXISTS idx_membership_code ON meeting_membership(code);
      CREATE INDEX IF NOT EXISTS idx_membership_user ON meeting_membership(user_id);

      CREATE TABLE IF NOT EXISTS meeting_templates (
        id SERIAL PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        description TEXT,
        settings_json TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS meeting_artifacts (
        id SERIAL PRIMARY KEY,
        meeting_history_id INTEGER REFERENCES meeting_history(id) ON DELETE CASCADE,
        short_code TEXT NOT NULL,
        artifact_slug TEXT NOT NULL UNIQUE,
        is_live BOOLEAN NOT NULL DEFAULT false,
        is_public BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_artifacts_code ON meeting_artifacts(short_code);
      CREATE INDEX IF NOT EXISTS idx_artifacts_history ON meeting_artifacts(meeting_history_id);

      CREATE TABLE IF NOT EXISTS chat_messages (
        id SERIAL PRIMARY KEY,
        meeting_history_id INTEGER,
        artifact_id INTEGER REFERENCES meeting_artifacts(id) ON DELETE CASCADE,
        session_id TEXT,
        sender_id TEXT,
        sender_name TEXT,
        sender_user_id INTEGER,
        body TEXT,
        attachments JSONB,
        group_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_chat_artifact ON chat_messages(artifact_id);
      CREATE INDEX IF NOT EXISTS idx_chat_history ON chat_messages(meeting_history_id);
      CREATE INDEX IF NOT EXISTS idx_chat_group ON chat_messages(group_id);

      CREATE TABLE IF NOT EXISTS personal_notes (
        id SERIAL PRIMARY KEY,
        artifact_id INTEGER NOT NULL REFERENCES meeting_artifacts(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL,
        content TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(artifact_id, user_id)
      );

      /* Cross-meeting private DMs between logged-in users (and guest-aware) */
      CREATE TABLE IF NOT EXISTS dm_threads (
        id SERIAL PRIMARY KEY,
        user_a_id INTEGER,
        user_b_id INTEGER,
        guest_key TEXT,
        guest_display_name TEXT,
        peer_is_guest BOOLEAN NOT NULL DEFAULT FALSE,
        last_message_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_dm_threads_a ON dm_threads(user_a_id);
      CREATE INDEX IF NOT EXISTS idx_dm_threads_b ON dm_threads(user_b_id);
      CREATE INDEX IF NOT EXISTS idx_dm_threads_guest ON dm_threads(guest_key);

      CREATE TABLE IF NOT EXISTS dm_messages (
        id SERIAL PRIMARY KEY,
        thread_id INTEGER NOT NULL REFERENCES dm_threads(id) ON DELETE CASCADE,
        sender_user_id INTEGER,
        sender_participant_id TEXT,
        sender_name TEXT NOT NULL,
        body TEXT NOT NULL,
        meeting_code TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_dm_messages_thread ON dm_messages(thread_id);

      /* In-meeting sub-groups (host/cohost managed) */
      CREATE TABLE IF NOT EXISTS chat_groups (
        id TEXT PRIMARY KEY,
        meeting_code TEXT NOT NULL,
        meeting_history_id INTEGER,
        title TEXT NOT NULL,
        created_by_participant_id TEXT,
        created_by_user_id INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_chat_groups_code ON chat_groups(meeting_code);

      CREATE TABLE IF NOT EXISTS chat_group_members (
        group_id TEXT NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
        participant_id TEXT,
        user_id INTEGER,
        display_name TEXT,
        PRIMARY KEY (group_id, participant_id)
      );
    `);

    // Migrate chat_messages columns on existing DBs
    await client.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS sender_user_id INTEGER`);
    await client.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS group_id TEXT`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_chat_group ON chat_messages(group_id)`);

    const { rows } = await client.query('SELECT COUNT(*)::int AS c FROM meeting_templates');
    if (rows[0].c === 0) {
      const templates = [
        ['blank', 'Blank meeting', 'Default permissions', JSON.stringify({ waitingRoom: false, guestAccess: true, participantScreenShare: true }), 0],
        ['research', 'Research meeting', 'Waiting room on, focused discussion', JSON.stringify({ waitingRoom: true, guestAccess: true, participantScreenShare: true, raiseHand: true }), 1],
        ['classroom', 'Classroom', 'Raise hand + waiting room, limited guest share', JSON.stringify({ waitingRoom: true, guestAccess: false, participantScreenShare: false, raiseHand: true, participantsCanInvite: false }), 2],
        ['team', 'Team meeting', 'Open collaboration', JSON.stringify({ waitingRoom: false, guestAccess: true, participantScreenShare: true, chat: true, reactions: true }), 3],
        ['interview', 'Interview', 'Waiting room, no guest invite', JSON.stringify({ waitingRoom: true, guestAccess: true, participantScreenShare: false, guestsCanInvite: false }), 4],
        ['presentation', 'Presentation', 'Presenter-focused, limited participant share', JSON.stringify({ waitingRoom: false, guestAccess: true, participantScreenShare: false, raiseHand: true }), 5],
      ];
      for (const t of templates) {
        await client.query(
          `INSERT INTO meeting_templates (slug, name, description, settings_json, sort_order) VALUES ($1,$2,$3,$4,$5)`,
          t
        );
      }
    }
  } finally {
    client.release();
  }
  console.log('[DB] PostgreSQL connected');
}

async function q(text, params = []) {
  await ensureReady();
  const res = await pool.query(text, params);
  return res;
}

/* ───────────────────────── SQLite fallback ───────────────────────── */

function initSqlite() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const Database = require('better-sqlite3');
  sqlite = new Database(DB_PATH);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS meeting_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      host_user_id INTEGER,
      host_display_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      max_participants INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (host_user_id) REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_meeting_history_host ON meeting_history(host_user_id);
    CREATE INDEX IF NOT EXISTS idx_meeting_history_code ON meeting_history(code);
    CREATE INDEX IF NOT EXISTS idx_meeting_history_created ON meeting_history(created_at DESC);
    CREATE TABLE IF NOT EXISTS meeting_participants_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_history_id INTEGER NOT NULL,
      user_id INTEGER,
      display_name TEXT NOT NULL,
      participant_id TEXT,
      joined_at TEXT NOT NULL DEFAULT (datetime('now')),
      left_at TEXT,
      FOREIGN KEY (meeting_history_id) REFERENCES meeting_history(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mpl_meeting ON meeting_participants_log(meeting_history_id);
    CREATE INDEX IF NOT EXISTS idx_mpl_user ON meeting_participants_log(user_id);
    CREATE TABLE IF NOT EXISTS scheduled_meetings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      host_user_id INTEGER NOT NULL,
      host_display_name TEXT,
      scheduled_start TEXT NOT NULL,
      scheduled_end TEXT,
      status TEXT NOT NULL DEFAULT 'scheduled',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      ended_at TEXT,
      FOREIGN KEY (host_user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_host ON scheduled_meetings(host_user_id);
    CREATE INDEX IF NOT EXISTS idx_scheduled_start ON scheduled_meetings(scheduled_start);
    CREATE INDEX IF NOT EXISTS idx_scheduled_status ON scheduled_meetings(status);
    CREATE TABLE IF NOT EXISTS meeting_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_history_id INTEGER,
      code TEXT NOT NULL,
      at TEXT NOT NULL DEFAULT (datetime('now')),
      actor_id TEXT,
      actor_name TEXT,
      event_type TEXT NOT NULL,
      detail TEXT,
      FOREIGN KEY (meeting_history_id) REFERENCES meeting_history(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_activity_code ON meeting_activity(code);
    CREATE INDEX IF NOT EXISTS idx_activity_meeting ON meeting_activity(meeting_history_id);
    CREATE TABLE IF NOT EXISTS meeting_recordings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_history_id INTEGER,
      code TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      started_by_user_id INTEGER,
      started_by_name TEXT,
      options_json TEXT,
      status TEXT NOT NULL DEFAULT 'recording',
      file_path TEXT,
      file_url TEXT,
      artifact_id INTEGER,
      FOREIGN KEY (meeting_history_id) REFERENCES meeting_history(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rec_code ON meeting_recordings(code);
    CREATE TABLE IF NOT EXISTS meeting_membership (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL,
      user_id INTEGER,
      participant_id TEXT,
      display_name TEXT,
      role TEXT NOT NULL DEFAULT 'participant',
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      email TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(code, user_id),
      UNIQUE(code, participant_id)
    );
    CREATE INDEX IF NOT EXISTS idx_membership_code ON meeting_membership(code);
    CREATE INDEX IF NOT EXISTS idx_membership_user ON meeting_membership(user_id);
    CREATE TABLE IF NOT EXISTS meeting_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT,
      settings_json TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS meeting_artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_history_id INTEGER,
      short_code TEXT NOT NULL,
      artifact_slug TEXT NOT NULL UNIQUE,
      is_live INTEGER NOT NULL DEFAULT 0,
      is_public INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (meeting_history_id) REFERENCES meeting_history(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_artifacts_code ON meeting_artifacts(short_code);
    CREATE INDEX IF NOT EXISTS idx_artifacts_history ON meeting_artifacts(meeting_history_id);
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_history_id INTEGER,
      artifact_id INTEGER,
      session_id TEXT,
      sender_id TEXT,
      sender_name TEXT,
      sender_user_id INTEGER,
      body TEXT,
      attachments TEXT,
      group_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_chat_artifact ON chat_messages(artifact_id);
    CREATE TABLE IF NOT EXISTS personal_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artifact_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      content TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(artifact_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS dm_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_a_id INTEGER,
      user_b_id INTEGER,
      guest_key TEXT,
      guest_display_name TEXT,
      peer_is_guest INTEGER NOT NULL DEFAULT 0,
      last_message_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_dm_threads_a ON dm_threads(user_a_id);
    CREATE INDEX IF NOT EXISTS idx_dm_threads_b ON dm_threads(user_b_id);
    CREATE INDEX IF NOT EXISTS idx_dm_threads_guest ON dm_threads(guest_key);
    CREATE TABLE IF NOT EXISTS dm_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id INTEGER NOT NULL,
      sender_user_id INTEGER,
      sender_participant_id TEXT,
      sender_name TEXT NOT NULL,
      body TEXT NOT NULL,
      meeting_code TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (thread_id) REFERENCES dm_threads(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_dm_messages_thread ON dm_messages(thread_id);
    CREATE TABLE IF NOT EXISTS chat_groups (
      id TEXT PRIMARY KEY,
      meeting_code TEXT NOT NULL,
      meeting_history_id INTEGER,
      title TEXT NOT NULL,
      created_by_participant_id TEXT,
      created_by_user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_chat_groups_code ON chat_groups(meeting_code);
    CREATE TABLE IF NOT EXISTS chat_group_members (
      group_id TEXT NOT NULL,
      participant_id TEXT,
      user_id INTEGER,
      display_name TEXT,
      PRIMARY KEY (group_id, participant_id),
      FOREIGN KEY (group_id) REFERENCES chat_groups(id) ON DELETE CASCADE
    );
  `);
  // migrate older sqlite DBs missing new columns
  try {
    const cols = sqlite.prepare(`PRAGMA table_info(meeting_recordings)`).all().map((c) => c.name);
    if (!cols.includes('file_path')) sqlite.exec(`ALTER TABLE meeting_recordings ADD COLUMN file_path TEXT`);
    if (!cols.includes('file_url')) sqlite.exec(`ALTER TABLE meeting_recordings ADD COLUMN file_url TEXT`);
    if (!cols.includes('artifact_id')) sqlite.exec(`ALTER TABLE meeting_recordings ADD COLUMN artifact_id INTEGER`);
  } catch (_) {}
  try {
    const chatCols = sqlite.prepare(`PRAGMA table_info(chat_messages)`).all().map((c) => c.name);
    if (!chatCols.includes('sender_user_id')) sqlite.exec(`ALTER TABLE chat_messages ADD COLUMN sender_user_id INTEGER`);
    if (!chatCols.includes('group_id')) sqlite.exec(`ALTER TABLE chat_messages ADD COLUMN group_id TEXT`);
  } catch (_) {}

  const count = sqlite.prepare('SELECT COUNT(*) AS c FROM meeting_templates').get().c;
  if (count === 0) {
    const ins = sqlite.prepare(
      `INSERT INTO meeting_templates (slug, name, description, settings_json, sort_order) VALUES (?, ?, ?, ?, ?)`
    );
    const templates = [
      ['blank', 'Blank meeting', 'Default permissions', JSON.stringify({ waitingRoom: false, guestAccess: true, participantScreenShare: true }), 0],
      ['research', 'Research meeting', 'Waiting room on, focused discussion', JSON.stringify({ waitingRoom: true, guestAccess: true, participantScreenShare: true, raiseHand: true }), 1],
      ['classroom', 'Classroom', 'Raise hand + waiting room, limited guest share', JSON.stringify({ waitingRoom: true, guestAccess: false, participantScreenShare: false, raiseHand: true, participantsCanInvite: false }), 2],
      ['team', 'Team meeting', 'Open collaboration', JSON.stringify({ waitingRoom: false, guestAccess: true, participantScreenShare: true, chat: true, reactions: true }), 3],
      ['interview', 'Interview', 'Waiting room, no guest invite', JSON.stringify({ waitingRoom: true, guestAccess: true, participantScreenShare: false, guestsCanInvite: false }), 4],
      ['presentation', 'Presentation', 'Presenter-focused, limited participant share', JSON.stringify({ waitingRoom: false, guestAccess: true, participantScreenShare: false, raiseHand: true }), 5],
    ];
    const tx = sqlite.transaction((rows) => {
      for (const r of rows) ins.run(...r);
    });
    tx(templates);
  }
  console.log(`[DB] SQLite at ${DB_PATH}`);
}

function ensureReady() {
  if (!ready) {
    ready = USE_PG ? initPg() : Promise.resolve(initSqlite());
  }
  return ready;
}

/* ───────────────────────── API (async) ───────────────────────── */

async function createUser({ username, email, passwordHash }) {
  await ensureReady();
  if (USE_PG) {
    const r = await q(
      `INSERT INTO users (username, email, password_hash) VALUES ($1,$2,$3) RETURNING id, username, email, created_at`,
      [username, email, passwordHash]
    );
    return r.rows[0];
  }
  const info = sqlite.prepare(`INSERT INTO users (username, email, password_hash) VALUES (?,?,?)`).run(username, email, passwordHash);
  return getUserById(info.lastInsertRowid);
}

async function getUserById(id) {
  await ensureReady();
  if (USE_PG) {
    const r = await q(`SELECT id, username, email, created_at FROM users WHERE id = $1`, [id]);
    return r.rows[0] || null;
  }
  return sqlite.prepare(`SELECT id, username, email, created_at FROM users WHERE id = ?`).get(id) || null;
}

async function getUserByEmail(email) {
  await ensureReady();
  if (USE_PG) {
    const r = await q(
      `SELECT id, username, email, password_hash, created_at FROM users WHERE LOWER(email) = LOWER($1)`,
      [email]
    );
    return r.rows[0] || null;
  }
  return sqlite.prepare(`SELECT id, username, email, password_hash, created_at FROM users WHERE email = ? COLLATE NOCASE`).get(email) || null;
}

async function getUserByUsername(username) {
  await ensureReady();
  if (USE_PG) {
    const r = await q(
      `SELECT id, username, email, password_hash, created_at FROM users WHERE LOWER(username) = LOWER($1)`,
      [username]
    );
    return r.rows[0] || null;
  }
  return sqlite.prepare(`SELECT id, username, email, password_hash, created_at FROM users WHERE username = ? COLLATE NOCASE`).get(username) || null;
}

async function findUserByLogin(login) {
  const byEmail = await getUserByEmail(login);
  if (byEmail) return byEmail;
  return getUserByUsername(login);
}

async function startMeetingHistory({ code, name, hostUserId, hostDisplayName }) {
  await ensureReady();
  if (USE_PG) {
    const r = await q(
      `INSERT INTO meeting_history (code, name, host_user_id, host_display_name, max_participants)
       VALUES ($1,$2,$3,$4,1) RETURNING id`,
      [code, name, hostUserId || null, hostDisplayName || null]
    );
    return r.rows[0].id;
  }
  const info = sqlite
    .prepare(`INSERT INTO meeting_history (code, name, host_user_id, host_display_name, max_participants) VALUES (?,?,?,?,1)`)
    .run(code, name, hostUserId || null, hostDisplayName || null);
  return info.lastInsertRowid;
}

async function logParticipantJoin({ meetingHistoryId, userId, displayName, participantId }) {
  await ensureReady();
  if (USE_PG) {
    const r = await q(
      `INSERT INTO meeting_participants_log (meeting_history_id, user_id, display_name, participant_id)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [meetingHistoryId, userId || null, displayName, participantId || null]
    );
    return r.rows[0].id;
  }
  const info = sqlite
    .prepare(`INSERT INTO meeting_participants_log (meeting_history_id, user_id, display_name, participant_id) VALUES (?,?,?,?)`)
    .run(meetingHistoryId, userId || null, displayName, participantId || null);
  return info.lastInsertRowid;
}

async function logParticipantLeave({ meetingHistoryId, participantId }) {
  await ensureReady();
  if (USE_PG) {
    await q(
      `UPDATE meeting_participants_log SET left_at = NOW()
       WHERE meeting_history_id = $1 AND participant_id = $2 AND left_at IS NULL`,
      [meetingHistoryId, participantId]
    );
    return;
  }
  sqlite
    .prepare(
      `UPDATE meeting_participants_log SET left_at = datetime('now')
       WHERE meeting_history_id = ? AND participant_id = ? AND left_at IS NULL`
    )
    .run(meetingHistoryId, participantId);
}

async function updateMaxParticipants(meetingHistoryId, count) {
  await ensureReady();
  if (USE_PG) {
    await q(
      `UPDATE meeting_history SET max_participants = GREATEST(max_participants, $1) WHERE id = $2`,
      [count, meetingHistoryId]
    );
    return;
  }
  sqlite.prepare(`UPDATE meeting_history SET max_participants = MAX(max_participants, ?) WHERE id = ?`).run(count, meetingHistoryId);
}

async function endMeetingHistory(meetingHistoryId) {
  await ensureReady();
  if (USE_PG) {
    await q(`UPDATE meeting_history SET ended_at = NOW() WHERE id = $1 AND ended_at IS NULL`, [meetingHistoryId]);
    await q(
      `UPDATE meeting_participants_log SET left_at = NOW() WHERE meeting_history_id = $1 AND left_at IS NULL`,
      [meetingHistoryId]
    );
    return;
  }
  sqlite.prepare(`UPDATE meeting_history SET ended_at = datetime('now') WHERE id = ? AND ended_at IS NULL`).run(meetingHistoryId);
  sqlite
    .prepare(`UPDATE meeting_participants_log SET left_at = datetime('now') WHERE meeting_history_id = ? AND left_at IS NULL`)
    .run(meetingHistoryId);
}

async function getHistoryForUser(userId, limit = 50) {
  await ensureReady();
  if (USE_PG) {
    const r = await q(
      `SELECT DISTINCT
        mh.id, mh.code, mh.name, mh.host_user_id, mh.host_display_name,
        mh.created_at, mh.ended_at, mh.max_participants,
        CASE WHEN mh.host_user_id = $1 THEN 1 ELSE 0 END AS was_host
      FROM meeting_history mh
      LEFT JOIN meeting_participants_log mpl ON mpl.meeting_history_id = mh.id
      WHERE mh.host_user_id = $1 OR mpl.user_id = $1
      ORDER BY mh.created_at DESC
      LIMIT $2`,
      [userId, limit]
    );
    return r.rows;
  }
  return sqlite
    .prepare(
      `SELECT DISTINCT
        mh.id, mh.code, mh.name, mh.host_user_id, mh.host_display_name,
        mh.created_at, mh.ended_at, mh.max_participants,
        CASE WHEN mh.host_user_id = ? THEN 1 ELSE 0 END AS was_host
      FROM meeting_history mh
      LEFT JOIN meeting_participants_log mpl ON mpl.meeting_history_id = mh.id
      WHERE mh.host_user_id = ? OR mpl.user_id = ?
      ORDER BY mh.created_at DESC
      LIMIT ?`
    )
    .all(userId, userId, userId, limit);
}

async function getMeetingParticipantsLog(meetingHistoryId) {
  await ensureReady();
  if (USE_PG) {
    const r = await q(
      `SELECT id, user_id, display_name, participant_id, joined_at, left_at
       FROM meeting_participants_log WHERE meeting_history_id = $1 ORDER BY joined_at ASC`,
      [meetingHistoryId]
    );
    return r.rows;
  }
  return sqlite
    .prepare(
      `SELECT id, user_id, display_name, participant_id, joined_at, left_at
       FROM meeting_participants_log WHERE meeting_history_id = ? ORDER BY joined_at ASC`
    )
    .all(meetingHistoryId);
}

async function getMeetingHistoryById(id) {
  await ensureReady();
  if (USE_PG) {
    const r = await q(`SELECT * FROM meeting_history WHERE id = $1`, [id]);
    return r.rows[0] || null;
  }
  return sqlite.prepare(`SELECT * FROM meeting_history WHERE id = ?`).get(id) || null;
}

async function createScheduledMeeting({ code, name, hostUserId, hostDisplayName, scheduledStart, scheduledEnd }) {
  await ensureReady();
  if (USE_PG) {
    const r = await q(
      `INSERT INTO scheduled_meetings (code, name, host_user_id, host_display_name, scheduled_start, scheduled_end, status)
       VALUES ($1,$2,$3,$4,$5,$6,'scheduled') RETURNING *`,
      [code, name, hostUserId, hostDisplayName || null, scheduledStart, scheduledEnd || null]
    );
    return r.rows[0];
  }
  const info = sqlite
    .prepare(
      `INSERT INTO scheduled_meetings (code, name, host_user_id, host_display_name, scheduled_start, scheduled_end, status)
       VALUES (?,?,?,?,?,?,'scheduled')`
    )
    .run(code, name, hostUserId, hostDisplayName || null, scheduledStart, scheduledEnd || null);
  return getScheduledById(info.lastInsertRowid);
}

async function getScheduledById(id) {
  await ensureReady();
  if (USE_PG) {
    const r = await q(`SELECT * FROM scheduled_meetings WHERE id = $1`, [id]);
    return r.rows[0] || null;
  }
  return sqlite.prepare(`SELECT * FROM scheduled_meetings WHERE id = ?`).get(id) || null;
}

async function getScheduledByCode(code) {
  await ensureReady();
  if (USE_PG) {
    const r = await q(`SELECT * FROM scheduled_meetings WHERE code = $1`, [code]);
    return r.rows[0] || null;
  }
  return sqlite.prepare(`SELECT * FROM scheduled_meetings WHERE code = ?`).get(code) || null;
}

async function getScheduledForUser(userId, limit = 50) {
  await ensureReady();
  if (USE_PG) {
    const r = await q(
      `SELECT * FROM scheduled_meetings WHERE host_user_id = $1
       ORDER BY CASE status WHEN 'scheduled' THEN 0 WHEN 'live' THEN 1 WHEN 'ended' THEN 2 ELSE 3 END,
                scheduled_start ASC
       LIMIT $2`,
      [userId, limit]
    );
    return r.rows;
  }
  return sqlite
    .prepare(
      `SELECT * FROM scheduled_meetings WHERE host_user_id = ?
       ORDER BY CASE status WHEN 'scheduled' THEN 0 WHEN 'live' THEN 1 WHEN 'ended' THEN 2 ELSE 3 END,
                scheduled_start ASC
       LIMIT ?`
    )
    .all(userId, limit);
}

async function updateScheduledStatus(id, status, extra = {}) {
  await ensureReady();
  if (USE_PG) {
    const sets = ['status = $1'];
    const vals = [status];
    let i = 2;
    if (extra.startedAt) {
      sets.push(`started_at = $${i++}`);
      vals.push(extra.startedAt);
    }
    if (extra.endedAt) {
      sets.push(`ended_at = $${i++}`);
      vals.push(extra.endedAt);
    }
    vals.push(id);
    await q(`UPDATE scheduled_meetings SET ${sets.join(', ')} WHERE id = $${i}`, vals);
    return getScheduledById(id);
  }
  const sets = ['status = ?'];
  const vals = [status];
  if (extra.startedAt) {
    sets.push('started_at = ?');
    vals.push(extra.startedAt);
  }
  if (extra.endedAt) {
    sets.push('ended_at = ?');
    vals.push(extra.endedAt);
  }
  vals.push(id);
  sqlite.prepare(`UPDATE scheduled_meetings SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return getScheduledById(id);
}

async function deleteScheduled(id, userId) {
  await ensureReady();
  if (USE_PG) {
    const r = await q(`DELETE FROM scheduled_meetings WHERE id = $1 AND host_user_id = $2`, [id, userId]);
    return { changes: r.rowCount };
  }
  return sqlite.prepare(`DELETE FROM scheduled_meetings WHERE id = ? AND host_user_id = ?`).run(id, userId);
}

async function logActivity({ meetingHistoryId, code, actorId, actorName, eventType, detail }) {
  await ensureReady();
  const detailStr = detail ? (typeof detail === 'string' ? detail : JSON.stringify(detail)) : null;
  if (USE_PG) {
    const r = await q(
      `INSERT INTO meeting_activity (meeting_history_id, code, actor_id, actor_name, event_type, detail)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [meetingHistoryId || null, code, actorId || null, actorName || null, eventType, detailStr]
    );
    return r.rows[0].id;
  }
  const info = sqlite
    .prepare(
      `INSERT INTO meeting_activity (meeting_history_id, code, actor_id, actor_name, event_type, detail)
       VALUES (?,?,?,?,?,?)`
    )
    .run(meetingHistoryId || null, code, actorId || null, actorName || null, eventType, detailStr);
  return info.lastInsertRowid;
}

async function getActivityForCode(code, limit = 100) {
  await ensureReady();
  if (USE_PG) {
    const r = await q(`SELECT * FROM meeting_activity WHERE code = $1 ORDER BY id DESC LIMIT $2`, [code, limit]);
    return r.rows;
  }
  return sqlite.prepare(`SELECT * FROM meeting_activity WHERE code = ? ORDER BY id DESC LIMIT ?`).all(code, limit);
}

async function getActivityForMeeting(meetingHistoryId, limit = 200) {
  await ensureReady();
  if (USE_PG) {
    const r = await q(
      `SELECT * FROM meeting_activity WHERE meeting_history_id = $1 ORDER BY id ASC LIMIT $2`,
      [meetingHistoryId, limit]
    );
    return r.rows;
  }
  return sqlite
    .prepare(`SELECT * FROM meeting_activity WHERE meeting_history_id = ? ORDER BY id ASC LIMIT ?`)
    .all(meetingHistoryId, limit);
}

async function startRecording({ meetingHistoryId, code, startedByUserId, startedByName, options }) {
  await ensureReady();
  const opt = options ? JSON.stringify(options) : null;
  if (USE_PG) {
    const r = await q(
      `INSERT INTO meeting_recordings (meeting_history_id, code, started_by_user_id, started_by_name, options_json, status)
       VALUES ($1,$2,$3,$4,$5,'recording') RETURNING *`,
      [meetingHistoryId || null, code, startedByUserId || null, startedByName || null, opt]
    );
    return r.rows[0];
  }
  const info = sqlite
    .prepare(
      `INSERT INTO meeting_recordings (meeting_history_id, code, started_by_user_id, started_by_name, options_json, status)
       VALUES (?,?,?,?,?,'recording')`
    )
    .run(meetingHistoryId || null, code, startedByUserId || null, startedByName || null, opt);
  return getRecordingById(info.lastInsertRowid);
}

async function getRecordingById(id) {
  await ensureReady();
  if (USE_PG) {
    const r = await q(`SELECT * FROM meeting_recordings WHERE id = $1`, [id]);
    return r.rows[0] || null;
  }
  return sqlite.prepare(`SELECT * FROM meeting_recordings WHERE id = ?`).get(id) || null;
}

async function stopRecording(id, extra = {}) {
  await ensureReady();
  if (USE_PG) {
    await q(
      `UPDATE meeting_recordings SET ended_at = NOW(), status = 'stopped',
        file_path = COALESCE($2, file_path), file_url = COALESCE($3, file_url)
       WHERE id = $1 AND status = 'recording'`,
      [id, extra.filePath || null, extra.fileUrl || null]
    );
    return getRecordingById(id);
  }
  sqlite
    .prepare(
      `UPDATE meeting_recordings SET ended_at = datetime('now'), status = 'stopped',
        file_path = COALESCE(?, file_path), file_url = COALESCE(?, file_url)
       WHERE id = ? AND status = 'recording'`
    )
    .run(extra.filePath || null, extra.fileUrl || null, id);
  return getRecordingById(id);
}

async function getActiveRecordingForCode(code) {
  await ensureReady();
  if (USE_PG) {
    const r = await q(
      `SELECT * FROM meeting_recordings WHERE code = $1 AND status = 'recording' ORDER BY id DESC LIMIT 1`,
      [code]
    );
    return r.rows[0] || null;
  }
  return sqlite
    .prepare(`SELECT * FROM meeting_recordings WHERE code = ? AND status = 'recording' ORDER BY id DESC LIMIT 1`)
    .get(code) || null;
}

async function getRecordingsForCode(code, limit = 20) {
  await ensureReady();
  if (USE_PG) {
    const r = await q(`SELECT * FROM meeting_recordings WHERE code = $1 ORDER BY id DESC LIMIT $2`, [code, limit]);
    return r.rows;
  }
  return sqlite.prepare(`SELECT * FROM meeting_recordings WHERE code = ? ORDER BY id DESC LIMIT ?`).all(code, limit);
}

async function listTemplates() {
  await ensureReady();
  if (USE_PG) {
    const r = await q(`SELECT * FROM meeting_templates ORDER BY sort_order ASC, id ASC`);
    return r.rows;
  }
  return sqlite.prepare(`SELECT * FROM meeting_templates ORDER BY sort_order ASC, id ASC`).all();
}

async function getTemplateBySlug(slug) {
  await ensureReady();
  if (USE_PG) {
    const r = await q(`SELECT * FROM meeting_templates WHERE slug = $1`, [slug]);
    return r.rows[0] || null;
  }
  return sqlite.prepare(`SELECT * FROM meeting_templates WHERE slug = ?`).get(slug) || null;
}

async function upsertMembership({ code, userId, participantId, displayName, role, status, email }) {
  await ensureReady();
  if (USE_PG) {
    let existing = null;
    if (userId) {
      const r = await q(`SELECT * FROM meeting_membership WHERE code = $1 AND user_id = $2`, [code, userId]);
      existing = r.rows[0];
    } else if (participantId) {
      const r = await q(`SELECT * FROM meeting_membership WHERE code = $1 AND participant_id = $2`, [code, participantId]);
      existing = r.rows[0];
    }
    if (existing) {
      await q(
        `UPDATE meeting_membership SET
          display_name = COALESCE($1, display_name),
          role = COALESCE($2, role),
          status = COALESCE($3, status),
          participant_id = COALESCE($4, participant_id),
          email = COALESCE($5, email),
          updated_at = NOW()
         WHERE id = $6`,
        [displayName || null, role || null, status || null, participantId || null, email || null, existing.id]
      );
      const r = await q(`SELECT * FROM meeting_membership WHERE id = $1`, [existing.id]);
      return r.rows[0];
    }
    const r = await q(
      `INSERT INTO meeting_membership (code, user_id, participant_id, display_name, role, status, email)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [code, userId || null, participantId || null, displayName || null, role || 'participant', status || 'ACTIVE', email || null]
    );
    return r.rows[0];
  }
  const existing = userId
    ? sqlite.prepare(`SELECT * FROM meeting_membership WHERE code = ? AND user_id = ?`).get(code, userId)
    : sqlite.prepare(`SELECT * FROM meeting_membership WHERE code = ? AND participant_id = ?`).get(code, participantId);
  if (existing) {
    sqlite
      .prepare(
        `UPDATE meeting_membership SET
          display_name = COALESCE(?, display_name),
          role = COALESCE(?, role),
          status = COALESCE(?, status),
          participant_id = COALESCE(?, participant_id),
          email = COALESCE(?, email),
          updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(displayName || null, role || null, status || null, participantId || null, email || null, existing.id);
    return sqlite.prepare(`SELECT * FROM meeting_membership WHERE id = ?`).get(existing.id);
  }
  const info = sqlite
    .prepare(
      `INSERT INTO meeting_membership (code, user_id, participant_id, display_name, role, status, email)
       VALUES (?,?,?,?,?,?,?)`
    )
    .run(code, userId || null, participantId || null, displayName || null, role || 'participant', status || 'ACTIVE', email || null);
  return sqlite.prepare(`SELECT * FROM meeting_membership WHERE id = ?`).get(info.lastInsertRowid);
}

async function getMembership(code, { userId, participantId } = {}) {
  await ensureReady();
  if (USE_PG) {
    if (userId) {
      const r = await q(`SELECT * FROM meeting_membership WHERE code = $1 AND user_id = $2`, [code, userId]);
      return r.rows[0] || null;
    }
    if (participantId) {
      const r = await q(`SELECT * FROM meeting_membership WHERE code = $1 AND participant_id = $2`, [code, participantId]);
      return r.rows[0] || null;
    }
    return null;
  }
  if (userId) return sqlite.prepare(`SELECT * FROM meeting_membership WHERE code = ? AND user_id = ?`).get(code, userId) || null;
  if (participantId)
    return sqlite.prepare(`SELECT * FROM meeting_membership WHERE code = ? AND participant_id = ?`).get(code, participantId) || null;
  return null;
}

async function listMembership(code) {
  await ensureReady();
  if (USE_PG) {
    const r = await q(`SELECT * FROM meeting_membership WHERE code = $1 ORDER BY updated_at DESC`, [code]);
    return r.rows;
  }
  return sqlite.prepare(`SELECT * FROM meeting_membership WHERE code = ? ORDER BY updated_at DESC`).all(code);
}

async function setMembershipStatus(code, { userId, participantId, status }) {
  await ensureReady();
  if (USE_PG) {
    if (userId) {
      await q(`UPDATE meeting_membership SET status = $1, updated_at = NOW() WHERE code = $2 AND user_id = $3`, [
        status,
        code,
        userId,
      ]);
    } else if (participantId) {
      await q(`UPDATE meeting_membership SET status = $1, updated_at = NOW() WHERE code = $2 AND participant_id = $3`, [
        status,
        code,
        participantId,
      ]);
    }
    return;
  }
  if (userId) {
    sqlite
      .prepare(`UPDATE meeting_membership SET status = ?, updated_at = datetime('now') WHERE code = ? AND user_id = ?`)
      .run(status, code, userId);
  } else if (participantId) {
    sqlite
      .prepare(`UPDATE meeting_membership SET status = ?, updated_at = datetime('now') WHERE code = ? AND participant_id = ?`)
      .run(status, code, participantId);
  }
}

/* ─── Artifacts (Phase 1) ─── */

async function createArtifact({ meetingHistoryId, shortCode, isPublic = false }) {
  await ensureReady();
  const slug = slugArtifact();
  if (USE_PG) {
    const r = await q(
      `INSERT INTO meeting_artifacts (meeting_history_id, short_code, artifact_slug, is_live, is_public)
       VALUES ($1,$2,$3,false,$4) RETURNING *`,
      [meetingHistoryId || null, shortCode, slug, !!isPublic]
    );
    return r.rows[0];
  }
  const info = sqlite
    .prepare(
      `INSERT INTO meeting_artifacts (meeting_history_id, short_code, artifact_slug, is_live, is_public)
       VALUES (?,?,?,0,?)`
    )
    .run(meetingHistoryId || null, shortCode, slug, isPublic ? 1 : 0);
  return getArtifactById(info.lastInsertRowid);
}

async function getArtifactById(id) {
  await ensureReady();
  if (USE_PG) {
    const r = await q(`SELECT * FROM meeting_artifacts WHERE id = $1`, [id]);
    return r.rows[0] || null;
  }
  return sqlite.prepare(`SELECT * FROM meeting_artifacts WHERE id = ?`).get(id) || null;
}

async function getArtifactBySlug(shortCode, slug) {
  await ensureReady();
  if (USE_PG) {
    const r = await q(
      `SELECT * FROM meeting_artifacts WHERE short_code = $1 AND artifact_slug = $2`,
      [shortCode, slug]
    );
    return r.rows[0] || null;
  }
  return sqlite
    .prepare(`SELECT * FROM meeting_artifacts WHERE short_code = ? AND artifact_slug = ?`)
    .get(shortCode, slug) || null;
}

async function getArtifactForHistory(meetingHistoryId) {
  await ensureReady();
  if (USE_PG) {
    const r = await q(
      `SELECT * FROM meeting_artifacts WHERE meeting_history_id = $1 ORDER BY id DESC LIMIT 1`,
      [meetingHistoryId]
    );
    return r.rows[0] || null;
  }
  return (
    sqlite
      .prepare(`SELECT * FROM meeting_artifacts WHERE meeting_history_id = ? ORDER BY id DESC LIMIT 1`)
      .get(meetingHistoryId) || null
  );
}

async function setArtifactLive(artifactId, isLive) {
  await ensureReady();
  if (USE_PG) {
    await q(`UPDATE meeting_artifacts SET is_live = $1, updated_at = NOW() WHERE id = $2`, [!!isLive, artifactId]);
    return getArtifactById(artifactId);
  }
  sqlite
    .prepare(`UPDATE meeting_artifacts SET is_live = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(isLive ? 1 : 0, artifactId);
  return getArtifactById(artifactId);
}

async function setArtifactPublic(artifactId, isPublic) {
  await ensureReady();
  if (USE_PG) {
    await q(`UPDATE meeting_artifacts SET is_public = $1, updated_at = NOW() WHERE id = $2`, [!!isPublic, artifactId]);
    return getArtifactById(artifactId);
  }
  sqlite
    .prepare(`UPDATE meeting_artifacts SET is_public = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(isPublic ? 1 : 0, artifactId);
  return getArtifactById(artifactId);
}

async function getChatForArtifact(artifactId, limit = 500) {
  await ensureReady();
  if (USE_PG) {
    const r = await q(
      `SELECT * FROM chat_messages WHERE artifact_id = $1 ORDER BY id ASC LIMIT $2`,
      [artifactId, limit]
    );
    return r.rows;
  }
  return sqlite.prepare(`SELECT * FROM chat_messages WHERE artifact_id = ? ORDER BY id ASC LIMIT ?`).all(artifactId, limit);
}

async function upsertPersonalNote({ artifactId, userId, content }) {
  await ensureReady();
  if (USE_PG) {
    const r = await q(
      `INSERT INTO personal_notes (artifact_id, user_id, content)
       VALUES ($1,$2,$3)
       ON CONFLICT (artifact_id, user_id) DO UPDATE SET content = EXCLUDED.content, updated_at = NOW()
       RETURNING *`,
      [artifactId, userId, content || '']
    );
    return r.rows[0];
  }
  const existing = sqlite
    .prepare(`SELECT * FROM personal_notes WHERE artifact_id = ? AND user_id = ?`)
    .get(artifactId, userId);
  if (existing) {
    sqlite
      .prepare(`UPDATE personal_notes SET content = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(content || '', existing.id);
    return sqlite.prepare(`SELECT * FROM personal_notes WHERE id = ?`).get(existing.id);
  }
  const info = sqlite
    .prepare(`INSERT INTO personal_notes (artifact_id, user_id, content) VALUES (?,?,?)`)
    .run(artifactId, userId, content || '');
  return sqlite.prepare(`SELECT * FROM personal_notes WHERE id = ?`).get(info.lastInsertRowid);
}

async function getPersonalNote(artifactId, userId) {
  await ensureReady();
  if (USE_PG) {
    const r = await q(`SELECT * FROM personal_notes WHERE artifact_id = $1 AND user_id = $2`, [artifactId, userId]);
    return r.rows[0] || null;
  }
  return sqlite.prepare(`SELECT * FROM personal_notes WHERE artifact_id = ? AND user_id = ?`).get(artifactId, userId) || null;
}

async function getRecordingsForHistory(meetingHistoryId) {
  await ensureReady();
  if (USE_PG) {
    const r = await q(
      `SELECT * FROM meeting_recordings WHERE meeting_history_id = $1 ORDER BY id ASC`,
      [meetingHistoryId]
    );
    return r.rows;
  }
  return sqlite
    .prepare(`SELECT * FROM meeting_recordings WHERE meeting_history_id = ? ORDER BY id ASC`)
    .all(meetingHistoryId);
}

/** Ensure artifact exists for an ended meeting; create if missing. */
async function ensureArtifactForHistory(meetingHistoryId, shortCode) {
  let art = await getArtifactForHistory(meetingHistoryId);
  if (art) return art;
  return createArtifact({ meetingHistoryId, shortCode });
}

/* ───────────────────────── Extended chat helpers ───────────────────────── */

async function saveChatMessage({
  meetingHistoryId,
  artifactId,
  sessionId,
  senderId,
  senderName,
  senderUserId,
  body,
  attachments,
  groupId,
}) {
  await ensureReady();
  if (USE_PG) {
    const r = await q(
      `INSERT INTO chat_messages
        (meeting_history_id, artifact_id, session_id, sender_id, sender_name, sender_user_id, body, attachments, group_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        meetingHistoryId || null,
        artifactId || null,
        sessionId || null,
        senderId || null,
        senderName || null,
        senderUserId || null,
        body || null,
        attachments ? JSON.stringify(attachments) : null,
        groupId || null,
      ]
    );
    return r.rows[0];
  }
  const info = sqlite
    .prepare(
      `INSERT INTO chat_messages
        (meeting_history_id, artifact_id, session_id, sender_id, sender_name, sender_user_id, body, attachments, group_id)
       VALUES (?,?,?,?,?,?,?,?,?)`
    )
    .run(
      meetingHistoryId || null,
      artifactId || null,
      sessionId || null,
      senderId || null,
      senderName || null,
      senderUserId || null,
      body || null,
      attachments ? JSON.stringify(attachments) : null,
      groupId || null
    );
  return sqlite.prepare(`SELECT * FROM chat_messages WHERE id = ?`).get(info.lastInsertRowid);
}

async function getChatForHistory(meetingHistoryId, limit = 500) {
  await ensureReady();
  if (USE_PG) {
    const r = await q(
      `SELECT * FROM chat_messages WHERE meeting_history_id = $1 AND (group_id IS NULL OR group_id = '') ORDER BY id ASC LIMIT $2`,
      [meetingHistoryId, limit]
    );
    return r.rows;
  }
  return sqlite
    .prepare(
      `SELECT * FROM chat_messages WHERE meeting_history_id = ? AND (group_id IS NULL OR group_id = '') ORDER BY id ASC LIMIT ?`
    )
    .all(meetingHistoryId, limit);
}

async function getChatForGroup(groupId, limit = 500) {
  await ensureReady();
  if (USE_PG) {
    const r = await q(
      `SELECT * FROM chat_messages WHERE group_id = $1 ORDER BY id ASC LIMIT $2`,
      [groupId, limit]
    );
    return r.rows;
  }
  return sqlite
    .prepare(`SELECT * FROM chat_messages WHERE group_id = ? ORDER BY id ASC LIMIT ?`)
    .all(groupId, limit);
}

/** Find or create a DM thread between two logged-in users (order-independent). */
async function findOrCreateDmThread(userAId, userBId) {
  await ensureReady();
  const a = Math.min(userAId, userBId);
  const b = Math.max(userAId, userBId);
  if (USE_PG) {
    let r = await q(
      `SELECT * FROM dm_threads WHERE user_a_id = $1 AND user_b_id = $2 AND peer_is_guest = FALSE LIMIT 1`,
      [a, b]
    );
    if (r.rows[0]) return r.rows[0];
    r = await q(
      `INSERT INTO dm_threads (user_a_id, user_b_id, peer_is_guest) VALUES ($1,$2,FALSE) RETURNING *`,
      [a, b]
    );
    return r.rows[0];
  }
  let row = sqlite
    .prepare(
      `SELECT * FROM dm_threads WHERE user_a_id = ? AND user_b_id = ? AND peer_is_guest = 0 LIMIT 1`
    )
    .get(a, b);
  if (row) return row;
  const info = sqlite
    .prepare(`INSERT INTO dm_threads (user_a_id, user_b_id, peer_is_guest) VALUES (?,?,0)`)
    .run(a, b);
  return sqlite.prepare(`SELECT * FROM dm_threads WHERE id = ?`).get(info.lastInsertRowid);
}

/** DM thread between a logged-in user and a guest (keyed by guest participant id or stable guest key). */
async function findOrCreateGuestDmThread(userId, guestKey, guestDisplayName) {
  await ensureReady();
  if (USE_PG) {
    let r = await q(
      `SELECT * FROM dm_threads WHERE user_a_id = $1 AND guest_key = $2 AND peer_is_guest = TRUE LIMIT 1`,
      [userId, guestKey]
    );
    if (r.rows[0]) return r.rows[0];
    r = await q(
      `INSERT INTO dm_threads (user_a_id, guest_key, guest_display_name, peer_is_guest)
       VALUES ($1,$2,$3,TRUE) RETURNING *`,
      [userId, guestKey, guestDisplayName || 'Guest']
    );
    return r.rows[0];
  }
  let row = sqlite
    .prepare(
      `SELECT * FROM dm_threads WHERE user_a_id = ? AND guest_key = ? AND peer_is_guest = 1 LIMIT 1`
    )
    .get(userId, guestKey);
  if (row) return row;
  const info = sqlite
    .prepare(
      `INSERT INTO dm_threads (user_a_id, guest_key, guest_display_name, peer_is_guest) VALUES (?,?,?,1)`
    )
    .run(userId, guestKey, guestDisplayName || 'Guest');
  return sqlite.prepare(`SELECT * FROM dm_threads WHERE id = ?`).get(info.lastInsertRowid);
}

async function saveDmMessage({
  threadId,
  senderUserId,
  senderParticipantId,
  senderName,
  body,
  meetingCode,
}) {
  await ensureReady();
  if (USE_PG) {
    const r = await q(
      `INSERT INTO dm_messages (thread_id, sender_user_id, sender_participant_id, sender_name, body, meeting_code)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [
        threadId,
        senderUserId || null,
        senderParticipantId || null,
        senderName || 'User',
        body || '',
        meetingCode || null,
      ]
    );
    await q(`UPDATE dm_threads SET last_message_at = NOW() WHERE id = $1`, [threadId]);
    return r.rows[0];
  }
  const info = sqlite
    .prepare(
      `INSERT INTO dm_messages (thread_id, sender_user_id, sender_participant_id, sender_name, body, meeting_code)
       VALUES (?,?,?,?,?,?)`
    )
    .run(
      threadId,
      senderUserId || null,
      senderParticipantId || null,
      senderName || 'User',
      body || '',
      meetingCode || null
    );
  sqlite
    .prepare(`UPDATE dm_threads SET last_message_at = datetime('now') WHERE id = ?`)
    .run(threadId);
  return sqlite.prepare(`SELECT * FROM dm_messages WHERE id = ?`).get(info.lastInsertRowid);
}

async function getDmMessages(threadId, limit = 200) {
  await ensureReady();
  if (USE_PG) {
    const r = await q(
      `SELECT * FROM dm_messages WHERE thread_id = $1 ORDER BY id ASC LIMIT $2`,
      [threadId, limit]
    );
    return r.rows;
  }
  return sqlite
    .prepare(`SELECT * FROM dm_messages WHERE thread_id = ? ORDER BY id ASC LIMIT ?`)
    .all(threadId, limit);
}

async function listDmThreadsForUser(userId, limit = 50) {
  await ensureReady();
  if (USE_PG) {
    const r = await q(
      `SELECT * FROM dm_threads
       WHERE user_a_id = $1 OR user_b_id = $1
       ORDER BY COALESCE(last_message_at, created_at) DESC
       LIMIT $2`,
      [userId, limit]
    );
    return r.rows;
  }
  return sqlite
    .prepare(
      `SELECT * FROM dm_threads
       WHERE user_a_id = ? OR user_b_id = ?
       ORDER BY COALESCE(last_message_at, created_at) DESC
       LIMIT ?`
    )
    .all(userId, userId, limit);
}

async function getDmThreadById(threadId) {
  await ensureReady();
  if (USE_PG) {
    const r = await q(`SELECT * FROM dm_threads WHERE id = $1`, [threadId]);
    return r.rows[0] || null;
  }
  return sqlite.prepare(`SELECT * FROM dm_threads WHERE id = ?`).get(threadId) || null;
}

async function createChatGroup({ id, meetingCode, meetingHistoryId, title, createdByParticipantId, createdByUserId }) {
  await ensureReady();
  if (USE_PG) {
    const r = await q(
      `INSERT INTO chat_groups (id, meeting_code, meeting_history_id, title, created_by_participant_id, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [id, meetingCode, meetingHistoryId || null, title, createdByParticipantId || null, createdByUserId || null]
    );
    return r.rows[0];
  }
  sqlite
    .prepare(
      `INSERT INTO chat_groups (id, meeting_code, meeting_history_id, title, created_by_participant_id, created_by_user_id)
       VALUES (?,?,?,?,?,?)`
    )
    .run(id, meetingCode, meetingHistoryId || null, title, createdByParticipantId || null, createdByUserId || null);
  return sqlite.prepare(`SELECT * FROM chat_groups WHERE id = ?`).get(id);
}

async function addChatGroupMember({ groupId, participantId, userId, displayName }) {
  await ensureReady();
  if (USE_PG) {
    await q(
      `INSERT INTO chat_group_members (group_id, participant_id, user_id, display_name)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (group_id, participant_id) DO UPDATE SET display_name = EXCLUDED.display_name, user_id = EXCLUDED.user_id`,
      [groupId, participantId, userId || null, displayName || null]
    );
    return;
  }
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO chat_group_members (group_id, participant_id, user_id, display_name) VALUES (?,?,?,?)`
    )
    .run(groupId, participantId, userId || null, displayName || null);
}

async function removeChatGroupMember(groupId, participantId) {
  await ensureReady();
  if (USE_PG) {
    await q(`DELETE FROM chat_group_members WHERE group_id = $1 AND participant_id = $2`, [
      groupId,
      participantId,
    ]);
    return;
  }
  sqlite
    .prepare(`DELETE FROM chat_group_members WHERE group_id = ? AND participant_id = ?`)
    .run(groupId, participantId);
}

async function listChatGroupMembers(groupId) {
  await ensureReady();
  if (USE_PG) {
    const r = await q(`SELECT * FROM chat_group_members WHERE group_id = $1`, [groupId]);
    return r.rows;
  }
  return sqlite.prepare(`SELECT * FROM chat_group_members WHERE group_id = ?`).all(groupId);
}

async function getChatGroup(groupId) {
  await ensureReady();
  if (USE_PG) {
    const r = await q(`SELECT * FROM chat_groups WHERE id = $1`, [groupId]);
    return r.rows[0] || null;
  }
  return sqlite.prepare(`SELECT * FROM chat_groups WHERE id = ?`).get(groupId) || null;
}

module.exports = {
  ensureReady,
  USE_PG,
  DB_PATH,
  DATABASE_URL: DATABASE_URL || null,
  DATA_DIR,
  // users
  createUser,
  getUserById,
  getUserByEmail,
  getUserByUsername,
  findUserByLogin,
  // history
  startMeetingHistory,
  logParticipantJoin,
  logParticipantLeave,
  updateMaxParticipants,
  endMeetingHistory,
  getHistoryForUser,
  getMeetingParticipantsLog,
  getMeetingHistoryById,
  // scheduled
  createScheduledMeeting,
  getScheduledById,
  getScheduledByCode,
  getScheduledForUser,
  updateScheduledStatus,
  deleteScheduled,
  // activity
  logActivity,
  getActivityForCode,
  getActivityForMeeting,
  // recordings
  startRecording,
  getRecordingById,
  stopRecording,
  getActiveRecordingForCode,
  getRecordingsForCode,
  getRecordingsForHistory,
  // templates
  listTemplates,
  getTemplateBySlug,
  // membership
  upsertMembership,
  getMembership,
  listMembership,
  setMembershipStatus,
  // artifacts
  createArtifact,
  getArtifactById,
  getArtifactBySlug,
  getArtifactForHistory,
  setArtifactLive,
  setArtifactPublic,
  ensureArtifactForHistory,
  saveChatMessage,
  getChatForArtifact,
  getChatForHistory,
  getChatForGroup,
  findOrCreateDmThread,
  findOrCreateGuestDmThread,
  saveDmMessage,
  getDmMessages,
  listDmThreadsForUser,
  getDmThreadById,
  createChatGroup,
  addChatGroupMember,
  removeChatGroupMember,
  listChatGroupMembers,
  getChatGroup,
  upsertPersonalNote,
  getPersonalNote,
};
