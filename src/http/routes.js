const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const bcrypt = require('bcryptjs');
const db = require('../../db');
const config = require('../config');
const { parseBody, sendJSON, isValidEmail, isValidUsername } = require('../lib/http');
const {
  getAuthUser,
  signToken,
  publicUser,
  ensureAccountsUser,
  isInternalUsername,
} = require('../lib/auth');
const {
  meetings,
  clients,
  getMeeting,
  setMeeting,
  getParticipantsList,
  getWaitingList,
  getRaisedHands,
  getContentState,
  getSecurityState,
  getPublicMeetingState,
  broadcast,
  broadcastToModerators,
  sendToParticipant,
  generateCode,
  generateInviteToken,
  createMeetingSettings,
  createParticipant,
  normalizeParticipantName,
  touchMeeting,
  findParticipantByUserId,
  isBlocked,
  blockParticipant,
} = require('../rooms/store');
const { can, resolvePermissions } = require('../lib/permissions');
const { endMeeting } = require('../rooms/lifecycle');
const { createLiveKitToken, isLiveKitConfigured, grantsFromPermissions } = require('../livekit/tokens');
const { signWsCredential } = require('../lib/wsCredential');
const { features } = require('../lib/features');
const paystack = require('../lib/paystack');
const { schedulePayoutForMeeting } = require('../lib/payouts');

const {
  PORT,
  PUBLIC,
  LIVEKIT_URL,
  LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET,
  ACCOUNTS_URL,
  ACCOUNTS_JWT_SECRET,
  MIME,
  MEETING_VERIFICATION_FEE_NAIRA,
  PAYOUT_DELAY_DAYS,
  PLATFORM_FEE_PERCENT,
  PAYSTACK_PUBLIC_KEY,
} = config;

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => {
      chunks.push(c);
      if (chunks.reduce((n, x) => n + x.length, 0) > 2e6) {
        req.destroy();
        reject(new Error('Body too large'));
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function mapScheduledRow(r, meetingsMap) {
  const income = db.getMeetingIncome(r.id);
  return {
    id: r.id,
    code: r.code,
    slug: r.slug,
    name: r.name,
    description: r.description,
    scheduledStart: r.scheduled_start,
    scheduledEnd: r.scheduled_end,
    status: r.status,
    createdAt: r.created_at,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    visibility: r.visibility || 'private',
    isPaid: !!r.is_paid,
    priceKobo: r.price_kobo,
    priceNaira: r.price_kobo != null ? r.price_kobo / 100 : null,
    payoutAccountId: r.payout_account_id,
    verificationStatus: r.verification_status || 'none',
    verificationPaidAt: r.verification_paid_at,
    link: r.slug ? `/m/${r.slug}` : `/${r.code.slice(0, 3)}-${r.code.slice(3)}`,
    codeLink: `/${r.code.slice(0, 3)}-${r.code.slice(3)}`,
    isLive: meetingsMap ? meetingsMap.has(r.code) : false,
    income: {
      registrationCount: income.registrationCount,
      confirmedCount: income.confirmedCount,
      grossKobo: income.grossKobo,
      grossNaira: (income.grossKobo || 0) / 100,
    },
  };
}

function createRequestHandler() {
  return async function handleRequest(req, res) {

  const parsed = new URL(req.url, `http://localhost:${PORT}`);
  const urlPath = parsed.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    return res.end();
  }

  if (urlPath === '/health' || urlPath === '/api/health') {
    return sendJSON(res, 200, {
      ok: true,
      livekitConfigured: !!(LIVEKIT_API_KEY && LIVEKIT_API_SECRET && LIVEKIT_URL),
      db: db.DB_PATH,
    });
  }

  // ----- Auth / suite config -----
  if (urlPath === '/api/config' && req.method === 'GET') {
    return sendJSON(res, 200, {
      accountsUrl: ACCOUNTS_URL || null,
      accountsEnabled: !!(ACCOUNTS_URL || ACCOUNTS_JWT_SECRET),
      livekitUrl: LIVEKIT_URL || null,
      livekitConfigured: !!(LIVEKIT_URL && LIVEKIT_API_KEY && LIVEKIT_API_SECRET),
      features,
      paystackPublicKey: paystack.isConfigured() ? (PAYSTACK_PUBLIC_KEY || paystack.publicKey()) : null,
      paystackEnabled: paystack.isConfigured(),
      meetingVerificationFeeNaira: MEETING_VERIFICATION_FEE_NAIRA,
      payoutDelayDays: PAYOUT_DELAY_DAYS,
      platformFeePercent: PLATFORM_FEE_PERCENT,
    });
  }

  if (urlPath === '/api/accounts/login' && req.method === 'POST') {
    if (!ACCOUNTS_URL) return sendJSON(res, 503, { error: 'Accounts not configured' });
    try {
      const body = await parseBody(req);
      const email = (body.email || body.login || '').trim();
      const password = body.password || '';
      if (!email || !password) return sendJSON(res, 400, { error: 'Email and password required' });
      const resA = await fetch(ACCOUNTS_URL + '/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await resA.json().catch(() => ({}));
      if (!resA.ok) {
        const detail = data.detail || data.error || 'Login failed';
        return sendJSON(res, resA.status, { error: typeof detail === 'string' ? detail : 'Login failed' });
      }
      const access = data.access_token;
      const u = data.user || {};
      const linked = ensureAccountsUser({
        accountsId: String(u.id),
        email: u.email,
        username: u.username,
        displayName: u.display_name || u.username || u.email,
      });
      return sendJSON(res, 200, {
        token: access,
        user: publicUser({ ...linked, displayName: u.display_name || linked.username }),
        products: u.products || [],
      });
    } catch (e) {
      console.error('[accounts/login]', e);
      return sendJSON(res, 502, { error: e.message || 'Accounts unreachable' });
    }
  }

  if (urlPath === '/api/accounts/signup' && req.method === 'POST') {
    if (!ACCOUNTS_URL) return sendJSON(res, 503, { error: 'Accounts not configured' });
    try {
      const body = await parseBody(req);
      const payload = {
        email: (body.email || '').trim(),
        password: body.password || '',
        display_name: (body.display_name || body.username || body.displayName || '').trim(),
      };
      if (body.username) payload.username = body.username;
      if (!payload.email || !payload.password || !payload.display_name) {
        return sendJSON(res, 400, { error: 'Email, password and name are required' });
      }
      const resA = await fetch(ACCOUNTS_URL + '/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await resA.json().catch(() => ({}));
      if (!resA.ok) {
        const detail = data.detail || data.error || 'Signup failed';
        return sendJSON(res, resA.status, { error: typeof detail === 'string' ? detail : 'Signup failed' });
      }
      const access = data.access_token;
      const u = data.user || {};
      const linked = ensureAccountsUser({
        accountsId: String(u.id),
        email: u.email,
        username: u.username,
        displayName: u.display_name || u.username || u.email,
      });
      return sendJSON(res, 200, {
        token: access,
        user: publicUser({ ...linked, displayName: u.display_name || linked.username }),
        products: u.products || [],
      });
    } catch (e) {
      console.error('[accounts/signup]', e);
      return sendJSON(res, 502, { error: e.message || 'Accounts unreachable' });
    }
  }

  if (urlPath === '/api/signup' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const username = (body.username || '').trim();
      const email = (body.email || '').trim().toLowerCase();
      const password = body.password || '';

      if (!isValidUsername(username)) {
        return sendJSON(res, 400, { error: 'Username must be 3–24 chars (letters, numbers, underscore)' });
      }
      if (!isValidEmail(email)) {
        return sendJSON(res, 400, { error: 'Invalid email address' });
      }
      if (typeof password !== 'string' || password.length < 6) {
        return sendJSON(res, 400, { error: 'Password must be at least 6 characters' });
      }
      if (password.length > 128) {
        return sendJSON(res, 400, { error: 'Password too long' });
      }

      if (db.getUserByUsername(username)) {
        return sendJSON(res, 409, { error: 'Username already taken' });
      }
      if (db.getUserByEmail(email)) {
        return sendJSON(res, 409, { error: 'Email already registered' });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const user = db.createUser({ username, email, passwordHash });
      const token = signToken(user);
      return sendJSON(res, 201, { token, user: publicUser(user) });
    } catch (e) {
      console.error('[signup]', e);
      return sendJSON(res, 500, { error: e.message || 'Signup failed' });
    }
  }

  if (urlPath === '/api/login' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const login = (body.login || body.email || body.username || '').trim();
      const password = body.password || '';

      if (!login || !password) {
        return sendJSON(res, 400, { error: 'Login and password are required' });
      }

      // Prefer Collab Accounts when configured (suite SSO)
      if (ACCOUNTS_URL) {
        try {
          const resA = await fetch(ACCOUNTS_URL + '/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ email: login, password }),
          });
          const data = await resA.json().catch(() => ({}));
          if (resA.ok && data.access_token) {
            const u = data.user || {};
            const linked = ensureAccountsUser({
              accountsId: String(u.id),
              email: u.email,
              username: u.username,
              displayName: u.display_name || u.username || u.email,
            });
            return sendJSON(res, 200, {
              token: data.access_token,
              user: publicUser({ ...linked, displayName: u.display_name || linked.username }),
              products: u.products || [],
            });
          }
          // If Accounts rejects, fall through to local only when identity is not an email-looking Accounts attempt
          // Still surface Accounts error for email logins
          if (login.includes('@')) {
            const detail = data.detail || data.error || 'Invalid credentials';
            return sendJSON(res, 401, { error: typeof detail === 'string' ? detail : 'Invalid credentials' });
          }
        } catch (e) {
          console.warn('[login] Accounts unreachable, trying local:', e.message);
        }
      }

      const row = db.findUserByLogin(login);
      if (!row) {
        return sendJSON(res, 401, { error: 'Invalid credentials' });
      }
      const ok = await bcrypt.compare(password, row.password_hash);
      if (!ok) {
        return sendJSON(res, 401, { error: 'Invalid credentials' });
      }

      const user = publicUser(row);
      const token = signToken(user);
      return sendJSON(res, 200, { token, user });
    } catch (e) {
      console.error('[login]', e);
      return sendJSON(res, 500, { error: e.message || 'Login failed' });
    }
  }

  if (urlPath === '/api/me' && req.method === 'GET') {
    const user = await getAuthUser(req);
    if (!user) return sendJSON(res, 401, { error: 'Not authenticated' });
    return sendJSON(res, 200, { user: publicUser(user) });
  }

  if (urlPath === '/api/history' && req.method === 'GET') {
    const user = await getAuthUser(req);
    if (!user) return sendJSON(res, 401, { error: 'Not authenticated' });
    const limit = Math.min(100, Math.max(1, parseInt(parsed.searchParams.get('limit') || '50', 10)));
    const rows = db.getHistoryForUser(user.id, limit);
    return sendJSON(res, 200, {
      history: rows.map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        hostDisplayName: r.host_display_name,
        createdAt: r.created_at,
        endedAt: r.ended_at,
        maxParticipants: r.max_participants,
        wasHost: !!r.was_host,
      })),
    });
  }

  if (urlPath.startsWith('/api/history/') && req.method === 'GET') {
    const user = await getAuthUser(req);
    if (!user) return sendJSON(res, 401, { error: 'Not authenticated' });
    const id = parseInt(urlPath.split('/').pop(), 10);
    if (!id) return sendJSON(res, 400, { error: 'Invalid id' });
    const meeting = db.getMeetingHistoryById(id);
    if (!meeting) return sendJSON(res, 404, { error: 'Not found' });
    // Only host or someone who joined can view
    const participants = db.getMeetingParticipantsLog(id);
    const allowed =
      meeting.host_user_id === user.id ||
      participants.some((p) => p.user_id === user.id);
    if (!allowed) return sendJSON(res, 403, { error: 'Forbidden' });
    return sendJSON(res, 200, {
      meeting: {
        id: meeting.id,
        code: meeting.code,
        name: meeting.name,
        hostDisplayName: meeting.host_display_name,
        createdAt: meeting.created_at,
        endedAt: meeting.ended_at,
        maxParticipants: meeting.max_participants,
      },
      participants: participants.map((p) => ({
        displayName: p.display_name,
        userId: p.user_id,
        joinedAt: p.joined_at,
        leftAt: p.left_at,
      })),
    });
  }

  // LiveKit token
  if (urlPath === '/api/livekit-token' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const code = (body.code || '').toUpperCase();
      const participantId = body.participantId;

      if (!code || !participantId) {
        return sendJSON(res, 400, { error: 'code and participantId are required' });
      }

      const meeting = meetings.get(code);
      if (!meeting) return sendJSON(res, 404, { error: 'Meeting not found' });
      const participant = meeting.participants.get(participantId);
      if (!participant) {
        return sendJSON(res, 403, { error: 'Not a participant of this meeting' });
      }

      const participantName = normalizeParticipantName(body.participantName)
        || participant.name
        || 'Participant';

      const perms = resolvePermissions(meeting, participant);
      const grants = grantsFromPermissions(perms);
      const token = await createLiveKitToken(participantId, participantName, code, grants);
      return sendJSON(res, 200, {
        token,
        url: LIVEKIT_URL,
        room: code,
        grants: {
          canPublish: grants.canPublish,
          canPublishData: grants.canPublishData,
          canSubscribe: grants.canSubscribe,
        },
      });
    } catch (e) {
      console.error('[livekit-token]', e.message);
      return sendJSON(res, 500, { error: e.message || 'Failed to create token' });
    }
  }

  if (urlPath === '/api/create' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const name = (body.name || '').trim();
      if (!name || name.length < 2) return sendJSON(res, 400, { error: 'Meeting name must be at least 2 characters' });
      if (name.length > 60) return sendJSON(res, 400, { error: 'Meeting name too long' });

      const authUser = await getAuthUser(req);
      let code = generateCode();
      if (body.scheduledId) {
        const sched = db.getScheduledById(body.scheduledId);
        if (sched && (!authUser || sched.host_user_id === authUser.id)) {
          code = sched.code;
        }
      }
      const hostId = body.participantId || 'host-' + Date.now();
      const hostName = normalizeParticipantName(
        body.participantName
        || authUser?.displayName
        || (!authUser?.username || isInternalUsername(authUser.username) ? null : authUser.username)
        || (authUser?.email && authUser.email.split('@')[0])
      );
      if (!hostName) {
        return sendJSON(res, 400, { error: 'Please enter your display name' });
      }

      const historyId = db.startMeetingHistory({
        code,
        name,
        hostUserId: authUser ? authUser.id : null,
        hostDisplayName: hostName,
      });

      db.logParticipantJoin({
        meetingHistoryId: historyId,
        userId: authUser ? authUser.id : null,
        displayName: hostName,
        participantId: hostId,
      });

      const settings = createMeetingSettings({
        waitingRoom: !!body.waitingRoom,
        guestAccess: body.guestAccess !== false,
        participantScreenShare: body.participantScreenShare !== false,
        participantMicrophone: body.participantMicrophone !== false,
        participantCamera: body.participantCamera !== false,
        chat: body.chat !== false,
        reactions: body.reactions !== false,
        raiseHand: body.raiseHand !== false,
        participantsCanInvite: !!body.participantsCanInvite,
        guestsCanInvite: !!body.guestsCanInvite,
      });
      const requireInviteKey = body.requireInviteKey === true || body.inviteAccess === 'approval';

      const host = createParticipant({
        id: hostId,
        name: hostName,
        role: 'host',
        userId: authUser ? authUser.id : null,
        device: body.device || 'desktop',
        status: 'ACTIVE',
      });

      const participants = new Map();
      participants.set(hostId, host);

      const now = Date.now();
      const inviteToken = generateInviteToken();
      meetings.set(code, {
        code,
        name,
        hostId,
        hostUserId: authUser ? authUser.id : null,
        historyId,
        createdAt: now,
        lastActivity: now,
        participants,
        content: null,
        chatHistory: [],
        scheduledId: body.scheduledId || null,
        settings,
        inviteToken,
        inviteAccess: body.inviteAccess || 'anyone', // anyone | approval
        requireInviteKey: !!requireInviteKey,
        blocked: {
          participantIds: new Set(),
          userIds: new Set(),
          names: new Set(),
        },
      });

      if (body.scheduledId) {
        try {
          db.updateScheduledStatus(body.scheduledId, 'live', {
            startedAt: new Date().toISOString(),
          });
        } catch (_) {}
      }

      const meeting = meetings.get(code);
      try {
        db.upsertMembership({
          code,
          userId: authUser ? authUser.id : null,
          participantId: hostId,
          displayName: hostName,
          role: 'host',
          status: 'ACTIVE',
          email: authUser?.email || null,
        });
      } catch (e) { console.warn('[membership] host', e.message); }

      const hostWsCredential = signWsCredential({ participantId: hostId, code });
      return sendJSON(res, 200, {
        code,
        letters: code.slice(0, 3),
        numbers: code.slice(3),
        name,
        hostId,
        participantId: hostId,
        wsCredential: hostWsCredential,
        role: 'host',
        participants: getParticipantsList(meeting),
        waiting: [],
        raisedHands: [],
        security: getSecurityState(meeting),
        inviteToken,
        inviteLink: `/${code.slice(0, 3)}-${code.slice(3)}?key=${inviteToken}`,
        permissions: resolvePermissions(meeting, host),
        content: null,
      });
    } catch (e) {
      console.error('[create]', e);
      return sendJSON(res, 400, { error: e.message || 'Bad request' });
    }
  }

  if (urlPath === '/api/join' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      let letters = (body.letters || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
      let numbers = (body.numbers || '').replace(/\D/g, '').slice(0, 3);
      if ((!letters || !numbers) && body.code) {
        const raw = String(body.code).toUpperCase().replace(/[^A-Z0-9]/g, '');
        letters = raw.slice(0, 3).replace(/[^A-Z]/g, '');
        numbers = raw.slice(3).replace(/\D/g, '').slice(0, 3);
      }
      const code = letters + numbers;

      if (letters.length !== 3 || numbers.length !== 3) {
        return sendJSON(res, 400, { error: 'Enter 3 letters and 3 numbers' });
      }

      const meeting = meetings.get(code);
      if (!meeting) return sendJSON(res, 404, { error: 'Meeting not found. Check the code.' });

      // Registration gate for scheduled meetings — host bypasses
      const scheduledRow = db.getScheduledByCode(code);
      if (scheduledRow) {
        const authPreview = await getAuthUser(req);
        const isHost =
          (authPreview && scheduledRow.host_user_id === authPreview.id) ||
          (meeting.hostUserId && authPreview && meeting.hostUserId === authPreview.id) ||
          (meeting.hostId && body.participantId && meeting.hostId === body.participantId);
        if (!isHost) {
          const email = (body.email || authPreview?.email || '').trim().toLowerCase();
          const access = db.checkRegistrationAccess(scheduledRow, {
            email: email || null,
            userId: authPreview?.id || null,
          });
          if (!access.ok) {
            return sendJSON(res, 403, {
              error: access.reason || 'Registration required',
              requiresRegistration: true,
              slug: scheduledRow.slug,
              isPaid: !!scheduledRow.is_paid,
              priceNaira: scheduledRow.price_kobo != null ? scheduledRow.price_kobo / 100 : null,
            });
          }
          if (access.registration && !access.registration.joined_at) {
            try {
              db.markRegistrationJoined(access.registration.id, body.participantId || null);
            } catch (_) {}
          }
        }
      }

      // Secure invite key enforcement
      const providedKey = body.key || body.inviteToken || null;
      const requireKey = meeting.inviteAccess === 'approval' || meeting.requireInviteKey === true;
      if (requireKey) {
        if (!providedKey || providedKey !== meeting.inviteToken) {
          return sendJSON(res, 403, { error: 'A valid invitation link is required to join this meeting.' });
        }
      }

      const authUser = await getAuthUser(req);
      const participantId = body.participantId || 'user-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
      const participantName = normalizeParticipantName(
        body.participantName
        || authUser?.displayName
        || (!authUser?.username || isInternalUsername(authUser.username) ? null : authUser.username)
        || (authUser?.email && authUser.email.split('@')[0])
      );
      if (!participantName) {
        return sendJSON(res, 400, { error: 'Please enter your display name' });
      }

      if (isBlocked(meeting, {
        userId: authUser ? authUser.id : null,
        participantId,
        name: participantName,
      })) {
        return sendJSON(res, 403, { error: 'You no longer have access to this meeting.' });
      }

      // Persistent membership: blocked/removed in DB
      let membership = null;
      try {
        membership = db.getMembership(code, {
          userId: authUser ? authUser.id : null,
          participantId,
        });
      } catch (_) {}
      if (membership && (membership.status === 'BLOCKED' || membership.status === 'REMOVED')) {
        return sendJSON(res, 403, { error: 'You no longer have access to this meeting.' });
      }

      const existing = meeting.participants.get(participantId);
      const existingByUser = authUser ? findParticipantByUserId(meeting, authUser.id) : null;
      const rejoinCandidate = existing || existingByUser;

      if (meeting.settings && meeting.settings.locked) {
        const canRejoin = rejoinCandidate && (rejoinCandidate.status === 'ACTIVE' || rejoinCandidate.status === 'APPROVED' || rejoinCandidate.status === 'LEFT');
        if (!canRejoin) {
          return sendJSON(res, 403, { error: 'Meeting is locked. New participants cannot join.' });
        }
      }

      const isGuest = !authUser;
      if (isGuest && meeting.settings && meeting.settings.guestAccess === false) {
        return sendJSON(res, 403, { error: 'Guest access is disabled for this meeting. Please sign in.' });
      }

      const activeCount = [...meeting.participants.values()].filter((p) => p.status === 'ACTIVE').length;
      if (activeCount >= 20 && !(rejoinCandidate && rejoinCandidate.status === 'ACTIVE')) {
        return sendJSON(res, 403, { error: 'Meeting is full (max 20)' });
      }

      let role = isGuest ? 'guest' : 'participant';
      let status = 'ACTIVE';

      if (rejoinCandidate) {
        if (rejoinCandidate.status === 'BLOCKED' || rejoinCandidate.status === 'REMOVED') {
          return sendJSON(res, 403, { error: 'You no longer have access to this meeting.' });
        }
        if (rejoinCandidate.role === 'host' || rejoinCandidate.role === 'cohost') {
          role = rejoinCandidate.role;
        }
      }

      const needsWaiting =
        meeting.settings &&
        meeting.settings.waitingRoom &&
        role !== 'host' &&
        !(rejoinCandidate && (rejoinCandidate.status === 'ACTIVE' || rejoinCandidate.status === 'APPROVED' || rejoinCandidate.role === 'host' || rejoinCandidate.role === 'cohost'));

      if (needsWaiting) status = 'WAITING';

      const pid = (rejoinCandidate && rejoinCandidate.id) || participantId;
      const participant = createParticipant({
        id: pid,
        name: participantName,
        role: rejoinCandidate && (rejoinCandidate.role === 'host' || rejoinCandidate.role === 'cohost')
          ? rejoinCandidate.role
          : role,
        userId: authUser ? authUser.id : null,
        device: body.device || 'desktop',
        status,
      });
      if (rejoinCandidate && rejoinCandidate.role === 'host') {
        participant.role = 'host';
        participant.isHost = true;
      }

      meeting.participants.set(pid, participant);

      if (status === 'ACTIVE' && meeting.historyId) {
        db.logParticipantJoin({
          meetingHistoryId: meeting.historyId,
          userId: authUser ? authUser.id : null,
          displayName: participantName,
          participantId: pid,
        });
        db.updateMaxParticipants(
          meeting.historyId,
          [...meeting.participants.values()].filter((p) => p.status === 'ACTIVE').length
        );
      }

      meeting.lastActivity = Date.now();

      if (status === 'WAITING') {
        broadcastToModerators(code, {
          type: 'waiting-request',
          participant: { id: pid, name: participantName, role, isGuest },
          waiting: getWaitingList(meeting),
        });
        try {
          db.upsertMembership({
            code,
            userId: authUser ? authUser.id : null,
            participantId: pid,
            displayName: participantName,
            role,
            status: 'WAITING',
            email: authUser?.email || null,
          });
        } catch (_) {}
        return sendJSON(res, 200, {
          code,
          letters: code.slice(0, 3),
          numbers: code.slice(3),
          name: meeting.name,
          participantId: pid,
          wsCredential: signWsCredential({ participantId: pid, code }),
          role,
          status: 'WAITING',
          waitingRoom: true,
          participants: [],
          waiting: [],
          security: getSecurityState(meeting),
          content: null,
        });
      }

      try {
        db.upsertMembership({
          code,
          userId: authUser ? authUser.id : null,
          participantId: pid,
          displayName: participantName,
          role: participant.role,
          status: status,
          email: authUser?.email || null,
        });
      } catch (e) { console.warn('[membership] join', e.message); }

      // Restore role from membership if previously cohost/host
      if (membership && (membership.role === 'cohost' || membership.role === 'host') && membership.status === 'ACTIVE') {
        participant.role = membership.role;
        participant.isHost = membership.role === 'host';
        meeting.participants.set(pid, participant);
      }

      broadcast(code, {
        type: 'participant-joined',
        participantId: pid,
        participants: getParticipantsList(meeting),
        waiting: getWaitingList(meeting),
      }, pid);

      return sendJSON(res, 200, {
        code,
        letters: code.slice(0, 3),
        numbers: code.slice(3),
        name: meeting.name,
        participantId: pid,
        wsCredential: signWsCredential({ participantId: pid, code }),
        role: participant.role,
        status: 'ACTIVE',
        participants: getParticipantsList(meeting),
        waiting: getWaitingList(meeting),
        raisedHands: getRaisedHands(meeting),
        security: getSecurityState(meeting),
        content: getContentState(meeting),
        permissions: resolvePermissions(meeting, participant),
        previouslyJoined: !!(membership && membership.status === 'ACTIVE'),
      });
    } catch (e) {
      console.error('[join]', e);
      return sendJSON(res, 400, { error: e.message || 'Bad request' });
    }
  }

  if (urlPath.startsWith('/api/meeting/') && req.method === 'GET') {
    const code = urlPath.split('/').pop().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const meeting = meetings.get(code);
    if (!meeting) return sendJSON(res, 404, { error: 'Meeting not found' });
    meeting.lastActivity = Date.now();
    return sendJSON(res, 200, {
      code,
      letters: code.slice(0, 3),
      numbers: code.slice(3),
      name: meeting.name,
      participants: getParticipantsList(meeting),
      waiting: getWaitingList(meeting),
      raisedHands: getRaisedHands(meeting),
      security: getSecurityState(meeting),
      createdAt: meeting.createdAt,
      content: getContentState(meeting),
      locked: !!(meeting.settings && meeting.settings.locked),
    });
  }

  // Regenerate secure invite token (host only)
  if (urlPath === '/api/invite/regenerate' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const code = (body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const participantId = body.participantId;
      const meeting = meetings.get(code);
      if (!meeting) return sendJSON(res, 404, { error: 'Meeting not found' });
      const actor = meeting.participants.get(participantId);
      if (!actor || !can(meeting, actor, 'manageSecurity')) {
        return sendJSON(res, 403, { error: 'Not allowed' });
      }
      meeting.inviteToken = generateInviteToken();
      return sendJSON(res, 200, {
        inviteToken: meeting.inviteToken,
        inviteLink: `/${code.slice(0, 3)}-${code.slice(3)}?key=${meeting.inviteToken}`,
      });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message || 'Bad request' });
    }
  }

  // ----- Schedule APIs (logged-in) -----
  if (urlPath === '/api/schedule' && req.method === 'POST') {
    try {
      const authUser = await getAuthUser(req);
      if (!authUser || !authUser.id) return sendJSON(res, 401, { error: 'Login required to schedule' });
      const body = await parseBody(req);
      const name = String(body.name || 'Scheduled meeting').trim().slice(0, 80) || 'Scheduled meeting';
      const scheduledStart = body.scheduledStart || body.start;
      if (!scheduledStart) return sendJSON(res, 400, { error: 'scheduledStart required (ISO datetime)' });
      const startDate = new Date(scheduledStart);
      if (Number.isNaN(startDate.getTime())) return sendJSON(res, 400, { error: 'Invalid scheduledStart' });
      let scheduledEnd = body.scheduledEnd || body.end || null;
      if (scheduledEnd) {
        const endDate = new Date(scheduledEnd);
        if (Number.isNaN(endDate.getTime())) scheduledEnd = null;
        else scheduledEnd = endDate.toISOString();
      }

      const visibility = body.visibility === 'public' ? 'public' : 'private';
      const isPaid = !!(body.isPaid || body.paid);
      let priceKobo = null;
      if (isPaid) {
        const naira = Number(body.priceNaira != null ? body.priceNaira : body.price);
        if (!Number.isFinite(naira) || naira < 100) {
          return sendJSON(res, 400, { error: 'Paid meetings require priceNaira of at least 100' });
        }
        priceKobo = Math.round(naira * 100);
        if (!paystack.isConfigured()) {
          return sendJSON(res, 503, { error: 'Payments not configured on this server' });
        }
      }

      let payoutAccountId = body.payoutAccountId || null;
      if (isPaid) {
        if (!payoutAccountId) {
          return sendJSON(res, 400, { error: 'Select a payout account for paid meetings' });
        }
        const acc = db.getPayoutAccountById(payoutAccountId);
        if (!acc || acc.user_id !== authUser.id || acc.status !== 'active') {
          return sendJSON(res, 400, { error: 'Invalid payout account' });
        }
        if (!acc.paystack_recipient_code) {
          return sendJSON(res, 400, { error: 'Payout account is missing Paystack recipient — re-add the account' });
        }
      }

      let slug = body.slug ? String(body.slug).trim() : null;
      if (slug && slug.length < 10) {
        return sendJSON(res, 400, { error: 'Slug must be at least 10 characters' });
      }

      const code = generateCode();
      const row = db.createScheduledMeeting({
        code,
        name,
        hostUserId: authUser.id,
        hostDisplayName: authUser.displayName || authUser.username || null,
        scheduledStart: startDate.toISOString(),
        scheduledEnd,
        slug,
        visibility,
        isPaid,
        priceKobo,
        description: body.description ? String(body.description).slice(0, 500) : null,
        payoutAccountId: isPaid ? payoutAccountId : null,
      });
      return sendJSON(res, 201, mapScheduledRow(row, meetings));
    } catch (e) {
      console.error('[schedule]', e);
      return sendJSON(res, 400, { error: e.message || 'Bad request' });
    }
  }

  if (urlPath === '/api/schedule' && req.method === 'GET') {
    try {
      const authUser = await getAuthUser(req);
      if (!authUser || !authUser.id) return sendJSON(res, 401, { error: 'Login required' });
      const rows = db.getScheduledForUser(authUser.id, 50);
      return sendJSON(res, 200, {
        meetings: rows.map((r) => mapScheduledRow(r, meetings)),
      });
    } catch (e) {
      return sendJSON(res, 500, { error: e.message || 'Failed' });
    }
  }

  if (urlPath.match(/^\/api\/schedule\/\d+\/attendees$/) && req.method === 'GET') {
    try {
      const authUser = await getAuthUser(req);
      if (!authUser || !authUser.id) return sendJSON(res, 401, { error: 'Login required' });
      const id = parseInt(urlPath.split('/')[3], 10);
      const row = db.getScheduledById(id);
      if (!row || row.host_user_id !== authUser.id) return sendJSON(res, 404, { error: 'Not found' });
      const regs = db.listRegistrationsForMeeting(id);
      const income = db.getMeetingIncome(id);
      const payout = db.getPayoutForMeeting(id);
      return sendJSON(res, 200, {
        meeting: mapScheduledRow(row, meetings),
        attendees: regs.map((r) => ({
          id: r.id,
          email: r.email,
          displayName: r.display_name,
          paymentStatus: r.payment_status,
          amountPaidKobo: r.amount_paid_kobo,
          amountPaidNaira: (r.amount_paid_kobo || 0) / 100,
          joinedAt: r.joined_at,
          createdAt: r.created_at,
        })),
        income: {
          registrationCount: income.registrationCount,
          confirmedCount: income.confirmedCount,
          grossKobo: income.grossKobo,
          grossNaira: (income.grossKobo || 0) / 100,
        },
        payout: payout
          ? {
              status: payout.status,
              netKobo: payout.net_kobo,
              netNaira: (payout.net_kobo || 0) / 100,
              eligibleAt: payout.eligible_at,
              transferredAt: payout.transferred_at,
              errorMessage: payout.error_message,
            }
          : null,
      });
    } catch (e) {
      return sendJSON(res, 500, { error: e.message || 'Failed' });
    }
  }

  if (urlPath.match(/^\/api\/schedule\/\d+\/verify-payment$/) && req.method === 'POST') {
    try {
      const authUser = await getAuthUser(req);
      if (!authUser || !authUser.id) return sendJSON(res, 401, { error: 'Login required' });
      if (!paystack.isConfigured()) return sendJSON(res, 503, { error: 'Payments not configured' });
      const id = parseInt(urlPath.split('/')[3], 10);
      const row = db.getScheduledById(id);
      if (!row || row.host_user_id !== authUser.id) return sendJSON(res, 404, { error: 'Not found' });
      if (!row.is_paid) return sendJSON(res, 400, { error: 'Only paid meetings require verification' });
      if (row.verification_status === 'paid') {
        return sendJSON(res, 200, { alreadyPaid: true, verificationStatus: 'paid' });
      }
      const email = authUser.email;
      if (!email || !isValidEmail(email)) {
        return sendJSON(res, 400, { error: 'A valid account email is required to pay verification fee' });
      }
      const amountKobo = Math.round(MEETING_VERIFICATION_FEE_NAIRA * 100);
      const reference = paystack.newReference('mver');
      const origin = (req.headers['x-forwarded-proto'] || 'http') + '://' + (req.headers.host || 'localhost');
      const init = await paystack.initializeTransaction({
        email,
        amountKobo,
        reference,
        callbackUrl: origin + '/m/' + (row.slug || row.code) + '?verified=1',
        metadata: {
          type: 'meeting_verification',
          scheduledMeetingId: row.id,
          hostUserId: authUser.id,
        },
      });
      db.setMeetingVerification(row.id, {
        status: 'pending',
        reference,
        amountKobo,
      });
      return sendJSON(res, 200, {
        authorizationUrl: init.authorization_url,
        accessCode: init.access_code,
        reference,
        amountNaira: MEETING_VERIFICATION_FEE_NAIRA,
      });
    } catch (e) {
      console.error('[verify-payment]', e);
      return sendJSON(res, 400, { error: e.message || 'Failed to start verification payment' });
    }
  }

  if (urlPath.startsWith('/api/schedule/') && req.method === 'DELETE') {
    try {
      const authUser = await getAuthUser(req);
      if (!authUser || !authUser.id) return sendJSON(res, 401, { error: 'Login required' });
      const id = parseInt(urlPath.split('/').pop(), 10);
      if (!id) return sendJSON(res, 400, { error: 'Invalid id' });
      db.deleteScheduled(id, authUser.id);
      return sendJSON(res, 200, { ok: true });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message || 'Bad request' });
    }
  }

  if (urlPath === '/api/schedule/start' && req.method === 'POST') {
    try {
      const authUser = await getAuthUser(req);
      if (!authUser || !authUser.id) return sendJSON(res, 401, { error: 'Login required' });
      const body = await parseBody(req);
      const id = body.id;
      const row = db.getScheduledById(id);
      if (!row || row.host_user_id !== authUser.id) {
        return sendJSON(res, 404, { error: 'Scheduled meeting not found' });
      }
      return sendJSON(res, 200, {
        code: row.code,
        name: row.name,
        scheduledId: row.id,
        slug: row.slug,
      });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message || 'Bad request' });
    }
  }

  // ----- Public search -----
  if (urlPath === '/api/search' && req.method === 'GET') {
    try {
      const q = parsed.searchParams.get('q') || '';
      const rows = db.searchPublicScheduled(q, 30);
      return sendJSON(res, 200, {
        meetings: rows.map((r) => ({
          id: r.id,
          slug: r.slug,
          name: r.name,
          description: r.description,
          scheduledStart: r.scheduled_start,
          scheduledEnd: r.scheduled_end,
          isPaid: !!r.is_paid,
          priceNaira: r.price_kobo != null ? r.price_kobo / 100 : null,
          status: r.status,
          link: r.slug ? '/m/' + r.slug : null,
          isLive: meetings.has(r.code),
        })),
      });
    } catch (e) {
      return sendJSON(res, 500, { error: e.message || 'Search failed' });
    }
  }

  // ----- Public meeting by slug -----
  if (urlPath.startsWith('/api/m/') && req.method === 'GET' && !urlPath.includes('/register')) {
    try {
      const slug = decodeURIComponent(urlPath.slice('/api/m/'.length).split('/')[0]);
      const row = db.getScheduledBySlug(slug);
      if (!row) return sendJSON(res, 404, { error: 'Meeting not found' });
      return sendJSON(res, 200, {
        id: row.id,
        slug: row.slug,
        name: row.name,
        description: row.description,
        scheduledStart: row.scheduled_start,
        scheduledEnd: row.scheduled_end,
        status: row.status,
        visibility: row.visibility,
        isPaid: !!row.is_paid,
        priceNaira: row.price_kobo != null ? row.price_kobo / 100 : null,
        hostDisplayName: row.host_display_name,
        isLive: meetings.has(row.code),
        code: row.status === 'live' || meetings.has(row.code) ? row.code : undefined,
        verificationRequired: !!row.is_paid && row.verification_status !== 'paid',
      });
    } catch (e) {
      return sendJSON(res, 500, { error: e.message || 'Failed' });
    }
  }

  // ----- Register (free or start paid ticket) -----
  if (urlPath.match(/^\/api\/m\/[^/]+\/register$/) && req.method === 'POST') {
    try {
      const slug = decodeURIComponent(urlPath.split('/')[3]);
      const row = db.getScheduledBySlug(slug);
      if (!row) return sendJSON(res, 404, { error: 'Meeting not found' });
      if (row.status === 'ended') return sendJSON(res, 400, { error: 'This meeting has ended' });
      if (row.is_paid && row.verification_status !== 'paid') {
        return sendJSON(res, 403, { error: 'Host has not activated this paid meeting yet' });
      }

      const body = await parseBody(req);
      const authUser = await getAuthUser(req);
      const email = String(body.email || authUser?.email || '').trim().toLowerCase();
      const displayName = String(body.displayName || body.name || authUser?.displayName || authUser?.username || '').trim().slice(0, 60);

      if (!email || !isValidEmail(email)) {
        return sendJSON(res, 400, { error: 'Valid email is required' });
      }
      if (!displayName || displayName.length < 2) {
        return sendJSON(res, 400, { error: 'Display name is required' });
      }

      const existingEmail = db.getRegistrationForMeetingEmail(row.id, email);
      if (existingEmail && (existingEmail.payment_status === 'success' || existingEmail.payment_status === 'free')) {
        return sendJSON(res, 200, {
          alreadyRegistered: true,
          registrationId: existingEmail.id,
          paymentStatus: existingEmail.payment_status,
          canJoin: true,
        });
      }
      if (authUser?.id) {
        const existingUser = db.getRegistrationForMeetingUser(row.id, authUser.id);
        if (existingUser && existingUser.email !== email && (existingUser.payment_status === 'success' || existingUser.payment_status === 'free')) {
          return sendJSON(res, 409, {
            error: 'This account is already registered for this meeting with a different email',
          });
        }
      }

      if (!row.is_paid) {
        let reg = existingEmail;
        if (!reg) {
          try {
            reg = db.createRegistration({
              scheduledMeetingId: row.id,
              userId: authUser?.id || null,
              email,
              displayName,
              amountPaidKobo: 0,
              paymentStatus: 'free',
            });
          } catch (e) {
            if (/UNIQUE/i.test(e.message)) {
              reg = db.getRegistrationForMeetingEmail(row.id, email);
            } else throw e;
          }
        } else {
          reg = db.updateRegistrationPayment(reg.id, { paymentStatus: 'free' });
        }
        return sendJSON(res, 201, {
          registrationId: reg.id,
          paymentStatus: 'free',
          canJoin: true,
        });
      }

      if (!paystack.isConfigured()) return sendJSON(res, 503, { error: 'Payments not configured' });
      const amountKobo = row.price_kobo || 0;
      if (amountKobo < 10000) return sendJSON(res, 400, { error: 'Invalid ticket price' });

      let reg = existingEmail;
      const reference = paystack.newReference('tkt');
      if (!reg) {
        try {
          reg = db.createRegistration({
            scheduledMeetingId: row.id,
            userId: authUser?.id || null,
            email,
            displayName,
            amountPaidKobo: amountKobo,
            paystackReference: reference,
            paymentStatus: 'pending',
          });
        } catch (e) {
          if (/UNIQUE/i.test(e.message)) {
            reg = db.getRegistrationForMeetingEmail(row.id, email);
          } else throw e;
        }
      } else if (reg.payment_status === 'pending') {
        db.updateRegistrationPayment(reg.id, { paystackReference: reference, amountPaidKobo: amountKobo });
      } else {
        return sendJSON(res, 200, {
          alreadyRegistered: true,
          registrationId: reg.id,
          paymentStatus: reg.payment_status,
          canJoin: reg.payment_status === 'success',
        });
      }

      const origin = (req.headers['x-forwarded-proto'] || 'http') + '://' + (req.headers.host || 'localhost');
      const init = await paystack.initializeTransaction({
        email,
        amountKobo,
        reference: reg.paystack_reference || reference,
        callbackUrl: origin + '/m/' + row.slug + '?paid=1',
        metadata: {
          type: 'ticket',
          scheduledMeetingId: row.id,
          registrationId: reg.id,
        },
      });
      return sendJSON(res, 200, {
        registrationId: reg.id,
        paymentStatus: 'pending',
        authorizationUrl: init.authorization_url,
        accessCode: init.access_code,
        reference: reg.paystack_reference || reference,
        amountNaira: amountKobo / 100,
      });
    } catch (e) {
      console.error('[register]', e);
      return sendJSON(res, 400, { error: e.message || 'Registration failed' });
    }
  }

  // ----- Payout accounts -----
  if (urlPath === '/api/payout-accounts/banks' && req.method === 'GET') {
    try {
      if (!paystack.isConfigured()) return sendJSON(res, 503, { error: 'Payments not configured' });
      const banks = await paystack.listBanks();
      return sendJSON(res, 200, {
        banks: (banks || []).map((b) => ({ name: b.name, code: b.code, slug: b.slug })),
      });
    } catch (e) {
      return sendJSON(res, 502, { error: e.message || 'Failed to list banks' });
    }
  }

  if (urlPath === '/api/payout-accounts' && req.method === 'GET') {
    try {
      const authUser = await getAuthUser(req);
      if (!authUser || !authUser.id) return sendJSON(res, 401, { error: 'Login required' });
      const rows = db.getPayoutAccountsForUser(authUser.id);
      return sendJSON(res, 200, {
        accounts: rows.map((a) => ({
          id: a.id,
          bankCode: a.bank_code,
          bankName: a.bank_name,
          accountNumber: a.account_number,
          accountName: a.account_name,
          hasRecipient: !!a.paystack_recipient_code,
          createdAt: a.created_at,
        })),
      });
    } catch (e) {
      return sendJSON(res, 500, { error: e.message || 'Failed' });
    }
  }

  if (urlPath === '/api/payout-accounts' && req.method === 'POST') {
    try {
      const authUser = await getAuthUser(req);
      if (!authUser || !authUser.id) return sendJSON(res, 401, { error: 'Login required' });
      if (!paystack.isConfigured()) return sendJSON(res, 503, { error: 'Payments not configured' });
      const body = await parseBody(req);
      const bankCode = String(body.bankCode || '').trim();
      const accountNumber = String(body.accountNumber || '').replace(/\D/g, '');
      if (!bankCode || accountNumber.length < 10) {
        return sendJSON(res, 400, { error: 'bankCode and valid accountNumber required' });
      }
      let accountName = body.accountName || null;
      let bankName = body.bankName || null;
      try {
        const resolved = await paystack.resolveAccountNumber(accountNumber, bankCode);
        accountName = resolved.account_name || accountName;
      } catch (e) {
        return sendJSON(res, 400, { error: e.message || 'Could not resolve account number' });
      }
      const recipient = await paystack.createTransferRecipient({
        name: accountName || authUser.username || 'Host',
        accountNumber,
        bankCode,
      });
      const row = db.createPayoutAccount({
        userId: authUser.id,
        bankCode,
        bankName,
        accountNumber,
        accountName,
        recipientCode: recipient.recipient_code,
      });
      return sendJSON(res, 201, {
        id: row.id,
        bankCode: row.bank_code,
        bankName: row.bank_name,
        accountNumber: row.account_number,
        accountName: row.account_name,
        hasRecipient: true,
      });
    } catch (e) {
      console.error('[payout-accounts]', e);
      return sendJSON(res, 400, { error: e.message || 'Failed to add account' });
    }
  }

  if (urlPath.match(/^\/api\/payout-accounts\/\d+$/) && req.method === 'DELETE') {
    try {
      const authUser = await getAuthUser(req);
      if (!authUser || !authUser.id) return sendJSON(res, 401, { error: 'Login required' });
      const id = parseInt(urlPath.split('/').pop(), 10);
      db.deletePayoutAccount(id, authUser.id);
      return sendJSON(res, 200, { ok: true });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message || 'Failed' });
    }
  }

  // ----- Paystack webhook -----
  if (urlPath === '/api/webhooks/paystack' && req.method === 'POST') {
    try {
      const raw = await readRawBody(req);
      const sig = req.headers['x-paystack-signature'];
      if (!paystack.verifyWebhookSignature(raw, sig)) {
        return sendJSON(res, 401, { error: 'Invalid signature' });
      }
      const event = JSON.parse(raw.toString('utf8'));
      const eventName = event.event;
      const data = event.data || {};

      if (eventName === 'charge.success') {
        const meta = data.metadata || {};
        const reference = data.reference;
        if (meta.type === 'meeting_verification' && meta.scheduledMeetingId) {
          db.setMeetingVerification(Number(meta.scheduledMeetingId), {
            status: 'paid',
            reference,
            amountKobo: data.amount,
            paidAt: new Date().toISOString(),
          });
          console.log('[webhook] meeting verification paid', meta.scheduledMeetingId);
        } else if (meta.type === 'ticket' && meta.registrationId) {
          db.updateRegistrationPayment(Number(meta.registrationId), {
            paymentStatus: 'success',
            amountPaidKobo: data.amount,
            paystackReference: reference,
          });
          console.log('[webhook] ticket paid registration', meta.registrationId);
        } else if (reference) {
          const reg = db.getRegistrationByReference(reference);
          if (reg) {
            db.updateRegistrationPayment(reg.id, {
              paymentStatus: 'success',
              amountPaidKobo: data.amount,
              paystackReference: reference,
            });
          }
        }
      }

      if (eventName === 'transfer.success' || eventName === 'transfer.failed') {
        const reference = data.reference;
        if (reference) {
          const payout = db.db.prepare('SELECT * FROM meeting_payouts WHERE paystack_reference = ?').get(reference);
          if (payout) {
            db.updateMeetingPayout(payout.id, {
              status: eventName === 'transfer.success' ? 'success' : 'failed',
              transferredAt: eventName === 'transfer.success' ? new Date().toISOString() : null,
              errorMessage: eventName === 'transfer.failed' ? (data.reason || 'Transfer failed') : null,
            });
          }
        }
      }

      return sendJSON(res, 200, { received: true });
    } catch (e) {
      console.error('[webhook paystack]', e);
      return sendJSON(res, 500, { error: 'Webhook handler error' });
    }
  }

  if (urlPath === '/api/leave' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const code = (body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const participantId = body.participantId;
      const meeting = meetings.get(code);
      if (meeting && participantId) {
        const p = meeting.participants.get(participantId);
        if (p) {
          p.status = 'LEFT';
          p.handRaisedAt = null;
          p.sharing = false;
        }
        clients.delete(participantId);
        meeting.lastActivity = Date.now();

        if (meeting.historyId) {
          db.logParticipantLeave({
            meetingHistoryId: meeting.historyId,
            participantId,
          });
        }

        const activeLeft = [...meeting.participants.values()].filter((x) => x.status === 'ACTIVE').length;
        if (activeLeft === 0) {
          endMeeting(code, 'empty');
        } else {
          broadcast(code, {
            type: 'participant-left',
            participantId,
            participants: getParticipantsList(meeting),
            waiting: getWaitingList(meeting),
            raisedHands: getRaisedHands(meeting),
          });
        }
      }
      return sendJSON(res, 200, { ok: true });
    } catch {
      return sendJSON(res, 400, { error: 'Bad request' });
    }
  }

  // ----- Phase 2: templates -----
  if (urlPath === '/api/templates' && req.method === 'GET') {
    try {
      const rows = db.listTemplates();
      return sendJSON(res, 200, {
        templates: rows.map((r) => ({
          id: r.id,
          slug: r.slug,
          name: r.name,
          description: r.description,
          settings: (() => { try { return JSON.parse(r.settings_json || '{}'); } catch { return {}; } })(),
        })),
      });
    } catch (e) {
      return sendJSON(res, 500, { error: e.message || 'Failed' });
    }
  }

  // ----- Phase 2: activity -----
  if (urlPath === '/api/activity' && req.method === 'GET') {
    try {
      const code = (parsed.searchParams.get('code') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!code) return sendJSON(res, 400, { error: 'code required' });
      const meeting = meetings.get(code);
      const live = meeting && Array.isArray(meeting.activityLive) ? meeting.activityLive.slice(-50) : [];
      const rows = db.getActivityForCode(code, 100);
      return sendJSON(res, 200, {
        live,
        history: rows.map((r) => ({
          id: r.id,
          at: r.at,
          actorName: r.actor_name,
          eventType: r.event_type,
          detail: r.detail,
        })),
      });
    } catch (e) {
      return sendJSON(res, 500, { error: e.message || 'Failed' });
    }
  }

  // Recording state for a meeting
  if (urlPath === '/api/recording' && req.method === 'GET') {
    try {
      const code = (parsed.searchParams.get('code') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const meeting = meetings.get(code);
      const active = meeting?.recording || null;
      const past = code ? db.getRecordingsForCode(code, 10) : [];
      return sendJSON(res, 200, { recording: active, past });
    } catch (e) {
      return sendJSON(res, 500, { error: e.message || 'Failed' });
    }
  }

  // Enhanced history detail already exists; add activity to history detail response

  // Static files
  let staticPath = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.join(PUBLIC, path.normalize(staticPath).replace(/^(\.\.[/\\])+/, ''));

  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        fs.readFile(path.join(PUBLIC, 'index.html'), (e2, html) => {
          if (e2) { res.writeHead(404); return res.end('Not found'); }
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
          });
          res.end(html);
        });
        return;
      }
      res.writeHead(500);
      return res.end('Server error');
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    // HTML always revalidate; hashed/query-busted assets can be short-cached
    const cache =
      ext === '.html' || staticPath === '/index.html'
        ? 'no-cache, no-store, must-revalidate'
        : 'public, max-age=60, must-revalidate';
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': cache,
    });
    res.end(data);
  });
  };
}

module.exports = { createRequestHandler };
