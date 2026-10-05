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

const {
  PORT,
  PUBLIC,
  LIVEKIT_URL,
  LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET,
  ACCOUNTS_URL,
  ACCOUNTS_JWT_SECRET,
  MIME,
} = config;

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
      db: db.USE_PG ? "postgresql" : db.DB_PATH,
      postgres: !!db.USE_PG,
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
      const linked = await ensureAccountsUser({
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
      const linked = await ensureAccountsUser({
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

      if (await db.getUserByUsername(username)) {
        return sendJSON(res, 409, { error: 'Username already taken' });
      }
      if (await db.getUserByEmail(email)) {
        return sendJSON(res, 409, { error: 'Email already registered' });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const user = await db.createUser({ username, email, passwordHash });
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
            const linked = await ensureAccountsUser({
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

      const row = await db.findUserByLogin(login);
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
    const rows = await db.getHistoryForUser(user.id, limit);
    const history = [];
    for (const r of rows) {
      let artifact = null;
      try {
        if (r.ended_at) {
          artifact = await db.ensureArtifactForHistory(r.id, r.code);
        } else {
          artifact = await db.getArtifactForHistory(r.id);
        }
      } catch (_) {}
      history.push({
        id: r.id,
        code: r.code,
        name: r.name,
        hostDisplayName: r.host_display_name,
        createdAt: r.created_at,
        endedAt: r.ended_at,
        maxParticipants: r.max_participants,
        wasHost: !!r.was_host,
        artifactSlug: artifact ? artifact.artifact_slug : null,
        artifactUrl: artifact ? `/m/${r.code}/${artifact.artifact_slug}` : null,
      });
    }
    return sendJSON(res, 200, { history });
  }

  if (urlPath.startsWith('/api/history/') && req.method === 'GET') {
    const user = await getAuthUser(req);
    if (!user) return sendJSON(res, 401, { error: 'Not authenticated' });
    const id = parseInt(urlPath.split('/').pop(), 10);
    if (!id) return sendJSON(res, 400, { error: 'Invalid id' });
    const meeting = await db.getMeetingHistoryById(id);
    if (!meeting) return sendJSON(res, 404, { error: 'Not found' });
    // Only host or someone who joined can view
    const participants = await db.getMeetingParticipantsLog(id);
    const allowed =
      meeting.host_user_id === user.id ||
      participants.some((p) => p.user_id === user.id);
    if (!allowed) return sendJSON(res, 403, { error: 'Forbidden' });
    let artifact = null;
    try {
      if (meeting.ended_at) artifact = await db.ensureArtifactForHistory(id, meeting.code);
      else artifact = await db.getArtifactForHistory(id);
    } catch (_) {}
    const recordings = await db.getRecordingsForHistory(id).catch(() => []);
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
      artifact: artifact
        ? {
            id: artifact.id,
            slug: artifact.artifact_slug,
            url: `/m/${meeting.code}/${artifact.artifact_slug}`,
            isLive: !!artifact.is_live,
            isPublic: !!artifact.is_public,
          }
        : null,
      recordings: (recordings || []).map((rec) => ({
        id: rec.id,
        status: rec.status,
        startedAt: rec.started_at,
        endedAt: rec.ended_at,
        fileUrl: rec.file_url || null,
      })),
    });
  }

  // ----- Artifacts (Phase 1) -----
  if (urlPath.startsWith('/api/artifacts/') && req.method === 'GET') {
    const parts = urlPath.split('/').filter(Boolean); // api, artifacts, code, slug
    if (parts.length >= 4) {
      const code = parts[2].toUpperCase();
      const slug = parts[3];
      const artifact = await db.getArtifactBySlug(code, slug);
      if (!artifact) return sendJSON(res, 404, { error: 'Artifact not found' });
      const meeting = artifact.meeting_history_id
        ? await db.getMeetingHistoryById(artifact.meeting_history_id)
        : null;
      const user = await getAuthUser(req);
      const isPublic = !!artifact.is_public;
      let allowed = isPublic;
      if (!allowed && user && meeting) {
        const partsLog = await db.getMeetingParticipantsLog(meeting.id);
        allowed =
          meeting.host_user_id === user.id ||
          partsLog.some((p) => p.user_id === user.id);
      }
      if (!allowed) return sendJSON(res, 403, { error: 'Forbidden' });
      const chat = await db.getChatForArtifact(artifact.id).catch(() => []);
      const activity = meeting
        ? await db.getActivityForMeeting(meeting.id).catch(() => [])
        : [];
      const recordings = meeting
        ? await db.getRecordingsForHistory(meeting.id).catch(() => [])
        : [];
      const participants = meeting
        ? await db.getMeetingParticipantsLog(meeting.id).catch(() => [])
        : [];
      let note = null;
      if (user) note = await db.getPersonalNote(artifact.id, user.id).catch(() => null);
      return sendJSON(res, 200, {
        artifact: {
          id: artifact.id,
          code: artifact.short_code,
          slug: artifact.artifact_slug,
          isLive: !!artifact.is_live,
          isPublic: isPublic,
          createdAt: artifact.created_at,
        },
        meeting: meeting
          ? {
              id: meeting.id,
              code: meeting.code,
              name: meeting.name,
              hostDisplayName: meeting.host_display_name,
              createdAt: meeting.created_at,
              endedAt: meeting.ended_at,
            }
          : null,
        chat: (chat || []).map((c) => ({
          id: c.id,
          senderId: c.sender_id,
          senderName: c.sender_name,
          body: c.body,
          attachments: typeof c.attachments === 'string' ? JSON.parse(c.attachments || 'null') : c.attachments,
          createdAt: c.created_at,
        })),
        activity,
        recordings: (recordings || []).map((rec) => ({
          id: rec.id,
          status: rec.status,
          startedAt: rec.started_at,
          endedAt: rec.ended_at,
          fileUrl: rec.file_url || null,
        })),
        participants: (participants || []).map((p) => ({
          displayName: p.display_name,
          userId: p.user_id,
          joinedAt: p.joined_at,
          leftAt: p.left_at,
        })),
        note: note ? { content: note.content, updatedAt: note.updated_at } : null,
        isHost: !!(user && meeting && meeting.host_user_id === user.id),
      });
    }
  }

  if (urlPath.match(/^\/api\/artifacts\/[^/]+\/[^/]+\/note$/) && req.method === 'POST') {
    const user = await getAuthUser(req);
    if (!user) return sendJSON(res, 401, { error: 'Not authenticated' });
    const parts = urlPath.split('/').filter(Boolean);
    const code = parts[2].toUpperCase();
    const slug = parts[3];
    const artifact = await db.getArtifactBySlug(code, slug);
    if (!artifact) return sendJSON(res, 404, { error: 'Artifact not found' });
    const body = await parseBody(req);
    const note = await db.upsertPersonalNote({
      artifactId: artifact.id,
      userId: user.id,
      content: body.content || '',
    });
    return sendJSON(res, 200, { note: { content: note.content, updatedAt: note.updated_at } });
  }

  if (urlPath.match(/^\/api\/artifacts\/[^/]+\/[^/]+\/restart$/) && req.method === 'POST') {
    const user = await getAuthUser(req);
    if (!user) return sendJSON(res, 401, { error: 'Not authenticated' });
    const parts = urlPath.split('/').filter(Boolean);
    const code = parts[2].toUpperCase();
    const slug = parts[3];
    const artifact = await db.getArtifactBySlug(code, slug);
    if (!artifact) return sendJSON(res, 404, { error: 'Artifact not found' });
    const meeting = artifact.meeting_history_id
      ? await db.getMeetingHistoryById(artifact.meeting_history_id)
      : null;
    if (!meeting || meeting.host_user_id !== user.id) {
      return sendJSON(res, 403, { error: 'Only the host can restart this meeting' });
    }
    await db.setArtifactLive(artifact.id, true);
    return sendJSON(res, 200, {
      ok: true,
      joinUrl: `/?join=${encodeURIComponent(code)}`,
      code,
      artifactSlug: slug,
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
      const code = generateCode();
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

      const historyId = await db.startMeetingHistory({
        code,
        name,
        hostUserId: authUser ? authUser.id : null,
        hostDisplayName: hostName,
      });

      await db.logParticipantJoin({
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
          await db.updateScheduledStatus(body.scheduledId, 'live', {
            startedAt: new Date().toISOString(),
          });
        } catch (_) {}
      }

      const meeting = meetings.get(code);
      try {
        await db.upsertMembership({
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
        membership = await db.getMembership(code, {
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
        await db.logParticipantJoin({
          meetingHistoryId: meeting.historyId,
          userId: authUser ? authUser.id : null,
          displayName: participantName,
          participantId: pid,
        });
        await db.updateMaxParticipants(
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
          await db.upsertMembership({
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
        await db.upsertMembership({
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
      const code = generateCode();
      const row = await db.createScheduledMeeting({
        code,
        name,
        hostUserId: authUser.id,
        hostDisplayName: authUser.displayName || authUser.username || null,
        scheduledStart: startDate.toISOString(),
        scheduledEnd,
      });
      return sendJSON(res, 201, {
        id: row.id,
        code: row.code,
        name: row.name,
        scheduledStart: row.scheduled_start,
        scheduledEnd: row.scheduled_end,
        status: row.status,
        link: `/${row.code.slice(0, 3)}-${row.code.slice(3)}`,
      });
    } catch (e) {
      console.error('[schedule]', e);
      return sendJSON(res, 400, { error: e.message || 'Bad request' });
    }
  }

  if (urlPath === '/api/schedule' && req.method === 'GET') {
    try {
      const authUser = await getAuthUser(req);
      if (!authUser || !authUser.id) return sendJSON(res, 401, { error: 'Login required' });
      const rows = await db.getScheduledForUser(authUser.id, 50);
      return sendJSON(res, 200, {
        meetings: rows.map((r) => ({
          id: r.id,
          code: r.code,
          name: r.name,
          scheduledStart: r.scheduled_start,
          scheduledEnd: r.scheduled_end,
          status: r.status,
          createdAt: r.created_at,
          startedAt: r.started_at,
          endedAt: r.ended_at,
          link: `/${r.code.slice(0, 3)}-${r.code.slice(3)}`,
          isLive: meetings.has(r.code),
        })),
      });
    } catch (e) {
      return sendJSON(res, 500, { error: e.message || 'Failed' });
    }
  }

  if (urlPath.startsWith('/api/schedule/') && req.method === 'DELETE') {
    try {
      const authUser = await getAuthUser(req);
      if (!authUser || !authUser.id) return sendJSON(res, 401, { error: 'Login required' });
      const id = parseInt(urlPath.split('/').pop(), 10);
      if (!id) return sendJSON(res, 400, { error: 'Invalid id' });
      await db.deleteScheduled(id, authUser.id);
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
      const row = await db.getScheduledById(id);
      if (!row || row.host_user_id !== authUser.id) {
        return sendJSON(res, 404, { error: 'Scheduled meeting not found' });
      }
      return sendJSON(res, 200, {
        code: row.code,
        name: row.name,
        scheduledId: row.id,
      });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message || 'Bad request' });
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
          await db.logParticipantLeave({
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
      const rows = await db.listTemplates();
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
      const rows = await db.getActivityForCode(code, 100);
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
      const past = code ? await db.getRecordingsForCode(code, 10) : [];
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
