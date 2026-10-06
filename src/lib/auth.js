const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../../db');
const config = require('../config');
const { getBearerToken } = require('./http');

function isInternalUsername(name) {
  if (!name) return true;
  const s = String(name);
  return s.startsWith('accounts:') || s.startsWith('acc_') || s.endsWith('@accounts.local');
}

function niceDisplayName({ displayName, username, email, accountsId }) {
  const candidates = [displayName, username, email && String(email).split('@')[0], 'User'];
  for (const c of candidates) {
    if (c && !isInternalUsername(c)) return String(c).trim().slice(0, 80);
  }
  return 'User';
}

async function ensureAccountsUser({ accountsId, email, username, displayName }) {
  const id = String(accountsId || '').trim();
  const em = (email && String(email).trim().toLowerCase()) || (id ? id + '@accounts.local' : null);
  const pretty = niceDisplayName({ displayName, username, email: em, accountsId: id });

  let user = null;
  if (em && !em.endsWith('@accounts.local')) {
    try { user = await db.getUserByEmail(em); } catch (_) {}
  }
  if (!user && id) {
    try { user = await db.getUserByUsername('accounts:' + id); } catch (_) {}
  }
  if (!user && username && !isInternalUsername(username)) {
    try { user = await db.getUserByUsername(username); } catch (_) {}
  }

  if (user) {
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      displayName: pretty,
      accountsId: id,
      source: 'accounts',
    };
  }

  const base =
    (username && !isInternalUsername(username) && String(username).replace(/[^a-zA-Z0-9_]/g, '').slice(0, 16)) ||
    (em && !em.endsWith('@accounts.local') && em.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '').slice(0, 16)) ||
    'user';
  const uname = ('u' + id.replace(/-/g, '').slice(0, 8) + '_' + base).slice(0, 40).toLowerCase();

  try {
    const created = await db.createUser({
      username: uname,
      email: em || (id + '@accounts.local'),
      passwordHash: bcrypt.hashSync('accounts-sso-' + id, 8),
    });
    return {
      id: created.id,
      username: created.username,
      email: created.email,
      displayName: pretty,
      accountsId: id,
      source: 'accounts',
    };
  } catch (e) {
    user = null;
    try { user = await db.getUserByEmail(em); } catch (_) {}
    if (!user) {
      try { user = await db.getUserByUsername(uname); } catch (_) {}
    }
    if (user) {
      return {
        id: user.id,
        username: user.username,
        email: user.email,
        displayName: pretty,
        accountsId: id,
        source: 'accounts',
      };
    }
    console.error('[accounts] ensure user failed', e.message);
    return {
      id: null,
      username: pretty,
      email: em,
      displayName: pretty,
      accountsId: id,
      source: 'accounts',
    };
  }
}

async function getAuthUser(req) {
  const token = getBearerToken(req);
  if (!token) return null;

  try {
    const payload = jwt.verify(token, config.JWT_SECRET);
    if (payload && payload.sub != null && payload.type !== 'access') {
      const user = await db.getUserById(payload.sub);
      if (user) return { ...user, source: 'meet' };
    }
  } catch (_) {}

  if (config.ACCOUNTS_JWT_SECRET) {
    try {
      const payload = jwt.verify(token, config.ACCOUNTS_JWT_SECRET);
      if (payload && payload.sub && (payload.type === 'access' || !payload.type)) {
        if (config.ACCOUNTS_URL && (!payload.email || !payload.display_name)) {
          try {
            const res = await fetch(config.ACCOUNTS_URL + '/auth/me', {
              headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
            });
            if (res.ok) {
              const data = await res.json();
              const u = data.user || data;
              return await ensureAccountsUser({
                accountsId: String(u.id || payload.sub),
                email: u.email || payload.email || null,
                username: u.username || null,
                displayName: u.display_name || u.username || u.email || null,
              });
            }
          } catch (_) {}
        }
        return await ensureAccountsUser({
          accountsId: String(payload.sub),
          email: payload.email || null,
          username: payload.username || payload.display_name || null,
          displayName: payload.display_name || payload.username || null,
        });
      }
    } catch (_) {}
  }

  if (config.ACCOUNTS_URL) {
    try {
      const res = await fetch(config.ACCOUNTS_URL + '/auth/me', {
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      });
      if (res.ok) {
        const data = await res.json();
        const u = data.user || data;
        if (u && (u.id || u.email)) {
          return await ensureAccountsUser({
            accountsId: String(u.id),
            email: u.email || null,
            username: u.username || null,
            displayName: u.display_name || u.username || u.email || 'User',
          });
        }
      }
    } catch (e) {
      console.warn('[accounts] /auth/me failed', e.message);
    }
  }

  return null;
}

function signToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username, email: user.email },
    config.JWT_SECRET,
    { expiresIn: config.JWT_TTL }
  );
}

function publicUser(user) {
  if (!user) return null;
  const displayName = niceDisplayName({
    displayName: user.displayName || user.display_name,
    username: user.username,
    email: user.email,
    accountsId: user.accountsId,
  });
  return {
    id: user.id,
    username: isInternalUsername(user.username) ? displayName : (user.username || displayName),
    email: user.email,
    displayName,
    source: user.source || 'meet',
    createdAt: user.created_at,
  };
}

module.exports = {
  isInternalUsername,
  niceDisplayName,
  ensureAccountsUser,
  getAuthUser,
  signToken,
  publicUser,
};
