const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'meet.db');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
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
    slug TEXT,
    visibility TEXT NOT NULL DEFAULT 'private',
    is_paid INTEGER NOT NULL DEFAULT 0,
    price_kobo INTEGER,
    description TEXT,
    payout_account_id INTEGER,
    verification_status TEXT NOT NULL DEFAULT 'none',
    verification_reference TEXT,
    verification_paid_at TEXT,
    verification_amount_kobo INTEGER,
    FOREIGN KEY (host_user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_scheduled_host ON scheduled_meetings(host_user_id);
  CREATE INDEX IF NOT EXISTS idx_scheduled_start ON scheduled_meetings(scheduled_start);
  CREATE INDEX IF NOT EXISTS idx_scheduled_status ON scheduled_meetings(status);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_slug ON scheduled_meetings(slug) WHERE slug IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_scheduled_visibility ON scheduled_meetings(visibility, scheduled_start);

  CREATE TABLE IF NOT EXISTS user_payout_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    bank_code TEXT NOT NULL,
    bank_name TEXT,
    account_number TEXT NOT NULL,
    account_name TEXT,
    paystack_recipient_code TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_payout_user ON user_payout_accounts(user_id);

  CREATE TABLE IF NOT EXISTS meeting_registrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scheduled_meeting_id INTEGER NOT NULL,
    user_id INTEGER,
    email TEXT NOT NULL COLLATE NOCASE,
    display_name TEXT,
    amount_paid_kobo INTEGER NOT NULL DEFAULT 0,
    paystack_reference TEXT,
    payment_status TEXT NOT NULL DEFAULT 'pending',
    joined_at TEXT,
    participant_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (scheduled_meeting_id) REFERENCES scheduled_meetings(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_reg_meeting_email ON meeting_registrations(scheduled_meeting_id, email);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_reg_meeting_user ON meeting_registrations(scheduled_meeting_id, user_id) WHERE user_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_reg_meeting ON meeting_registrations(scheduled_meeting_id);
  CREATE INDEX IF NOT EXISTS idx_reg_reference ON meeting_registrations(paystack_reference);

  CREATE TABLE IF NOT EXISTS meeting_payouts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scheduled_meeting_id INTEGER NOT NULL,
    host_user_id INTEGER NOT NULL,
    payout_account_id INTEGER,
    gross_kobo INTEGER NOT NULL DEFAULT 0,
    fee_kobo INTEGER NOT NULL DEFAULT 0,
    net_kobo INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    paystack_transfer_code TEXT,
    paystack_reference TEXT,
    eligible_at TEXT,
    transferred_at TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (scheduled_meeting_id) REFERENCES scheduled_meetings(id) ON DELETE CASCADE,
    FOREIGN KEY (host_user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_payouts_status ON meeting_payouts(status, eligible_at);
  CREATE INDEX IF NOT EXISTS idx_payouts_meeting ON meeting_payouts(scheduled_meeting_id);

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
`);


// Migrate existing scheduled_meetings columns (older DBs)
(function migrateScheduledMeetings() {
  const cols = db.prepare(`PRAGMA table_info(scheduled_meetings)`).all().map((c) => c.name);
  const add = (name, def) => {
    if (!cols.includes(name)) {
      try {
        db.exec(`ALTER TABLE scheduled_meetings ADD COLUMN ${name} ${def}`);
      } catch (e) {
        console.warn('[db migrate]', name, e.message);
      }
    }
  };
  add('slug', 'TEXT');
  add('visibility', "TEXT NOT NULL DEFAULT 'private'");
  add('is_paid', 'INTEGER NOT NULL DEFAULT 0');
  add('price_kobo', 'INTEGER');
  add('description', 'TEXT');
  add('payout_account_id', 'INTEGER');
  add('verification_status', "TEXT NOT NULL DEFAULT 'none'");
  add('verification_reference', 'TEXT');
  add('verification_paid_at', 'TEXT');
  add('verification_amount_kobo', 'INTEGER');
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_slug ON scheduled_meetings(slug) WHERE slug IS NOT NULL`);
  } catch (_) {}
})();

// Seed default meeting templates once
(function seedTemplates() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM meeting_templates').get().c;
  if (count > 0) return;
  const ins = db.prepare(
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
  const tx = db.transaction((rows) => { for (const r of rows) ins.run(...r); });
  tx(templates);
})();


function createUser({ username, email, passwordHash }) {
  const stmt = db.prepare(
    `INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)`
  );
  const info = stmt.run(username, email, passwordHash);
  return getUserById(info.lastInsertRowid);
}

function getUserById(id) {
  return db.prepare(
    `SELECT id, username, email, created_at FROM users WHERE id = ?`
  ).get(id);
}

function getUserByEmail(email) {
  return db.prepare(
    `SELECT id, username, email, password_hash, created_at FROM users WHERE email = ? COLLATE NOCASE`
  ).get(email);
}

function getUserByUsername(username) {
  return db.prepare(
    `SELECT id, username, email, password_hash, created_at FROM users WHERE username = ? COLLATE NOCASE`
  ).get(username);
}

function findUserByLogin(login) {
  const byEmail = getUserByEmail(login);
  if (byEmail) return byEmail;
  return getUserByUsername(login);
}

function startMeetingHistory({ code, name, hostUserId, hostDisplayName }) {
  const stmt = db.prepare(`
    INSERT INTO meeting_history (code, name, host_user_id, host_display_name, max_participants)
    VALUES (?, ?, ?, ?, 1)
  `);
  const info = stmt.run(code, name, hostUserId || null, hostDisplayName || null);
  return info.lastInsertRowid;
}

function logParticipantJoin({ meetingHistoryId, userId, displayName, participantId }) {
  const stmt = db.prepare(`
    INSERT INTO meeting_participants_log (meeting_history_id, user_id, display_name, participant_id)
    VALUES (?, ?, ?, ?)
  `);
  const info = stmt.run(meetingHistoryId, userId || null, displayName, participantId || null);
  return info.lastInsertRowid;
}

function logParticipantLeave({ meetingHistoryId, participantId }) {
  db.prepare(`
    UPDATE meeting_participants_log
    SET left_at = datetime('now')
    WHERE meeting_history_id = ? AND participant_id = ? AND left_at IS NULL
  `).run(meetingHistoryId, participantId);
}

function updateMaxParticipants(meetingHistoryId, count) {
  db.prepare(`
    UPDATE meeting_history
    SET max_participants = MAX(max_participants, ?)
    WHERE id = ?
  `).run(count, meetingHistoryId);
}

function endMeetingHistory(meetingHistoryId) {
  db.prepare(`
    UPDATE meeting_history SET ended_at = datetime('now') WHERE id = ? AND ended_at IS NULL
  `).run(meetingHistoryId);
  db.prepare(`
    UPDATE meeting_participants_log SET left_at = datetime('now')
    WHERE meeting_history_id = ? AND left_at IS NULL
  `).run(meetingHistoryId);
}

function getHistoryForUser(userId, limit = 50) {
  return db.prepare(`
    SELECT DISTINCT
      mh.id,
      mh.code,
      mh.name,
      mh.host_user_id,
      mh.host_display_name,
      mh.created_at,
      mh.ended_at,
      mh.max_participants,
      CASE WHEN mh.host_user_id = ? THEN 1 ELSE 0 END AS was_host
    FROM meeting_history mh
    LEFT JOIN meeting_participants_log mpl ON mpl.meeting_history_id = mh.id
    WHERE mh.host_user_id = ? OR mpl.user_id = ?
    ORDER BY mh.created_at DESC
    LIMIT ?
  `).all(userId, userId, userId, limit);
}

function getMeetingParticipantsLog(meetingHistoryId) {
  return db.prepare(`
    SELECT id, user_id, display_name, participant_id, joined_at, left_at
    FROM meeting_participants_log
    WHERE meeting_history_id = ?
    ORDER BY joined_at ASC
  `).all(meetingHistoryId);
}

function getMeetingHistoryById(id) {
  return db.prepare(`SELECT * FROM meeting_history WHERE id = ?`).get(id);
}

// ----- Scheduled meetings -----

function slugifyName(name) {
  let s = String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (s.length < 10) {
    s = (s + '-meeting').slice(0, 48);
  }
  if (s.length < 10) {
    s = (s + '-' + Math.random().toString(36).slice(2, 8)).replace(/-+/g, '-');
  }
  return s.slice(0, 64);
}

function ensureUniqueSlug(baseSlug) {
  let slug = baseSlug;
  let n = 0;
  while (true) {
    const existing = db.prepare(`SELECT id FROM scheduled_meetings WHERE slug = ?`).get(slug);
    if (!existing) return slug;
    n += 1;
    slug = `${baseSlug.slice(0, 50)}-${n}`;
  }
}

function createScheduledMeeting({
  code,
  name,
  hostUserId,
  hostDisplayName,
  scheduledStart,
  scheduledEnd,
  slug,
  visibility,
  isPaid,
  priceKobo,
  description,
  payoutAccountId,
}) {
  const vis = visibility === 'public' ? 'public' : 'private';
  const paid = isPaid ? 1 : 0;
  let finalSlug = slug ? String(slug).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') : slugifyName(name);
  if (finalSlug.length < 10) finalSlug = ensureUniqueSlug(slugifyName(name));
  else finalSlug = ensureUniqueSlug(finalSlug);

  const stmt = db.prepare(`
    INSERT INTO scheduled_meetings (
      code, name, host_user_id, host_display_name, scheduled_start, scheduled_end, status,
      slug, visibility, is_paid, price_kobo, description, payout_account_id, verification_status
    ) VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, ?, ?)
  `);
  const verStatus = paid ? 'none' : 'none';
  const info = stmt.run(
    code,
    name,
    hostUserId,
    hostDisplayName || null,
    scheduledStart,
    scheduledEnd || null,
    finalSlug,
    vis,
    paid,
    paid ? (priceKobo || 0) : null,
    description || null,
    payoutAccountId || null,
    verStatus
  );
  return getScheduledById(info.lastInsertRowid);
}

function getScheduledById(id) {
  return db.prepare(`SELECT * FROM scheduled_meetings WHERE id = ?`).get(id);
}

function getScheduledByCode(code) {
  return db.prepare(`SELECT * FROM scheduled_meetings WHERE code = ?`).get(code);
}

function getScheduledBySlug(slug) {
  return db.prepare(`SELECT * FROM scheduled_meetings WHERE slug = ?`).get(String(slug || '').toLowerCase());
}

function getScheduledForUser(userId, limit = 50) {
  return db.prepare(`
    SELECT * FROM scheduled_meetings
    WHERE host_user_id = ?
    ORDER BY
      CASE status
        WHEN 'scheduled' THEN 0
        WHEN 'live' THEN 1
        WHEN 'ended' THEN 2
        ELSE 3
      END,
      scheduled_start ASC
    LIMIT ?
  `).all(userId, limit);
}

function searchPublicScheduled(query, limit = 30) {
  const q = `%${String(query || '').trim()}%`;
  if (!String(query || '').trim()) {
    return db.prepare(`
      SELECT * FROM scheduled_meetings
      WHERE visibility = 'public' AND status IN ('scheduled', 'live')
      ORDER BY scheduled_start ASC
      LIMIT ?
    `).all(limit);
  }
  return db.prepare(`
    SELECT * FROM scheduled_meetings
    WHERE visibility = 'public'
      AND status IN ('scheduled', 'live')
      AND (name LIKE ? COLLATE NOCASE OR slug LIKE ? COLLATE NOCASE OR IFNULL(description,'') LIKE ? COLLATE NOCASE)
    ORDER BY scheduled_start ASC
    LIMIT ?
  `).all(q, q, q, limit);
}

function updateScheduledStatus(id, status, extra = {}) {
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
  db.prepare(`UPDATE scheduled_meetings SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return getScheduledById(id);
}

function setMeetingVerification(id, { status, reference, amountKobo, paidAt }) {
  db.prepare(`
    UPDATE scheduled_meetings SET
      verification_status = COALESCE(?, verification_status),
      verification_reference = COALESCE(?, verification_reference),
      verification_amount_kobo = COALESCE(?, verification_amount_kobo),
      verification_paid_at = COALESCE(?, verification_paid_at)
    WHERE id = ?
  `).run(status || null, reference || null, amountKobo != null ? amountKobo : null, paidAt || null, id);
  return getScheduledById(id);
}

function deleteScheduled(id, userId) {
  return db.prepare(`DELETE FROM scheduled_meetings WHERE id = ? AND host_user_id = ?`).run(id, userId);
}

// ----- Payout accounts -----

function createPayoutAccount({ userId, bankCode, bankName, accountNumber, accountName, recipientCode }) {
  const info = db.prepare(`
    INSERT INTO user_payout_accounts (user_id, bank_code, bank_name, account_number, account_name, paystack_recipient_code)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, bankCode, bankName || null, accountNumber, accountName || null, recipientCode || null);
  return getPayoutAccountById(info.lastInsertRowid);
}

function getPayoutAccountById(id) {
  return db.prepare(`SELECT * FROM user_payout_accounts WHERE id = ?`).get(id);
}

function getPayoutAccountsForUser(userId) {
  return db.prepare(`
    SELECT * FROM user_payout_accounts WHERE user_id = ? AND status = 'active' ORDER BY id DESC
  `).all(userId);
}

function deletePayoutAccount(id, userId) {
  return db.prepare(`UPDATE user_payout_accounts SET status = 'deleted' WHERE id = ? AND user_id = ?`).run(id, userId);
}

// ----- Registrations -----

function createRegistration({ scheduledMeetingId, userId, email, displayName, amountPaidKobo, paystackReference, paymentStatus }) {
  const info = db.prepare(`
    INSERT INTO meeting_registrations (
      scheduled_meeting_id, user_id, email, display_name, amount_paid_kobo, paystack_reference, payment_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    scheduledMeetingId,
    userId || null,
    String(email).trim().toLowerCase(),
    displayName || null,
    amountPaidKobo || 0,
    paystackReference || null,
    paymentStatus || 'pending'
  );
  return getRegistrationById(info.lastInsertRowid);
}

function getRegistrationById(id) {
  return db.prepare(`SELECT * FROM meeting_registrations WHERE id = ?`).get(id);
}

function getRegistrationByReference(reference) {
  return db.prepare(`SELECT * FROM meeting_registrations WHERE paystack_reference = ?`).get(reference);
}

function getRegistrationForMeetingEmail(scheduledMeetingId, email) {
  return db.prepare(`
    SELECT * FROM meeting_registrations WHERE scheduled_meeting_id = ? AND email = ? COLLATE NOCASE
  `).get(scheduledMeetingId, String(email).trim().toLowerCase());
}

function getRegistrationForMeetingUser(scheduledMeetingId, userId) {
  if (!userId) return null;
  return db.prepare(`
    SELECT * FROM meeting_registrations WHERE scheduled_meeting_id = ? AND user_id = ?
  `).get(scheduledMeetingId, userId);
}

function listRegistrationsForMeeting(scheduledMeetingId) {
  return db.prepare(`
    SELECT * FROM meeting_registrations WHERE scheduled_meeting_id = ? ORDER BY created_at ASC
  `).all(scheduledMeetingId);
}

function updateRegistrationPayment(id, { paymentStatus, amountPaidKobo, paystackReference }) {
  db.prepare(`
    UPDATE meeting_registrations SET
      payment_status = COALESCE(?, payment_status),
      amount_paid_kobo = COALESCE(?, amount_paid_kobo),
      paystack_reference = COALESCE(?, paystack_reference)
    WHERE id = ?
  `).run(paymentStatus || null, amountPaidKobo != null ? amountPaidKobo : null, paystackReference || null, id);
  return getRegistrationById(id);
}

function markRegistrationJoined(id, participantId) {
  db.prepare(`
    UPDATE meeting_registrations SET joined_at = datetime('now'), participant_id = ? WHERE id = ?
  `).run(participantId || null, id);
  return getRegistrationById(id);
}

function getMeetingIncome(scheduledMeetingId) {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS registration_count,
      SUM(CASE WHEN payment_status = 'success' OR payment_status = 'free' THEN 1 ELSE 0 END) AS confirmed_count,
      SUM(CASE WHEN payment_status = 'success' THEN amount_paid_kobo ELSE 0 END) AS gross_kobo
    FROM meeting_registrations
    WHERE scheduled_meeting_id = ?
  `).get(scheduledMeetingId);
  return {
    registrationCount: row?.registration_count || 0,
    confirmedCount: row?.confirmed_count || 0,
    grossKobo: row?.gross_kobo || 0,
  };
}

/** Can this email/user join a scheduled meeting? Returns { ok, registration, reason } */
function checkRegistrationAccess(scheduledMeeting, { email, userId }) {
  if (!scheduledMeeting) return { ok: true, registration: null };
  // Instant (non-scheduled live) rooms don't use this table; callers only pass scheduled rows.
  const emailNorm = email ? String(email).trim().toLowerCase() : null;
  let reg = null;
  if (userId) reg = getRegistrationForMeetingUser(scheduledMeeting.id, userId);
  if (!reg && emailNorm) reg = getRegistrationForMeetingEmail(scheduledMeeting.id, emailNorm);

  if (!reg) {
    return { ok: false, registration: null, reason: 'Registration required for this meeting' };
  }
  if (scheduledMeeting.is_paid) {
    if (reg.payment_status !== 'success') {
      return { ok: false, registration: reg, reason: 'Payment required before joining' };
    }
  } else if (reg.payment_status !== 'free' && reg.payment_status !== 'success') {
    return { ok: false, registration: reg, reason: 'Registration not confirmed' };
  }
  return { ok: true, registration: reg };
}

// ----- Meeting payouts (ticket proceeds to host) -----

function createMeetingPayout({ scheduledMeetingId, hostUserId, payoutAccountId, grossKobo, feeKobo, netKobo, eligibleAt }) {
  const info = db.prepare(`
    INSERT INTO meeting_payouts (
      scheduled_meeting_id, host_user_id, payout_account_id, gross_kobo, fee_kobo, net_kobo, status, eligible_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    scheduledMeetingId,
    hostUserId,
    payoutAccountId || null,
    grossKobo || 0,
    feeKobo || 0,
    netKobo || 0,
    eligibleAt || null
  );
  return getMeetingPayoutById(info.lastInsertRowid);
}

function getMeetingPayoutById(id) {
  return db.prepare(`SELECT * FROM meeting_payouts WHERE id = ?`).get(id);
}

function getPayoutForMeeting(scheduledMeetingId) {
  return db.prepare(`SELECT * FROM meeting_payouts WHERE scheduled_meeting_id = ? ORDER BY id DESC LIMIT 1`).get(scheduledMeetingId);
}

function listEligiblePayouts(nowIso) {
  return db.prepare(`
    SELECT * FROM meeting_payouts
    WHERE status = 'pending' AND eligible_at IS NOT NULL AND eligible_at <= ?
    ORDER BY eligible_at ASC
    LIMIT 20
  `).all(nowIso);
}

function updateMeetingPayout(id, fields) {
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    const col = {
      status: 'status',
      paystackTransferCode: 'paystack_transfer_code',
      paystackReference: 'paystack_reference',
      transferredAt: 'transferred_at',
      errorMessage: 'error_message',
      eligibleAt: 'eligible_at',
      netKobo: 'net_kobo',
      grossKobo: 'gross_kobo',
      feeKobo: 'fee_kobo',
    }[k];
    if (col) {
      sets.push(`${col} = ?`);
      vals.push(v);
    }
  }
  if (!sets.length) return getMeetingPayoutById(id);
  vals.push(id);
  db.prepare(`UPDATE meeting_payouts SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return getMeetingPayoutById(id);
}


// ----- Activity -----
function logActivity({ meetingHistoryId, code, actorId, actorName, eventType, detail }) {
  const stmt = db.prepare(`
    INSERT INTO meeting_activity (meeting_history_id, code, actor_id, actor_name, event_type, detail)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    meetingHistoryId || null,
    code,
    actorId || null,
    actorName || null,
    eventType,
    detail ? (typeof detail === 'string' ? detail : JSON.stringify(detail)) : null
  );
  return info.lastInsertRowid;
}

function getActivityForCode(code, limit = 100) {
  return db.prepare(`
    SELECT * FROM meeting_activity WHERE code = ? ORDER BY id DESC LIMIT ?
  `).all(code, limit);
}

function getActivityForMeeting(meetingHistoryId, limit = 200) {
  return db.prepare(`
    SELECT * FROM meeting_activity WHERE meeting_history_id = ? ORDER BY id ASC LIMIT ?
  `).all(meetingHistoryId, limit);
}

// ----- Recordings -----
function startRecording({ meetingHistoryId, code, startedByUserId, startedByName, options }) {
  const stmt = db.prepare(`
    INSERT INTO meeting_recordings (meeting_history_id, code, started_by_user_id, started_by_name, options_json, status)
    VALUES (?, ?, ?, ?, ?, 'recording')
  `);
  const info = stmt.run(
    meetingHistoryId || null,
    code,
    startedByUserId || null,
    startedByName || null,
    options ? JSON.stringify(options) : null
  );
  return getRecordingById(info.lastInsertRowid);
}

function getRecordingById(id) {
  return db.prepare(`SELECT * FROM meeting_recordings WHERE id = ?`).get(id);
}

function stopRecording(id) {
  db.prepare(`
    UPDATE meeting_recordings SET ended_at = datetime('now'), status = 'stopped' WHERE id = ? AND status = 'recording'
  `).run(id);
  return getRecordingById(id);
}

function getActiveRecordingForCode(code) {
  return db.prepare(`
    SELECT * FROM meeting_recordings WHERE code = ? AND status = 'recording' ORDER BY id DESC LIMIT 1
  `).get(code);
}

function getRecordingsForCode(code, limit = 20) {
  return db.prepare(`
    SELECT * FROM meeting_recordings WHERE code = ? ORDER BY id DESC LIMIT ?
  `).all(code, limit);
}

// ----- Templates -----
function listTemplates() {
  return db.prepare(`SELECT * FROM meeting_templates ORDER BY sort_order ASC, id ASC`).all();
}

function getTemplateBySlug(slug) {
  return db.prepare(`SELECT * FROM meeting_templates WHERE slug = ?`).get(slug);
}

// Enhanced history with duration helper is client-side; ensure getHistory returns fields


// ----- Membership (persistent) -----
function upsertMembership({ code, userId, participantId, displayName, role, status, email }) {
  const existing = userId
    ? db.prepare(`SELECT * FROM meeting_membership WHERE code = ? AND user_id = ?`).get(code, userId)
    : db.prepare(`SELECT * FROM meeting_membership WHERE code = ? AND participant_id = ?`).get(code, participantId);
  if (existing) {
    db.prepare(`
      UPDATE meeting_membership
      SET display_name = COALESCE(?, display_name),
          role = COALESCE(?, role),
          status = COALESCE(?, status),
          participant_id = COALESCE(?, participant_id),
          email = COALESCE(?, email),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(displayName || null, role || null, status || null, participantId || null, email || null, existing.id);
    return db.prepare(`SELECT * FROM meeting_membership WHERE id = ?`).get(existing.id);
  }
  const info = db.prepare(`
    INSERT INTO meeting_membership (code, user_id, participant_id, display_name, role, status, email)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(code, userId || null, participantId || null, displayName || null, role || 'participant', status || 'ACTIVE', email || null);
  return db.prepare(`SELECT * FROM meeting_membership WHERE id = ?`).get(info.lastInsertRowid);
}

function getMembership(code, { userId, participantId } = {}) {
  if (userId) {
    return db.prepare(`SELECT * FROM meeting_membership WHERE code = ? AND user_id = ?`).get(code, userId);
  }
  if (participantId) {
    return db.prepare(`SELECT * FROM meeting_membership WHERE code = ? AND participant_id = ?`).get(code, participantId);
  }
  return null;
}

function listMembership(code) {
  return db.prepare(`SELECT * FROM meeting_membership WHERE code = ? ORDER BY updated_at DESC`).all(code);
}

function setMembershipStatus(code, { userId, participantId, status }) {
  if (userId) {
    db.prepare(`UPDATE meeting_membership SET status = ?, updated_at = datetime('now') WHERE code = ? AND user_id = ?`).run(status, code, userId);
  } else if (participantId) {
    db.prepare(`UPDATE meeting_membership SET status = ?, updated_at = datetime('now') WHERE code = ? AND participant_id = ?`).run(status, code, participantId);
  }
}


module.exports = {
  db,
  DB_PATH,
  createUser,
  getUserById,
  getUserByEmail,
  getUserByUsername,
  findUserByLogin,
  startMeetingHistory,
  logParticipantJoin,
  logParticipantLeave,
  updateMaxParticipants,
  endMeetingHistory,
  getHistoryForUser,
  getMeetingParticipantsLog,
  getMeetingHistoryById,
  createScheduledMeeting,
  getScheduledById,
  getScheduledByCode,
  getScheduledBySlug,
  getScheduledForUser,
  searchPublicScheduled,
  updateScheduledStatus,
  setMeetingVerification,
  deleteScheduled,
  slugifyName,
  ensureUniqueSlug,
  createPayoutAccount,
  getPayoutAccountById,
  getPayoutAccountsForUser,
  deletePayoutAccount,
  createRegistration,
  getRegistrationById,
  getRegistrationByReference,
  getRegistrationForMeetingEmail,
  getRegistrationForMeetingUser,
  listRegistrationsForMeeting,
  updateRegistrationPayment,
  markRegistrationJoined,
  getMeetingIncome,
  checkRegistrationAccess,
  createMeetingPayout,
  getMeetingPayoutById,
  getPayoutForMeeting,
  listEligiblePayouts,
  updateMeetingPayout,
  logActivity,
  getActivityForCode,
  getActivityForMeeting,
  startRecording,
  getRecordingById,
  stopRecording,
  getActiveRecordingForCode,
  getRecordingsForCode,
  listTemplates,
  getTemplateBySlug,
  upsertMembership,
  getMembership,
  listMembership,
  setMembershipStatus,
};
