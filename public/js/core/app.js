(function () {
  const $ = (id) => document.getElementById(id);

  const homeView = $('homeView');
  const meetingView = $('meetingView');
  const historyView = $('historyView');
  const col1 = $('col1');
  const resizer = $('resizer');
  const themeToggle = $('themeToggle');
  const fullscreenBtn = $('fullscreenBtn');
  const leaveBtn = $('leaveBtn');
  const meetingBadge = $('meetingBadge');
  const copyCodeBtn = $('copyCodeBtn');

  const createName = $('createName');
  const createYourName = $('createYourName');
  const createBtn = $('createBtn');
  const createError = $('createError');
  const joinLetters = $('joinLetters');
  const joinNumbers = $('joinNumbers');
  const joinYourName = $('joinYourName');
  const joinBtn = $('joinBtn');
  const joinError = $('joinError');

  const participantList = $('participantList');
  const participantCount = $('participantCount');
  const screenCards = $('screenCards');
  const remoteVideo = $('remoteVideo');
  const bigPlaceholder = $('bigPlaceholder');
  const bigViewLabel = $('bigViewLabel');
  const bigView = $('bigView');
  const screenFsBtn = $('screenFsBtn');
  const shareBtn = $('shareBtn');
  const micBtn = $('micBtn');

  const authArea = $('authArea');
  const userArea = $('userArea');
  const userLabel = $('userLabel');
  const loginOpenBtn = $('loginOpenBtn');
  const signupOpenBtn = $('signupOpenBtn');
  const logoutBtn = $('logoutBtn');
  const historyBtn = $('historyBtn');
  const historyCloseBtn = $('historyCloseBtn');
  const historyList = $('historyList');
  const historyEmpty = $('historyEmpty');
  const historyDetail = $('historyDetail');
  const historyDetailTitle = $('historyDetailTitle');
  const historyDetailMeta = $('historyDetailMeta');
  const historyDetailParticipants = $('historyDetailParticipants');
  const historyDetailBack = $('historyDetailBack');

  const authModal = $('authModal');
  const authModalBackdrop = $('authModalBackdrop');
  const authModalClose = $('authModalClose');
  const tabLogin = $('tabLogin');
  const tabSignup = $('tabSignup');
  const loginForm = $('loginForm');
  const signupForm = $('signupForm');
  const loginError = $('loginError');
  const signupError = $('signupError');

  let currentMeeting = null;
  let participants = [];
  let ws = null;
  let isSharing = false;
  let micOn = false;
  let watchingId = null;
  let pollTimer = null;
  let wsRetryTimer = null;
  let wsAttempt = 0;

  let room = null;
  let livekitUrl = null;
  const remoteMedia = {};
  const LK = window.LivekitClient || window.livekit;

  let authToken = localStorage.getItem('meet_token') || null;
  let currentUser = null;
  let accountsEnabled = false;

  const SESSION_KEY = 'meet_session';

  /** Parse meeting code from path: /ABC-123, /ABC/123, /abc123 */
  function parseMeetingCodeFromPath(pathname) {
    const path = (pathname || location.pathname || '/').replace(/\/+$/, '') || '/';
    if (path === '/' || path.startsWith('/api')) return null;
    // /ABC-123 or /ABC_123
    let m = path.match(/^\/([A-Za-z]{3})[-_](\d{3})$/);
    if (m) return (m[1] + m[2]).toUpperCase();
    // /ABC/123
    m = path.match(/^\/([A-Za-z]{3})\/(\d{3})$/);
    if (m) return (m[1] + m[2]).toUpperCase();
    // /ABC123
    m = path.match(/^\/([A-Za-z]{3})(\d{3})$/);
    if (m) return (m[1] + m[2]).toUpperCase();
    return null;
  }

  function meetingPath(code) {
    const c = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (c.length !== 6) return '/';
    return '/' + c.slice(0, 3) + '-' + c.slice(3);
  }

  function setMeetingUrl(code, replace) {
    const path = meetingPath(code);
    if (location.pathname === path) return;
    if (replace) history.replaceState({ meet: code }, '', path);
    else history.pushState({ meet: code }, '', path);
  }

  function clearMeetingUrl(replace) {
    if (location.pathname === '/' || location.pathname === '') return;
    if (replace) history.replaceState({}, '', '/');
    else history.pushState({}, '', '/');
  }

  function saveSession(meeting) {
    if (!meeting) {
      try { sessionStorage.removeItem(SESSION_KEY); } catch (_) {}
      return;
    }
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({
        code: meeting.code,
        participantId: meeting.participantId,
        participantName: meeting.participantName,
        isHost: !!meeting.isHost,
        wsCredential: meeting.wsCredential || null,
      }));
    } catch (_) {}
  }

  function loadSession() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  /** Display name is required — reject empty or generic Guest/Host-only labels. */
  function isValidDisplayName(name) {
    const n = (name || '').trim();
    if (n.length < 2) return false;
    if (/^(guest|host)$/i.test(n)) return false;
    return true;
  }

  function normalizeDisplayName(name) {
    return (name || '').trim().slice(0, 40);
  }

  function showError(el, msg) {
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden');
  }
  function hideError(el) {
    if (!el) return;
    el.classList.add('hidden');
    el.textContent = '';
  }

  async function api(path, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (authToken) headers.Authorization = 'Bearer ' + authToken;
    const res = await fetch(path, { ...options, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  function formatCode(letters, numbers) {
    return `${letters}—${numbers}`;
  }

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function formatDate(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
      return d.toLocaleString();
    } catch {
      return iso;
    }
  }

  // ----- Auth UI -----

  function displayNameOf(u) {
    if (!u) return '';
    const bad = (v) => !v || /^accounts:/.test(v) || /^acc_/.test(v) || /@accounts\.local$/.test(v);
    const emailName = u.email && String(u.email).split('@')[0];
    for (const c of [u.displayName, u.display_name, u.username, emailName]) {
      if (c && !bad(c)) return String(c);
    }
    return 'User';
  }

  function updateAuthUI() {
    if (currentUser) {
      authArea?.classList.add('hidden');
      userArea?.classList.remove('hidden');
      const name = displayNameOf(currentUser);
      if (userLabel) userLabel.textContent = name;
      try { if (typeof applySelfChatColor === 'function') applySelfChatColor(); } catch (_) {}
      if (createYourName && !createYourName.value) createYourName.value = name;
      if (joinYourName && !joinYourName.value) joinYourName.value = name;
    } else {
      authArea?.classList.remove('hidden');
      userArea?.classList.add('hidden');
    }
    // Keep mobile overflow menu in sync
    document.querySelectorAll('.more-history, .more-logout').forEach((el) => {
      el.classList.toggle('hidden', !currentUser);
    });
    document.querySelectorAll('.more-login, .more-signup').forEach((el) => {
      el.classList.toggle('hidden', !!currentUser);
    });
  }

  function openAuthModal(tab) {
    authModal?.classList.remove('hidden');
    if (tab === 'signup') {
      tabSignup?.classList.add('active');
      tabLogin?.classList.remove('active');
      signupForm?.classList.remove('hidden');
      loginForm?.classList.add('hidden');
    } else {
      tabLogin?.classList.add('active');
      tabSignup?.classList.remove('active');
      loginForm?.classList.remove('hidden');
      signupForm?.classList.add('hidden');
    }
    hideError(loginError);
    hideError(signupError);
  }

  function closeAuthModal() {
    authModal?.classList.add('hidden');
  }

  async function loadConfig() {
    try {
      const cfg = await api('/api/config');
      accountsEnabled = !!cfg.accountsEnabled;
      livekitUrl = cfg.livekitUrl || livekitUrl || null;
      if (cfg.features && typeof window.MeetBoot === 'function') {
        window.MeetBoot(cfg.features);
      }
    } catch {
      accountsEnabled = false;
    }
  }

  async function restoreSession() {
    await loadConfig();
    if (!authToken) {
      updateAuthUI();
      return;
    }
    try {
      const data = await api('/api/me');
      currentUser = data.user;
    } catch {
      authToken = null;
      currentUser = null;
      localStorage.removeItem('meet_token');
    }
    updateAuthUI();
  }

  loginOpenBtn?.addEventListener('click', () => openAuthModal('login'));
  signupOpenBtn?.addEventListener('click', () => openAuthModal('signup'));
  authModalClose?.addEventListener('click', closeAuthModal);
  authModalBackdrop?.addEventListener('click', closeAuthModal);
  tabLogin?.addEventListener('click', () => openAuthModal('login'));
  tabSignup?.addEventListener('click', () => openAuthModal('signup'));

  // Mobile overflow menu (theme / fullscreen / auth)
  const moreMenuBtn = $('moreMenuBtn');
  const moreMenu = $('moreMenu');
  function closeMoreMenu() {
    moreMenu?.classList.add('hidden');
    moreMenuBtn?.setAttribute('aria-expanded', 'false');
  }
  moreMenuBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = moreMenu?.classList.toggle('hidden') === false;
    moreMenuBtn.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', (e) => {
    if (!moreMenu || moreMenu.classList.contains('hidden')) return;
    if (moreMenu.contains(e.target) || moreMenuBtn?.contains(e.target)) return;
    closeMoreMenu();
  });
  moreMenu?.addEventListener('click', (e) => {
    const item = e.target.closest('.more-item');
    if (!item) return;
    const action = item.dataset.action;
    closeMoreMenu();
    if (action === 'theme') themeToggle?.click();
    else if (action === 'fullscreen') fullscreenBtn?.click();
    else if (action === 'history') historyBtn?.click();
    else if (action === 'logout') logoutBtn?.click();
    else if (action === 'login') openAuthModal('login');
    else if (action === 'signup') openAuthModal('signup');
    else if (action === 'copy-code') copyCodeBtn?.click();
    else if (action === 'share-link') {
      if (typeof copyInviteLink === 'function') copyInviteLink();
      else $('shareLinkBtnTop')?.click();
    }
    else if (action === 'leave') leaveBtn?.click();
    else if (action === 'end-meeting') {
      if (typeof endMeetingConfirm === 'function') endMeetingConfirm();
      else $('endMeetBtnTop')?.click();
    }
  });

  function syncMoreMenuInCall() {
    const inCall = !!(currentMeeting && meetingView && !meetingView.classList.contains('hidden'));
    document.querySelectorAll('.more-in-call').forEach((el) => {
      el.classList.toggle('hidden', !inCall);
    });
    const isHost = !!(currentMeeting && (
      currentMeeting.isHost ||
      myRole === 'host' ||
      myRole === 'cohost'
    ));
    document.querySelectorAll('.more-end').forEach((el) => {
      el.classList.toggle('hidden', !inCall || !isHost);
    });
  }

  loginForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError(loginError);
    try {
      const identity = $('loginIdentity')?.value?.trim();
      const password = $('loginPassword')?.value;
      if (!identity || !password) {
        showError(loginError, 'Email and password are required');
        return;
      }
      await loadConfig();
      let data;
      // Always try suite Accounts SSO first (email + password from Collab Accounts)
      try {
        data = await api('/api/accounts/login', {
          method: 'POST',
          body: JSON.stringify({ email: identity, login: identity, password }),
        });
      } catch (accountsErr) {
        // If Accounts is not configured on server, fall back to local Meet auth
        const msg = (accountsErr && accountsErr.message) || '';
        if (/not configured|503|unreachable|Failed to fetch|NetworkError/i.test(msg) && !accountsEnabled) {
          data = await api('/api/login', {
            method: 'POST',
            body: JSON.stringify({ login: identity, email: identity, password }),
          });
        } else {
          throw accountsErr;
        }
      }
      authToken = data.token;
      currentUser = data.user;
      localStorage.setItem('meet_token', authToken);
      updateAuthUI();
      closeAuthModal();
    } catch (err) {
      showError(loginError, err.message || 'Invalid credentials');
    }
  });

  signupForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError(signupError);
    try {
      const username = $('signupUsername')?.value?.trim();
      const email = $('signupEmail')?.value?.trim();
      const password = $('signupPassword')?.value;
      let data;
      try {
        data = await api('/api/accounts/signup', {
          method: 'POST',
          body: JSON.stringify({
            username,
            email,
            password,
            display_name: username,
          }),
        });
      } catch (accountsErr) {
        const msg = (accountsErr && accountsErr.message) || '';
        if (/not configured|503|unreachable|Failed to fetch|NetworkError/i.test(msg) && !accountsEnabled) {
          data = await api('/api/signup', {
            method: 'POST',
            body: JSON.stringify({ username, email, password }),
          });
        } else {
          throw accountsErr;
        }
      }
      authToken = data.token;
      currentUser = data.user;
      localStorage.setItem('meet_token', authToken);
      updateAuthUI();
      closeAuthModal();
    } catch (err) {
      showError(signupError, err.message);
    }
  });

  logoutBtn?.addEventListener('click', () => {
    authToken = null;
    currentUser = null;
    localStorage.removeItem('meet_token');
    updateAuthUI();
    if (historyView && !historyView.classList.contains('hidden')) {
      showHome();
    }
  });

  // ----- History -----

  function showHome() {
    historyView?.classList.add('hidden');
    meetingView?.classList.add('hidden');
    homeView?.classList.remove('hidden');
  }

  async function showHistory() {
    if (!currentUser) {
      openAuthModal('login');
      return;
    }
    homeView?.classList.add('hidden');
    meetingView?.classList.add('hidden');
    historyView?.classList.remove('hidden');
    historyDetail?.classList.add('hidden');
    historyList?.classList.remove('hidden');

    try {
      const data = await api('/api/history');
      const items = data.history || [];
      if (!historyList) return;
      historyList.innerHTML = '';
      if (items.length === 0) {
        historyEmpty?.classList.remove('hidden');
        return;
      }
      historyEmpty?.classList.add('hidden');
      items.forEach((h) => {
        const li = document.createElement('li');
        li.className = 'history-item';
        const status = h.endedAt ? 'Ended' : 'Active / open';
        li.innerHTML = `
          <div class="history-item-main">
            <strong>${escapeHtml(h.name)}</strong>
            <span class="history-code">${escapeHtml(h.code.slice(0, 3))}—${escapeHtml(h.code.slice(3))}</span>
          </div>
          <div class="history-item-meta">
            ${h.wasHost ? '<span class="tag">Host</span>' : '<span class="tag">Joined</span>'}
            <span>${formatDate(h.createdAt)}</span>
            <span>${status}</span>
            <span>${h.maxParticipants} people max</span>
          </div>
        `;
        li.addEventListener('click', () => openHistoryDetail(h.id));
        historyList.appendChild(li);
      });
    } catch (e) {
      if (historyEmpty) {
        historyEmpty.classList.remove('hidden');
        historyEmpty.textContent = e.message;
      }
    }
  }

  async function openHistoryDetail(id) {
    try {
      const data = await api('/api/history/' + id);
      historyList?.classList.add('hidden');
      historyEmpty?.classList.add('hidden');
      historyDetail?.classList.remove('hidden');
      if (historyDetailTitle) historyDetailTitle.textContent = data.meeting.name;
      if (historyDetailMeta) {
        historyDetailMeta.textContent =
          `Code ${data.meeting.code.slice(0, 3)}—${data.meeting.code.slice(3)} · ` +
          `Started ${formatDate(data.meeting.createdAt)} · ` +
          (data.meeting.endedAt ? `Ended ${formatDate(data.meeting.endedAt)}` : 'Still open / not ended') +
          ` · Max ${data.meeting.maxParticipants} participants`;
      }
      if (historyDetailParticipants) {
        historyDetailParticipants.innerHTML = '';
        (data.participants || []).forEach((p) => {
          const li = document.createElement('li');
          li.textContent =
            `${p.displayName} · joined ${formatDate(p.joinedAt)}` +
            (p.leftAt ? ` · left ${formatDate(p.leftAt)}` : ' · (no leave recorded)');
          historyDetailParticipants.appendChild(li);
        });
      }
    } catch (e) {
      alert(e.message);
    }
  }

  historyBtn?.addEventListener('click', showHistory);
  historyCloseBtn?.addEventListener('click', showHome);
  historyDetailBack?.addEventListener('click', () => {
    historyDetail?.classList.add('hidden');
    showHistory();
  });

  // ----- WebSocket -----

  const WS_CLOSE_CODES = {
    1000: 'Normal closure', 1001: 'Going away', 1006: 'Abnormal closure',
  };

  let wsStatusEl = null;
  function setWsStatus(text, isError) {
    const live = document.getElementById('liveStatus');
    const liveText = document.getElementById('liveStatusText');
    const raw = String(text || '').toLowerCase();

    let label = text;
    let state = 'idle';
    if (isError || /fail|error|closed|left/.test(raw)) {
      label = /left/.test(raw) ? 'Left' : 'Offline';
      state = 'error';
    } else if (/connect/.test(raw) && !/connected/.test(raw)) {
      label = 'Connecting…';
      state = 'connecting';
    } else if (/connected|open|live|ok/.test(raw)) {
      label = 'Live';
      state = 'live';
    }

    if (live && liveText) {
      liveText.textContent = label;
      live.classList.remove('is-live', 'is-connecting', 'is-error', 'is-idle');
      live.classList.add('is-' + state);
      live.classList.remove('hidden');
    }

    // Keep a minimal non-debug footer hint only while developing is not needed —
    // remove floating WS overlay if present.
    if (wsStatusEl) {
      try { wsStatusEl.remove(); } catch (_) {}
      wsStatusEl = null;
    }
  }

  function getWsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = location.host || location.hostname;
    return host ? proto + '//' + host : null;
  }

  function connectWS() {
    if (!currentMeeting) return;
    const url = getWsUrl();
    if (!url) return;

    if (ws) {
      try { ws.onclose = null; ws.close(); } catch (_) {}
      ws = null;
    }

    wsAttempt += 1;
    setWsStatus('connecting...');
    let socket;
    try { socket = new WebSocket(url); } catch (err) {
      setWsStatus('failed', true);
      scheduleWsRetry();
      return;
    }
    ws = socket;

    socket.onopen = () => {
      setWsStatus('connected');
      sendWS({
        type: 'register',
        participantId: currentMeeting.participantId,
        code: currentMeeting.code,
        wsCredential: currentMeeting.wsCredential,
      });
      // If we already published screen before WS was ready, re-announce so late joiners see our card
      if (isSharing) {
        sendWS({ type: 'start-share' });
      }
    };

    socket.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (window.__meetPhase2OnMsg) { try { window.__meetPhase2OnMsg(msg); } catch (_) {} }
      if (msg.type === 'meeting-ended') {
        // Server closed the room (empty or 12h inactivity)
        stopPolling();
        if (wsRetryTimer) clearTimeout(wsRetryTimer);
        if (ws) { try { ws.onclose = null; ws.close(); } catch (_) {} ws = null; }
        disconnectLiveKit();
        clearBigView();
        currentMeeting = null;
        participants = [];
        saveSession(null);
        clearMeetingUrl(true);
        meetingView?.classList.add('hidden');
        homeView?.classList.remove('hidden');
        leaveBtn?.classList.add('hidden');
        meetingBadge?.classList.add('hidden');
        copyCodeBtn?.classList.add('hidden');
        $('meetingNameTop')?.classList.add('hidden');
        $('shareLinkBtnTop')?.classList.add('hidden');
        $('endMeetBtnTop')?.classList.add('hidden');
        setWsStatus('ended');
        return;
      }
      if (msg.type === 'participants' || msg.type === 'participant-joined' ||
          msg.type === 'participant-left' || msg.type === 'share-started' || msg.type === 'share-stopped' ||
          msg.type === 'participant-removed' || msg.type === 'role-changed' || msg.type === 'host-transferred') {
        if (msg.participants) participants = msg.participants;
        if (msg.waiting) waitingList = msg.waiting;
        if (msg.raisedHands) raisedHands = msg.raisedHands;
        if (msg.security) securityState = msg.security;
        // Update my role/permissions from roster
        if (currentMeeting && currentMeeting.participantId) {
          const me = participants.find((p) => p.id === currentMeeting.participantId);
          if (me) {
            myRole = me.role || myRole;
            if (me.isHost || me.role === 'host') {
              myRole = 'host';
              currentMeeting.isHost = true;
              currentMeeting.role = 'host';
            }
            ensureModPermissions(me.permissions || null);
          } else {
            ensureModPermissions();
          }
        }
        try { syncSharingFlagsFromLiveKit(); } catch (_) {
          renderParticipants();
          renderCards();
        }
        try { updateShareButton(); } catch (_) {}
        if ((msg.type === 'participant-left' || msg.type === 'share-stopped' || msg.type === 'participant-removed') && watchingId === msg.participantId) {
          clearBigView();
        }
        return;
      }
      if (msg.type === 'waiting-request' || msg.type === 'waiting-updated') {
        if (msg.waiting) waitingList = msg.waiting;
        renderParticipants();
        if (msg.type === 'waiting-request' && msg.participant) {
          showToast((msg.participant.name || 'Someone') + ' wants to join');
        }
        return;
      }
      if (msg.type === 'hand-raised' || msg.type === 'hand-lowered' || msg.type === 'hands-cleared') {
        if (msg.raisedHands) raisedHands = msg.raisedHands;
        if (msg.type === 'hand-lowered' && msg.participantId === currentMeeting?.participantId) {
          handRaised = false;
          const rb = document.getElementById('raiseHandBtn');
          if (rb) { rb.classList.remove('active'); rb.setAttribute('aria-pressed', 'false'); }
        }
        renderParticipants();
        return;
      }
      if (msg.type === 'ask-unmute') {
        showToast((msg.byName || 'Host') + ' is asking you to unmute.', [
          { label: 'Unmute', onClick: function () {
            try { if (!micEnabled) toggleMic(); } catch (_) {}
            sendWS({ type: 'unmute-self' });
          }},
          { label: 'Dismiss', onClick: function () {} },
        ]);
        return;
      }
      if (msg.type === 'removed' || msg.type === 'declined') {
        alert(msg.type === 'removed' ? 'You were removed from the meeting.' : 'The host declined your request to join.');
        try { leaveMeeting(); } catch (_) { location.href = '/'; }
        return;
      }
      if (msg.type === 'admitted') {
        hideWaitingRoom();
        if (msg.participants) participants = msg.participants;
        if (msg.waiting) waitingList = msg.waiting;
        showToast('You were admitted to the meeting');
        try {
          const mv = document.getElementById('meetingView');
          const hv = document.getElementById('homeView');
          const wv = document.getElementById('waitingView');
          if (wv) wv.classList.add('hidden');
          if (hv) hv.classList.add('hidden');
          if (mv) mv.classList.remove('hidden');
          leaveBtn?.classList.remove('hidden');
          if (meetingBadge && currentMeeting) {
            meetingBadge.textContent = formatCode(currentMeeting.letters, currentMeeting.numbers);
            meetingBadge.classList.remove('hidden');
          }
          copyCodeBtn?.classList.remove('hidden');
          if (currentMeeting) {
            const me = participants.find((p) => p.id === currentMeeting.participantId);
            if (me) {
              myRole = me.role || myRole;
              if (me.isHost || me.role === 'host') {
                myRole = 'host';
                currentMeeting.isHost = true;
              }
              ensureModPermissions(me.permissions || null);
            } else {
              ensureModPermissions();
            }
          }
          renderParticipants();
          renderCards();
          connectWS();
          startPolling();
          connectLiveKit();
        } catch (e) { console.warn('[admitted]', e); }
        return;
      }
      if (msg.type === 'security-updated' || msg.type === 'meeting-locked') {
        if (msg.security) securityState = msg.security;
        if (typeof msg.locked === 'boolean') {
          securityState = securityState || {};
          securityState.locked = msg.locked;
          showToast(msg.locked ? 'Meeting locked' : 'Meeting unlocked');
        }
        applySecurityToForm(securityState);
        const badge = document.getElementById('meetingBadge');
        if (badge && securityState) {
          badge.classList.toggle('locked', !!securityState.locked);
        }
        return;
      }
      if (msg.type === 'chat') {
        appendChatMessage(msg);
        return;
      }
      if (msg.type === 'chat-history') {
        var box = $('chatMessages');
        if (box) box.innerHTML = '';
        (msg.messages || []).forEach(function (m) { appendChatMessage(m); });
        return;
      }
      if (msg.type === 'reaction') {
        showReaction(msg);
        return;
      }
      if (msg.type === 'force-mute') {
        forceMuteLocal(msg);
        return;
      }
      if (msg.type === 'permissions-updated') {
        if (msg.permissions) {
          myPermissions = Object.assign({}, myPermissions || {}, msg.permissions);
          ensureModPermissions(msg.permissions);
        }
        try { updateShareButton(); } catch (_) {}
        // If screen share revoked while sharing, stop locally
        if (isSharing && myPermissions && myPermissions.screenShare === false &&
            myRole !== 'host' && myRole !== 'cohost') {
          try { stopShare(); } catch (_) {}
        }
        showToast('Your permissions were updated');
        return;
      }
      if (msg.type === 'force-stop-share') {
        try {
          if (typeof isSharing !== 'undefined' && isSharing && typeof stopShare === 'function') {
            stopShare();
          }
          showToast((msg.byName || 'Host') + ' stopped your screen share');
        } catch (_) {}
        return;
      }
      if (msg.type === 'error' && msg.error) {
        showToast(msg.error);
        return;
      }
      if (msg.type === 'content-state') {
        applyContentState(msg.content);
        return;
      }
      if (msg.type === 'content-update') {
        applyContentUpdate(msg.content, msg.from);
        return;
      }
    };

    socket.onclose = () => {
      setWsStatus('closed', true);
      if (ws === socket) ws = null;
      if (currentMeeting) scheduleWsRetry();
    };
    socket.onerror = () => setWsStatus('error', true);
  }

  function scheduleWsRetry() {
    if (wsRetryTimer) clearTimeout(wsRetryTimer);
    wsRetryTimer = setTimeout(() => {
      wsRetryTimer = null;
      if (currentMeeting) connectWS();
    }, 2000);
  }

  function sendWS(obj) {
    if (ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify(obj)); } catch (_) {}
    }
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(async () => {
      if (!currentMeeting) return;
      try {
        const data = await api('/api/meeting/' + currentMeeting.code);
        const next = data.participants || [];
        const prevKey = participants.map(p => p.id + ':' + !!p.sharing).join('|');
        const nextKey = next.map(p => p.id + ':' + !!p.sharing).join('|');
        if (prevKey !== nextKey) {
          participants = next;
          renderParticipants();
          renderCards();
          if (watchingId) {
            const still = next.find(p => p.id === watchingId && p.sharing);
            if (!still) clearBigView();
          }
        }
      } catch (e) {
        // Meeting no longer exists (ended / 12h inactivity)
        if (e && /not found|404/i.test(String(e.message || e))) {
          leaveMeeting();
        }
      }
    }, 3000);
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  // ----- LiveKit -----

  async function connectLiveKit() {
    if (!LK || !currentMeeting) return;

    let tokenData;
    try {
      tokenData = await api('/api/livekit-token', {
        method: 'POST',
        body: JSON.stringify({
          code: currentMeeting.code,
          participantId: currentMeeting.participantId,
          participantName: currentMeeting.participantName,
        }),
      });
    } catch (e) {
      console.error('LiveKit token error', e);
      alert('Could not get media token: ' + e.message);
      return;
    }

    const url = tokenData.url || livekitUrl;
    if (!url) {
      alert('LiveKit URL is not configured (LIVEKIT_URL).');
      return;
    }

    await disconnectLiveKit();

    // adaptiveStream can leave screen-share black if the video element
    // reports 0 size during layout; this app only shows one big screen so
    // we turn it off for reliability.
    // Audio-first on poor networks: Opus with DTX, lower video priority.
    // adaptiveStream off avoids black screen-share when layout size is 0.
    // Screen share: prioritize resolution for video (YouTube etc.).
    // Audio stays speech-optimized; screen video needs higher bitrate/fps than slides.
    room = new LK.Room({
      adaptiveStream: false,
      dynacast: false,
      reconnectPolicy: {
        nextRetryDelayInMs: (context) => Math.min(1000 * Math.pow(2, context.retryCount || 0), 15000),
      },
      publishDefaults: {
        videoCodec: 'vp8',
        audioPreset: LK.AudioPresets?.speech || undefined,
        dtx: true,
        red: true,
        // High ceiling; actual bitrate chosen by send quality (high/medium/low)
        screenShareEncoding: {
          maxBitrate: 10_000_000,
          maxFramerate: 30,
        },
        videoEncoding: {
          maxBitrate: 1_500_000,
          maxFramerate: 24,
        },
        degradationPreference: 'maintain-resolution',
      },
      audioCaptureDefaults: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });

    room
      .on(LK.RoomEvent.TrackSubscribed, handleTrackSubscribed)
      .on(LK.RoomEvent.TrackUnsubscribed, handleTrackUnsubscribed)
      .on(LK.RoomEvent.ParticipantDisconnected, (p) => {
        cleanupRemoteMedia(p.identity);
        if (watchingId === p.identity) clearBigView();
      })
      .on(LK.RoomEvent.LocalTrackPublished, (pub) => {
        console.log('[LiveKit] LocalTrackPublished', {
          source: pub.source,
          kind: pub.kind,
          trackSid: pub.trackSid,
          muted: pub.isMuted,
        });
        if (pub.source === LK.Track.Source.ScreenShare) {
          isSharing = true;
          updateShareButton();
          sendWS({ type: 'start-share' });
          const me = participants.find(p => p.id === currentMeeting.participantId);
          if (me) me.sharing = true;
          renderCards();
          // Show own shared screen in the main view (clicking the card must not stop share)
          if (currentMeeting?.participantId) {
            watchingId = null; // force re-attach
            watchParticipant(currentMeeting.participantId);
          }
        }
      })
      .on(LK.RoomEvent.LocalTrackUnpublished, (pub) => {
        if (pub.source === LK.Track.Source.ScreenShare) {
          isSharing = false;
          updateShareButton();
          sendWS({ type: 'stop-share' });
          const me = participants.find(p => p.id === currentMeeting?.participantId);
          if (me) me.sharing = false;
          if (watchingId && currentMeeting && watchingId === currentMeeting.participantId) {
            clearBigView();
          }
          renderCards();
        }
      })
      .on(LK.RoomEvent.ConnectionStateChanged, (state) => {
        console.log('[LiveKit] connection state:', state);
      })
      .on(LK.RoomEvent.MediaDevicesError, (e) => {
        console.error('[LiveKit] MediaDevicesError', e);
      })
      .on(LK.RoomEvent.SignalConnected, () => {
        console.log('[LiveKit] signal connected');
      })
      .on(LK.RoomEvent.Connected, () => {
        console.log('[LiveKit] room connected', {
          name: room.name,
          localIdentity: room.localParticipant?.identity,
          remoteCount: room.remoteParticipants.size,
        });
        // Publications may finish resolving just after Connected
        attachExistingRemoteScreenTracks();
        syncSharingFlagsFromLiveKit();
      })
      .on(LK.RoomEvent.ParticipantConnected, (participant) => {
        // New remote participant — subscribe to any screen share they already have
        attachParticipantScreenTracks(participant);
        syncSharingFlagsFromLiveKit();
      })
      .on(LK.RoomEvent.TrackPublished, (publication, participant) => {
        // Remote published a track (including ones already live when we joined)
        if (
          participant &&
          publication &&
          publication.source === LK.Track.Source.ScreenShare
        ) {
          try {
            if (typeof publication.setSubscribed === 'function' && !publication.isSubscribed) {
              publication.setSubscribed(true);
            }
          } catch (_) {}
          if (publication.track && publication.track.kind === LK.Track.Kind.Video) {
            handleTrackSubscribed(publication.track, publication, participant);
          }
          markParticipantSharing(participant.identity, true);
        }
      })
      .on(LK.RoomEvent.TrackUnpublished, (publication, participant) => {
        if (publication && publication.source === LK.Track.Source.ScreenShare) {
          markParticipantSharing(participant?.identity, false);
          if (watchingId === participant?.identity) clearBigView();
        }
      })
      .on(LK.RoomEvent.Disconnected, (reason) => {
        console.warn('[LiveKit] disconnected', reason);
      });

    try {
      console.log('[LiveKit] connecting to', url);
      await room.connect(url, tokenData.token, { autoSubscribe: true });
      console.log('[LiveKit] connect OK, state=', room.state);
      micOn = false;
      updateMicButton();
      // Pick up any screen shares already published before we joined
      attachExistingRemoteScreenTracks();
      syncSharingFlagsFromLiveKit();
      // LiveKit sometimes delivers pubs a tick later
      setTimeout(() => {
        attachExistingRemoteScreenTracks();
        syncSharingFlagsFromLiveKit();
      }, 400);
      setTimeout(() => {
        attachExistingRemoteScreenTracks();
        syncSharingFlagsFromLiveKit();
      }, 1500);
    } catch (e) {
      console.error('[LiveKit] connect failed', e);
      alert('Could not connect to media server: ' + (e.message || e));
      room = null;
    }
  }

  function markParticipantSharing(identity, sharing) {
    if (!identity) return;
    const p = participants.find((x) => x.id === identity);
    if (p) {
      if (!!p.sharing !== !!sharing) {
        p.sharing = !!sharing;
        renderCards();
        renderParticipants();
      }
    } else if (sharing) {
      // Participant row may arrive via WS slightly later — keep a pending flag on remoteMedia
      if (!remoteMedia[identity]) remoteMedia[identity] = {};
      remoteMedia[identity].pendingShare = true;
    }
  }

  function syncSharingFlagsFromLiveKit() {
    if (room) {
      room.remoteParticipants.forEach((participant) => {
        let hasScreen = false;
        participant.trackPublications.forEach((publication) => {
          if (publication.source === LK.Track.Source.ScreenShare) {
            hasScreen = true;
            if (
              publication.kind === LK.Track.Kind.Video ||
              (publication.track && publication.track.kind === LK.Track.Kind.Video)
            ) {
              try {
                if (typeof publication.setSubscribed === 'function' && !publication.isSubscribed) {
                  publication.setSubscribed(true);
                }
              } catch (_) {}
            }
          }
        });
        markParticipantSharing(participant.identity, hasScreen);
      });
    }
    renderParticipants();
    renderCards();
  }

  function attachParticipantScreenTracks(participant) {
    if (!participant) return;
    participant.trackPublications.forEach((publication) => {
      if (publication.source !== LK.Track.Source.ScreenShare) return;
      markParticipantSharing(participant.identity, true);
      try {
        if (typeof publication.setSubscribed === 'function' && !publication.isSubscribed) {
          publication.setSubscribed(true);
        }
      } catch (_) {}
      if (
        publication.track &&
        publication.track.kind === LK.Track.Kind.Video
      ) {
        handleTrackSubscribed(publication.track, publication, participant);
      }
    });
  }

  function attachExistingRemoteScreenTracks() {
    if (!room) return;
    room.remoteParticipants.forEach((participant) => {
      attachParticipantScreenTracks(participant);
    });
  }

  async function disconnectLiveKit() {
    if (room) {
      try { await room.disconnect(); } catch (_) {}
      room = null;
    }
    Object.keys(remoteMedia).forEach(cleanupRemoteMedia);
    isSharing = false;
    micOn = false;
    updateShareButton();
    updateMicButton();
  }

  function handleTrackSubscribed(track, publication, participant) {
    const identity = participant.identity;
    if (!remoteMedia[identity]) remoteMedia[identity] = {};

    if (track.kind === LK.Track.Kind.Video && publication.source === LK.Track.Source.ScreenShare) {
      remoteMedia[identity].screenTrack = track;
      console.log('[LiveKit] ScreenShare TrackSubscribed', {
        identity,
        trackSid: track.sid,
        muted: track.isMuted,
        streamState: track.streamState,
        dimensions: track.dimensions,
      });
      try {
        applyViewQualityToPublication(publication);
      } catch (_) {}
      const p = participants.find(x => x.id === identity);
      if (p && !p.sharing) { p.sharing = true; renderCards(); }
      // Auto-watch if nothing selected, same sharer, or previous watch target has no active screen
      const prevHasScreen = watchingId && remoteMedia[watchingId] && remoteMedia[watchingId].screenTrack;
      const stageEmpty = !document.getElementById('lkScreenVideo') ||
        (bigPlaceholder && !bigPlaceholder.classList.contains('hidden'));
      if (!watchingId || watchingId === identity || !prevHasScreen || stageEmpty) {
        watchingId = identity;
        attachScreenToBigView(track, identity);
        renderCards();
      }
    }

    if (track.kind === LK.Track.Kind.Audio) {
      const el = track.attach();
      el.autoplay = true;
      el.style.display = 'none';
      document.body.appendChild(el);
      remoteMedia[identity].audioEl = el;
      const playP = el.play();
      if (playP && playP.catch) playP.catch(() => {});
    }
  }

  function handleTrackUnsubscribed(track, publication, participant) {
    const identity = participant.identity;
    track.detach();
    if (publication.source === LK.Track.Source.ScreenShare) {
      if (remoteMedia[identity]) delete remoteMedia[identity].screenTrack;
      if (watchingId === identity) clearBigView();
      const p = participants.find(x => x.id === identity);
      if (p) { p.sharing = false; renderCards(); }
    }
    if (track.kind === LK.Track.Kind.Audio && remoteMedia[identity]?.audioEl) {
      try { remoteMedia[identity].audioEl.remove(); } catch (_) {}
      delete remoteMedia[identity].audioEl;
    }
  }

  function cleanupRemoteMedia(identity) {
    const m = remoteMedia[identity];
    if (!m) return;
    if (m.audioEl) try { m.audioEl.remove(); } catch (_) {}
    if (m.screenTrack) try { m.screenTrack.detach(); } catch (_) {}
    delete remoteMedia[identity];
  }

  function hideContentOverlay() {
    const cv = $('contentView');
    if (cv) cv.classList.add('hidden');
    if (remoteVideo) {
      remoteVideo.style.opacity = '';
      remoteVideo.style.display = 'none';
    }
  }

  function attachScreenToBigView(track, identity) {
    hideContentOverlay();
    const existing = document.getElementById('lkScreenVideo');
    if (existing) {
      try {
        // detach any previous track from the element
        existing.remove();
      } catch (_) {}
    }
    if (remoteVideo) {
      remoteVideo.style.display = 'none';
      remoteVideo.classList.remove('active');
    }

    // Prefer attaching into a dedicated element we fully control
    const el = document.createElement('video');
    el.id = 'lkScreenVideo';
    el.autoplay = true;
    el.playsInline = true;
    // Mute the *element* initially so autoplay is allowed, then unmute after play.
    // (Browsers block unmuted autoplay; screen video itself has no audio usually.)
    el.muted = true;
    el.setAttribute('playsinline', '');
    el.setAttribute('autoplay', '');
    el.classList.add('active');
    // Fill the container so size is never 0 (avoids black frames / adaptive issues)
    el.style.cssText = [
      'position:absolute',
      'inset:0',
      'width:100%',
      'height:100%',
      'object-fit:contain',
      'display:block',
      'background:#0a0c10',
      'z-index:3',
    ].join(';');

    // Attach MediaStreamTrack(s) to our element
    track.attach(el);

    bigView?.appendChild(el);
    bigPlaceholder?.classList.add('hidden');
    if (bigViewLabel) {
      const p = participants.find(x => x.id === identity);
      bigViewLabel.textContent = p ? p.name + ' is sharing' : 'Screen share';
      bigViewLabel.classList.add('visible');
    }

    const mst = track.mediaStreamTrack;
    const stream = el.srcObject;
    console.log('[screen] attached', {
      identity,
      videoWidth: el.videoWidth,
      videoHeight: el.videoHeight,
      readyState: el.readyState,
      paused: el.paused,
      srcObjectTracks: stream ? stream.getTracks().map((t) => ({
        kind: t.kind,
        id: t.id,
        readyState: t.readyState,
        enabled: t.enabled,
        muted: t.muted,
        label: t.label,
      })) : null,
      mediaStreamTrack: mst
        ? { readyState: mst.readyState, enabled: mst.enabled, muted: mst.muted, label: mst.label }
        : null,
      trackDimensions: track.dimensions,
      trackMuted: track.isMuted,
      streamState: track.streamState,
    });

    const tryPlay = () => {
      const p = el.play();
      if (p && typeof p.catch === 'function') {
        p.then(() => {
          // Video can stay muted (screen share audio is a separate track)
          console.log('[screen] playing', { videoWidth: el.videoWidth, videoHeight: el.videoHeight });
        }).catch((err) => console.warn('[screen] video.play() blocked', err));
      }
    };
    tryPlay();
    // Safari / some Chromium builds need a second kick after layout
    requestAnimationFrame(() => {
      tryPlay();
      void el.offsetWidth;
    });
    setTimeout(() => {
      tryPlay();
      // If still 0x0 after a moment, media is not arriving (ICE/UDP/TURN problem)
      if (el.videoWidth === 0 && el.videoHeight === 0) {
        console.warn(
          '[screen] still 0x0 after attach — media frames are not arriving. ' +
          'Check LiveKit UDP ports 50000-60000, TURN, and that LIVEKIT_URL is reachable over WSS.'
        );
      }
    }, 1500);

    if (track.on) {
      try {
        const dimEvent = (LK.TrackEvent && LK.TrackEvent.DimensionsChanged) || 'dimensionsChanged';
        track.on(dimEvent, () => {
          console.log('[screen] dimensions changed', track.dimensions);
          tryPlay();
        });
      } catch (_) {}
    }
  }

  function clearBigView() {
    watchingId = null;
    try { hideContentOverlay(); } catch (_) {}
    const lkVid = document.getElementById('lkScreenVideo');
    if (lkVid) try { lkVid.remove(); } catch (_) {}
    if (remoteVideo) {
      remoteVideo.style.display = '';
      remoteVideo.style.opacity = '';
      remoteVideo.srcObject = null;
      remoteVideo.classList.remove('active');
    }
    bigPlaceholder?.classList.remove('hidden');
    if (bigViewLabel) {
      bigViewLabel.textContent = '';
      bigViewLabel.classList.remove('visible');
    }
    // restore default placeholder text
    if (bigPlaceholder) {
      const p = bigPlaceholder.querySelector('p');
      if (p) p.textContent = 'No screen selected';
    }
    renderCards();
  }

  // Sender encode presets (highest available path = high)
  const SEND_QUALITY = {
    high: {
      maxBitrate: 10_000_000,
      maxFramerate: 30,
      resolution: { width: 1920, height: 1080, frameRate: 30 },
    },
    medium: {
      maxBitrate: 4_000_000,
      maxFramerate: 24,
      resolution: { width: 1280, height: 720, frameRate: 24 },
    },
    low: {
      maxBitrate: 1_500_000,
      maxFramerate: 15,
      resolution: { width: 960, height: 540, frameRate: 15 },
    },
  };
  let sendQuality = localStorage.getItem('meet-send-quality') || 'high';
  if (!SEND_QUALITY[sendQuality]) sendQuality = 'high';
  let viewQuality = localStorage.getItem('meet-view-quality') || 'high';
  if (!['high', 'medium', 'off'].includes(viewQuality)) viewQuality = 'high';

  function getSendPreset() {
    return SEND_QUALITY[sendQuality] || SEND_QUALITY.high;
  }

  function applyViewQualityToPublication(publication) {
    if (!publication) return;
    try {
      if (viewQuality === 'off') {
        if (typeof publication.setSubscribed === 'function') publication.setSubscribed(false);
        return;
      }
      if (typeof publication.setSubscribed === 'function' && !publication.isSubscribed) {
        publication.setSubscribed(true);
      }
      if (publication.setVideoQuality && LK.VideoQuality) {
        publication.setVideoQuality(
          viewQuality === 'medium' ? LK.VideoQuality.MEDIUM : LK.VideoQuality.HIGH
        );
      }
    } catch (_) {}
  }

  function applyViewQualityAll() {
    const big = $('bigView');
    if (big) {
      big.classList.toggle('view-audio-only', viewQuality === 'off');
      if (viewQuality === 'off') {
        const ph = $('bigPlaceholder');
        if (ph) {
          ph.classList.remove('hidden');
          const p = ph.querySelector('p');
          if (p) p.textContent = 'Audio only — screen hidden';
          const sub = ph.querySelector('.sub');
          if (sub) sub.textContent = 'Sound still plays; pick High/Medium under View to show video';
        }
      }
    }
    if (!room) return;
    room.remoteParticipants.forEach((participant) => {
      participant.trackPublications.forEach((publication) => {
        if (publication.source === LK.Track.Source.ScreenShare) {
          applyViewQualityToPublication(publication);
        }
      });
    });
    // Re-attach current watch if video turned back on
    if (viewQuality !== 'off' && watchingId) {
      const m = remoteMedia[watchingId];
      if (m && m.screenTrack) attachScreenToBigView(m.screenTrack, watchingId);
    }
  }

  async function republishScreenWithQuality() {
    if (!isSharing || !room?.localParticipant) return;
    try {
      await room.localParticipant.setScreenShareEnabled(false);
    } catch (_) {}
    // brief yield so unpublish settles
    await new Promise((r) => setTimeout(r, 200));
    await startShare();
  }

  function canScreenShare() {
    try {
      if (typeof window === 'undefined') return false;
      if (!window.isSecureContext) return false;
      const md = navigator.mediaDevices;
      if (!md) return false;
      return typeof md.getDisplayMedia === 'function';
    } catch (_) {
      return false;
    }
  }

  function screenShareUnsupportedMessage() {
    const ua = (navigator.userAgent || '').toLowerCase();
    const isIOS = /iphone|ipad|ipod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (isIOS) {
      return 'Screen sharing is limited on iOS. Use Safari 17+ on a real device (not the desktop simulator), or share from a desktop browser.';
    }
    if (!window.isSecureContext) {
      return 'Screen sharing requires HTTPS (or localhost). Open the app over a secure connection and try again.';
    }
    return 'Screen sharing is not available in this browser or device mode.\n\n• Chrome DevTools device toolbar often blocks getDisplayMedia — try a real phone or desktop.\n• On Android, use up-to-date Chrome over HTTPS and allow the permission when prompted.';
  }

  async function startShare() {
    if (!room?.localParticipant) { alert('Not connected to media server yet.'); return; }
    if (!canScreenShare()) {
      alert(screenShareUnsupportedMessage());
      return;
    }
    const preset = getSendPreset();
    try {
      // motion + high bitrate keeps YouTube clearer while playing (not only when paused)
      if (typeof room.localParticipant.createScreenTracks === 'function') {
        const tracks = await room.localParticipant.createScreenTracks({
          audio: true,
          resolution: preset.resolution,
          contentHint: 'motion',
        });
        for (const track of tracks) {
          if (track.mediaStreamTrack && track.kind === 'video') {
            try { track.mediaStreamTrack.contentHint = 'motion'; } catch (_) {}
          }
          console.log('[LiveKit] publishing screen track', {
            kind: track.kind,
            sendQuality,
            maxBitrate: preset.maxBitrate,
            maxFramerate: preset.maxFramerate,
          });
          await room.localParticipant.publishTrack(track, {
            source: track.kind === 'video' ? LK.Track.Source.ScreenShare : LK.Track.Source.ScreenShareAudio,
            videoCodec: 'vp8',
            simulcast: false,
            videoEncoding: {
              maxBitrate: preset.maxBitrate,
              maxFramerate: preset.maxFramerate,
            },
            degradationPreference: 'maintain-resolution',
          });
        }
      } else {
        await room.localParticipant.setScreenShareEnabled(true, {
          audio: true,
          resolution: preset.resolution,
          contentHint: 'motion',
        });
      }
    } catch (e) {
      console.error('[LiveKit] startShare failed', e);
      const msg = String((e && (e.message || e.name)) || '');
      const denied = /NotAllowedError|Permission denied|denied|PermissionDismissed/i.test(msg);
      const unsupported = /NotSupportedError|getDisplayMedia|not supported|undefined is not/i.test(msg);
      if (unsupported || !canScreenShare()) {
        alert(screenShareUnsupportedMessage());
        return;
      }
      try {
        await room.localParticipant.setScreenShareEnabled(true, { audio: true });
      } catch (e2) {
        console.error(e2);
        const m2 = String((e2 && (e2.message || e2.name)) || msg);
        if (/NotAllowedError|Permission denied|denied/i.test(m2) || denied) {
          alert('Screen share permission was blocked.\n\nWhen the browser prompt appears, choose a screen/window and allow sharing. If you previously blocked it, reset site permissions for this origin.');
        } else if (/NotSupportedError|getDisplayMedia|not supported/i.test(m2)) {
          alert(screenShareUnsupportedMessage());
        } else {
          alert('Could not start screen share.\n' + (m2 || 'Unknown error'));
        }
      }
    }
  }

  async function stopShare() {
    if (!room?.localParticipant) return;
    try { await room.localParticipant.setScreenShareEnabled(false); } catch (e) { console.error(e); }
  }

  async function toggleMic() {
    if (!room?.localParticipant) { alert('Not connected to media server yet.'); return; }
    try {
      const next = !micOn;
      await room.localParticipant.setMicrophoneEnabled(next);
      micOn = next;
      updateMicButton();
    } catch (e) {
      console.error(e);
      alert('Could not access microphone.');
    }
  }

  function updateShareButton() {
    if (!shareBtn) return;
    const allowed = !!(myPermissions && myPermissions.screenShare !== false) ||
      myRole === 'host' || myRole === 'cohost' || !!(currentMeeting && currentMeeting.isHost);
    // Hosts/cohosts always may share; others follow meeting/role permissions
    const canShare = myRole === 'host' || myRole === 'cohost' || !!(currentMeeting && currentMeeting.isHost)
      ? true
      : !!(myPermissions && myPermissions.screenShare);
    if (!canShare && !isSharing) {
      shareBtn.classList.add('hidden');
      shareBtn.setAttribute('aria-hidden', 'true');
      return;
    }
    shareBtn.classList.remove('hidden');
    shareBtn.removeAttribute('aria-hidden');
    if (isSharing) {
      shareBtn.classList.add('sharing-active', 'sharing-state');
      shareBtn.innerHTML = '<i class="fa-solid fa-desktop"></i><span>Stop</span>';
      shareBtn.title = 'Stop sharing';
    } else {
      shareBtn.classList.remove('sharing-active', 'sharing-state');
      shareBtn.innerHTML = '<i class="fa-solid fa-desktop"></i><span>Share</span>';
      shareBtn.title = 'Share screen';
    }
  }

  function updateMicButton() {
    if (!micBtn) return;
    micBtn.classList.toggle('active', micOn);
    micBtn.classList.toggle('off', !micOn);
    micBtn.classList.toggle('muted-state', !micOn);
    micBtn.innerHTML = micOn
      ? '<i class="fa-solid fa-microphone"></i><span>Mic</span>'
      : '<i class="fa-solid fa-microphone-slash"></i><span>Mic</span>';
    micBtn.title = micOn ? 'Mute microphone (M)' : 'Unmute microphone (M)';
  }

  function getLocalScreenTrack() {
    if (!room?.localParticipant || !LK) return null;
    try {
      const pubs = room.localParticipant.trackPublications
        || room.localParticipant.tracks
        || null;
      if (pubs) {
        const list = pubs.values ? Array.from(pubs.values()) : Object.values(pubs);
        for (const pub of list) {
          if (!pub) continue;
          const src = pub.source;
          const isScreen = src === LK.Track.Source.ScreenShare
            || src === 'screen_share'
            || src === 'screenShare';
          if (isScreen && pub.track && pub.track.kind === 'video') return pub.track;
          if (isScreen && pub.videoTrack) return pub.videoTrack;
        }
      }
      // Fallback: iterate video track publications helper if present
      if (typeof room.localParticipant.getTrackPublication === 'function') {
        const pub = room.localParticipant.getTrackPublication(LK.Track.Source.ScreenShare);
        if (pub?.track) return pub.track;
      }
    } catch (e) {
      console.warn('[screen] getLocalScreenTrack', e);
    }
    return null;
  }

  async function watchParticipant(remoteId) {
    // Always re-bind so switching cards works even if same id after content overlay
    hideContentOverlay();
    const prev = document.getElementById('lkScreenVideo');
    if (prev) try { prev.remove(); } catch (_) {}
    if (remoteVideo) {
      remoteVideo.style.display = 'none';
      remoteVideo.classList.remove('active');
    }

    watchingId = remoteId;
    renderCards();

    // Self view while sharing: use local publication (not remoteMedia)
    const isSelf = currentMeeting && remoteId === currentMeeting.participantId;
    if (isSelf) {
      const localTrack = getLocalScreenTrack();
      if (localTrack) {
        attachScreenToBigView(localTrack, remoteId);
        return;
      }
      bigPlaceholder?.classList.remove('hidden');
      if (bigViewLabel) {
        bigViewLabel.textContent = 'You are sharing';
        bigViewLabel.classList.add('visible');
      }
      if (bigPlaceholder) {
        const p = bigPlaceholder.querySelector('p');
        if (p) p.textContent = 'Your screen is being shared…';
      }
      return;
    }

    const m = remoteMedia[remoteId];
    if (m?.screenTrack) {
      attachScreenToBigView(m.screenTrack, remoteId);
    } else {
      bigPlaceholder?.classList.remove('hidden');
      if (bigViewLabel) {
        bigViewLabel.textContent = '';
        bigViewLabel.classList.remove('visible');
      }
      if (bigPlaceholder) {
        const p = bigPlaceholder.querySelector('p');
        if (p) p.textContent = 'Waiting for screen…';
      }
    }
  }

  // ----- Render -----

  function deviceIcon(device) {
    if (device === 'mobile') return 'fa-mobile-screen';
    if (device === 'tablet') return 'fa-tablet-screen-button';
    return 'fa-desktop';
  }

  function detectDevice() {
    const ua = navigator.userAgent || '';
    const w = window.innerWidth || 1024;
    if (/Mobi|Android.*Mobile|iPhone|iPod/i.test(ua) || w < 600) return 'mobile';
    if (/iPad|Android(?!.*Mobile)|Tablet/i.test(ua) || (w >= 600 && w < 1024)) return 'tablet';
    return 'desktop';
  }

  let showDeviceIcons = true;
  let myRole = 'participant';
  let myPermissions = {};
  let waitingList = [];
  let raisedHands = [];
  let securityState = null;
  let handRaised = false;
  let removeTargetId = null;

  const HOST_PERMISSIONS = {
    microphone: true, camera: true, screenShare: true, chat: true, reactions: true, raiseHand: true,
    invite: true, muteOthers: true, removePeople: true, manageWaiting: true, manageRoles: true,
    manageSecurity: true, lockMeeting: true, endMeeting: true, transferHost: true, lowerHands: true, askUnmute: true,
  };

  function isHostLike() {
    if (myRole === 'host' || myRole === 'cohost') return true;
    if (currentMeeting && (currentMeeting.isHost || currentMeeting.role === 'host' || currentMeeting.role === 'cohost')) return true;
    return false;
  }

  /** Keep moderation flags alive for host/co-host even if roster omits them */
  function ensureModPermissions(fromRoster) {
    if (fromRoster && typeof fromRoster === 'object') {
      myPermissions = Object.assign({}, myPermissions || {}, fromRoster);
    }
    if (myRole === 'host' || (currentMeeting && currentMeeting.isHost && myRole !== 'cohost' && myRole !== 'participant' && myRole !== 'guest')) {
      myRole = myRole === 'cohost' ? 'cohost' : 'host';
      myPermissions = Object.assign({}, HOST_PERMISSIONS, myPermissions || {});
    } else if (myRole === 'cohost') {
      myPermissions = Object.assign({
        muteOthers: true, removePeople: true, manageWaiting: true, lowerHands: true, askUnmute: true,
        screenShare: true, chat: true, raiseHand: true, microphone: true,
      }, myPermissions || {});
    }
    return myPermissions;
  }

  function canModerateNow() {
    ensureModPermissions();
    return !!(
      myPermissions.muteOthers || myPermissions.removePeople || myPermissions.manageWaiting ||
      myPermissions.manageRoles || myPermissions.manageSecurity || myPermissions.lowerHands ||
      myRole === 'host' || myRole === 'cohost' || (currentMeeting && currentMeeting.isHost)
    );
  }



  function renderParticipants() {
    if (!participantList) return;
    participantList.innerHTML = '';
    const raisedListEl = document.getElementById('raisedHandsList');
    const waitingListEl = document.getElementById('waitingList');
    const raisedLabel = document.getElementById('raisedHandsLabel');
    const waitingLabel = document.getElementById('waitingSectionLabel');
    const waitingBanner = document.getElementById('waitingBanner');
    const waitingBannerText = document.getElementById('waitingBannerText');
    if (raisedListEl) raisedListEl.innerHTML = '';
    if (waitingListEl) waitingListEl.innerHTML = '';

    if (participantCount) participantCount.textContent = String(participants.length);

    const myId = currentMeeting?.participantId;
    const canModerate = canModerateNow();

    const searchEl = document.getElementById('peopleSearch');
    const q = (searchEl && searchEl.value ? searchEl.value : '').trim().toLowerCase();
    let listSrc = participants;
    if (q) {
      listSrc = participants.filter((p) =>
        String(p.name || '').toLowerCase().includes(q) ||
        String(p.roleLabel || p.role || '').toLowerCase().includes(q)
      );
    }

    const sorted = [...listSrc].sort((a, b) => {
      const rank = (p) => {
        if (p.role === 'host' || p.isHost) return 0;
        if (p.role === 'cohost') return 1;
        if (p.role === 'guest') return 3;
        return 2; // participant
      };
      const ra = rank(a), rb = rank(b);
      if (ra !== rb) return ra - rb;
      if (a.id === myId) return -1;
      if (b.id === myId) return 1;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });

    const appendItem = (p, parent, opts = {}) => {
      const li = document.createElement('li');
      li.className = 'participant-item';
      if (p.isHost || p.role === 'host') li.classList.add('host');
      if (p.id === myId) li.classList.add('me');
      if (p.online === false) li.style.opacity = '0.55';

      const role = p.role || (p.isHost ? 'host' : 'participant');
      const roleClass = role === 'host' ? 'host' : role === 'cohost' ? 'cohost' : role === 'guest' ? 'guest' : '';
      const roleHtml = `<span class="role-tag ${roleClass}">${escapeHtml(p.roleLabel || role)}</span>`;
      const handHtml = p.handRaised ? '<span class="hand-badge" title="Hand raised">✋</span>' : '';
      const muteTag = p.mutedByHost ? ' <span class="host-tag" title="Muted">muted</span>' : '';
      const deviceHtml = showDeviceIcons
        ? `<i class="fa-solid ${deviceIcon(p.device)} device-icon" title="${escapeHtml(p.device || 'desktop')}"></i>`
        : '';

      li.innerHTML = `
        ${deviceHtml}
        <span class="p-name">${escapeHtml(p.name)}${p.id === myId ? ' <span class="me-tag">(you)</span>' : ''}${roleHtml}${handHtml}${muteTag}</span>
        ${p.sharing ? '<span class="live-dot" title="Sharing screen" aria-label="Sharing"></span>' : ''}
      `;

      if (p.id !== myId && (canModerate || opts.waiting || isHostLike())) {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'btn icon-btn participant-more';
        more.title = 'Actions';
        more.setAttribute('aria-label', 'Participant actions');
        more.innerHTML = '<i class="fa-solid fa-ellipsis"></i>';
        const openMenu = (e) => {
          e.preventDefault();
          e.stopPropagation();
          openParticipantMenu(p, e.clientX || (e.touches && e.touches[0]?.clientX) || 40, e.clientY || (e.touches && e.touches[0]?.clientY) || 40, opts);
        };
        more.addEventListener('click', openMenu);
        more.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
        li.appendChild(more);
      }
      parent.appendChild(li);
    };

    const limit = (typeof window.__peopleRenderLimit === 'number') ? window.__peopleRenderLimit : 50;
    sorted.slice(0, limit).forEach((p) => appendItem(p, participantList));
    if (sorted.length > limit && participantList) {
      const more = document.createElement('li');
      more.className = 'participant-item people-load-more';
      more.style.justifyContent = 'center';
      more.style.opacity = '0.7';
      more.innerHTML = '<span class="p-name">Scroll for more…</span>';
      participantList.appendChild(more);
    }

    // Raised hands live only in Notifications tab — remove any leftover People UI
    if (raisedLabel) raisedLabel.classList.add('hidden');
    if (raisedListEl) raisedListEl.innerHTML = '';
    const orphanLowerAll = document.getElementById('lowerAllHandsBtn');
    if (orphanLowerAll) orphanLowerAll.remove();

    // Waiting section
    if (waitingListEl && waitingLabel) {
      if (waitingList && waitingList.length && myPermissions.manageWaiting) {
        waitingLabel.classList.remove('hidden');
        waitingLabel.textContent = `Waiting · ${waitingList.length}`;
        // Bulk actions once
        if (!document.getElementById('waitingBulkActions') && waitingListEl) {
          const bulk = document.createElement('div');
          bulk.id = 'waitingBulkActions';
          bulk.className = 'waiting-bulk';
          bulk.innerHTML = '';
          const admitAll = document.createElement('button');
          admitAll.type = 'button';
          admitAll.className = 'btn small-btn primary-outline';
          admitAll.textContent = 'Admit all';
          admitAll.addEventListener('click', () => sendWS({ type: 'admit-all' }));
          const declineAll = document.createElement('button');
          declineAll.type = 'button';
          declineAll.className = 'btn small-btn';
          declineAll.textContent = 'Decline all';
          declineAll.addEventListener('click', () => sendWS({ type: 'decline-all' }));
          bulk.appendChild(admitAll);
          bulk.appendChild(declineAll);
          waitingListEl.parentNode?.insertBefore(bulk, waitingListEl);
        }
        waitingList.forEach((p) => {
          const li = document.createElement('li');
          li.className = 'participant-item';
          li.innerHTML = `<span class="p-name">${escapeHtml(p.name)}</span>`;
          const actions = document.createElement('div');
          actions.className = 'participant-actions';
          const admit = document.createElement('button');
          admit.type = 'button';
          admit.className = 'btn small-btn primary-outline';
          admit.textContent = 'Admit';
          admit.addEventListener('click', () => sendWS({ type: 'admit-participant', targetId: p.id }));
          const decline = document.createElement('button');
          decline.type = 'button';
          decline.className = 'btn small-btn';
          decline.textContent = 'Decline';
          decline.addEventListener('click', () => sendWS({ type: 'decline-participant', targetId: p.id }));
          actions.appendChild(admit);
          actions.appendChild(decline);
          li.appendChild(actions);
          waitingListEl.appendChild(li);
        });
      } else {
        waitingLabel.classList.add('hidden');
        const bulk = document.getElementById('waitingBulkActions');
        if (bulk) bulk.remove();
      }
    }

    if (waitingBanner && waitingBannerText) {
      if (waitingList && waitingList.length && myPermissions.manageWaiting) {
        waitingBanner.classList.remove('hidden');
        waitingBannerText.textContent = `${waitingList.length} people want to join`;
      } else {
        waitingBanner.classList.add('hidden');
      }
    }

    // Security button visibility
    const secBtn = document.getElementById('securityBtn');
    if (secBtn) {
      if (myPermissions.manageSecurity || myPermissions.lockMeeting) secBtn.classList.remove('hidden');
      else secBtn.classList.add('hidden');
    }
  }

  function renderCards() {
    if (!screenCards) return;
    screenCards.innerHTML = '';

    // Only cards for people currently sharing (easy switch between live screens)
    const sharingList = participants.filter(
      (p) => p.sharing || (p.id === currentMeeting?.participantId && isSharing)
    );

    if (!sharingList.length) {
      screenCards.classList.add('empty');
      return;
    }
    screenCards.classList.remove('empty');

    const CARD_VISIBLE = 4; // one compact row; rest collapsible on small screens
    const pinned = sharingList.slice(0, CARD_VISIBLE);
    const rest = sharingList.slice(CARD_VISIBLE);

    const makeCard = (p) => {
      const card = document.createElement('div');
      card.className = 'screen-card sharing';
      if (watchingId === p.id) card.classList.add('watching', 'active');
      card.innerHTML = `
        <i class="fa-solid fa-desktop card-icon" title="Sharing screen"></i>
        <span class="card-name">${escapeHtml(p.name)}</span>
      `;
      card.addEventListener('click', () => onCardClick(p));
      return card;
    };

    const row = document.createElement('div');
    row.className = 'screen-cards-row';
    pinned.forEach((p) => row.appendChild(makeCard(p)));
    screenCards.appendChild(row);

    if (rest.length) {
      const wrap = document.createElement('div');
      wrap.className = 'screen-cards-collapse';
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'collapse-toggle cards-toggle';
      toggle.setAttribute('aria-expanded', 'false');
      toggle.innerHTML = `<i class="fa-solid fa-chevron-down"></i> <span>${rest.length} more screens</span>`;
      const extra = document.createElement('div');
      extra.className = 'screen-cards-row nested collapsed';
      rest.forEach((p) => extra.appendChild(makeCard(p)));
      toggle.addEventListener('click', () => {
        const open = extra.classList.toggle('collapsed') === false;
        toggle.setAttribute('aria-expanded', String(open));
        toggle.querySelector('span').textContent = open ? 'Show less' : `${rest.length} more screens`;
        toggle.querySelector('i')?.classList.toggle('rotated', open);
      });
      wrap.appendChild(toggle);
      wrap.appendChild(extra);
      screenCards.appendChild(wrap);
    }
  }

  async function onCardClick(p) {
    if (!currentMeeting) return;
    // Own card: if already sharing, show own screen; otherwise start share.
    if (p.id === currentMeeting.participantId) {
      const sharing = isSharing || p.sharing;
      if (sharing) {
        await watchParticipant(p.id);
        return;
      }
      await startShare();
      return;
    }
    if (!p.sharing) return;
    await watchParticipant(p.id);
  }

  // ----- Meeting lifecycle -----

  async function showMeeting(data, isHost, opts = {}) {
    const participantName = normalizeDisplayName(
      opts.participantName
      || (isHost ? createYourName?.value : joinYourName?.value)
      || displayNameOf(currentUser)
    );
    if (!isValidDisplayName(participantName)) {
      throw new Error('Please enter your display name');
    }

    currentMeeting = {
      code: data.code,
      letters: data.letters || data.code.slice(0, 3),
      numbers: data.numbers || data.code.slice(3),
      name: data.name,
      participantId: data.participantId,
      participantName,
      wsCredential: data.wsCredential || null,
      isHost: !!isHost || data.role === 'host',
      role: data.role || (isHost ? 'host' : 'participant'),
    };
    myRole = currentMeeting.role || (isHost ? 'host' : 'participant');
    myPermissions = data.permissions || {};
    if (isHost || data.role === 'host' || currentMeeting.isHost) {
      myRole = 'host';
      currentMeeting.isHost = true;
      currentMeeting.role = 'host';
    }
    ensureModPermissions(data.permissions);
    participants = data.participants || [];
    waitingList = data.waiting || [];
    raisedHands = data.raisedHands || [];
    securityState = data.security || null;
    handRaised = false;

    // Waiting room — hold until admitted
    if (data.status === 'WAITING' || data.waitingRoom) {
      saveSession(currentMeeting);
      setMeetingUrl(currentMeeting.code, !!opts.replaceUrl);
      homeView?.classList.add('hidden');
      historyView?.classList.add('hidden');
      meetingView?.classList.add('hidden');
      showWaitingRoom(data);
      connectWS();
      return;
    }

    hideWaitingRoom();
    saveSession(currentMeeting);
    setMeetingUrl(currentMeeting.code, !!opts.replaceUrl);

    homeView?.classList.add('hidden');
    historyView?.classList.add('hidden');
    meetingView?.classList.remove('hidden');
    leaveBtn?.classList.remove('hidden');
    if (meetingBadge) {
      meetingBadge.textContent = formatCode(currentMeeting.letters, currentMeeting.numbers);
      meetingBadge.classList.remove('hidden');
      meetingBadge.classList.toggle('locked', !!(securityState && securityState.locked));
    }
    copyCodeBtn?.classList.remove('hidden');
    updateMeetingChrome();

    renderParticipants();
    renderCards();
    connectWS();
    startPolling();
    await loadConfig();
    await connectLiveKit();
  }

  async function leaveMeeting() {
    if (currentMeeting) {
      try {
        await api('/api/leave', {
          method: 'POST',
          body: JSON.stringify({
            code: currentMeeting.code,
            participantId: currentMeeting.participantId,
          }),
        });
      } catch (_) {}
    }
    stopPolling();
    if (wsRetryTimer) clearTimeout(wsRetryTimer);
    if (ws) { try { ws.onclose = null; ws.close(); } catch (_) {} ws = null; }
    await disconnectLiveKit();
    clearBigView();
    currentMeeting = null;
    participants = [];
    saveSession(null);
    clearMeetingUrl(false);

    meetingView?.classList.add('hidden');
    homeView?.classList.remove('hidden');
    leaveBtn?.classList.add('hidden');
    meetingBadge?.classList.add('hidden');
    copyCodeBtn?.classList.add('hidden');
    $('meetingNameTop')?.classList.add('hidden');
    $('shareLinkBtnTop')?.classList.add('hidden');
    $('endMeetBtnTop')?.classList.add('hidden');
    if (typeof syncMoreMenuInCall === 'function') syncMoreMenuInCall();
    setWsStatus('left');
  }

  // ----- Theme / layout -----

  function initTheme() {
    const saved = localStorage.getItem('meet-theme');
    if (saved === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
    updateThemeIcon();
  }
  function updateThemeIcon() {
    if (!themeToggle) return;
    const isDark = document.documentElement.classList.contains('dark');
    themeToggle.innerHTML = isDark ? '<i class="fa-solid fa-sun"></i>' : '<i class="fa-solid fa-moon"></i>';
  }
  themeToggle?.addEventListener('click', () => {
    document.documentElement.classList.toggle('dark');
    localStorage.setItem('meet-theme', document.documentElement.classList.contains('dark') ? 'dark' : 'light');
    updateThemeIcon();
  });
  initTheme();

  fullscreenBtn?.addEventListener('click', () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
  });

    if (resizer && col1 && meetingView) {
    let dragging = false;
    resizer.addEventListener('mousedown', (e) => {
      dragging = true;
      resizer.classList.add('active');
      e.preventDefault();
    });
    window.addEventListener('mouseup', () => {
      dragging = false;
      resizer.classList.remove('active');
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const rect = meetingView.getBoundingClientRect();
      let px = e.clientX - rect.left;
      px = Math.max(220, Math.min(rect.width * 0.45, px));
      meetingView.style.gridTemplateColumns = px + 'px 5px minmax(0, 1fr)';
    });
  }


  copyCodeBtn?.addEventListener('click', async () => {
    if (!currentMeeting) return;
    try {
      const shareUrl = location.origin + meetingPath(currentMeeting.code);
      await navigator.clipboard.writeText(shareUrl);
      copyCodeBtn.innerHTML = '<i class="fa-solid fa-check"></i>';
      setTimeout(() => { copyCodeBtn.innerHTML = '<i class="fa-regular fa-copy"></i>'; }, 1500);
    } catch (_) {}
  });

  leaveBtn?.addEventListener('click', leaveMeeting);
  micBtn?.addEventListener('click', toggleMic);
  shareBtn?.addEventListener('click', async () => {
    if (isSharing) {
      await stopShare();
      return;
    }
    const canShare = myRole === 'host' || myRole === 'cohost' || !!(currentMeeting && currentMeeting.isHost)
      || !!(myPermissions && myPermissions.screenShare);
    if (!canShare) {
      showToast('Screen sharing is disabled for your role');
      return;
    }
    await startShare();
  });

  // Screen quality controls (send = encode, view = subscribe / hide video)
  (function initQualityControls() {
    var sendSel = $('sendQualitySelect');
    var viewSel = $('viewQualitySelect');
    if (sendSel) {
      sendSel.value = sendQuality;
      sendSel.addEventListener('change', async function () {
        sendQuality = sendSel.value;
        if (!SEND_QUALITY[sendQuality]) sendQuality = 'high';
        try { localStorage.setItem('meet-send-quality', sendQuality); } catch (_) {}
        if (isSharing) {
          await republishScreenWithQuality();
        }
      });
    }
    if (viewSel) {
      viewSel.value = viewQuality;
      viewSel.addEventListener('change', function () {
        viewQuality = viewSel.value;
        if (!['high', 'medium', 'off'].includes(viewQuality)) viewQuality = 'high';
        try { localStorage.setItem('meet-view-quality', viewQuality); } catch (_) {}
        applyViewQualityAll();
      });
    }
    applyViewQualityAll();
  })();


  screenFsBtn?.addEventListener('click', () => {
    if (!document.fullscreenElement) bigView?.requestFullscreen?.();
    else document.exitFullscreen?.();
  });

  // Show chat-on-screen icon only while the stage (or document) is in fullscreen
  function syncStageFullscreenChatBtn() {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    const onStage = !!(fsEl && (fsEl === bigView || (bigView && bigView.contains(fsEl)) || fsEl === document.documentElement));
    document.body.classList.toggle('stage-fullscreen', !!fsEl && onStage);
    const btn = $('chatOverlayBtn');
    if (btn && !fsEl) {
      // Leaving fullscreen: close overlay and clear pressed state
      const overlay = $('chatScreenOverlay');
      if (overlay && !overlay.classList.contains('hidden')) {
        overlay.classList.add('hidden');
        btn.setAttribute('aria-pressed', 'false');
      }
    }
  }
  document.addEventListener('fullscreenchange', syncStageFullscreenChatBtn);
  document.addEventListener('webkitfullscreenchange', syncStageFullscreenChatBtn);

  createBtn?.addEventListener('click', async () => {
    hideError(createError);
    const name = (createName?.value || '').trim();
    const yourName = normalizeDisplayName(createYourName?.value || displayNameOf(currentUser));
    if (name.length < 2) {
      showError(createError, 'Please enter a meeting name (min 2 characters)');
      return;
    }
    if (!isValidDisplayName(yourName)) {
      showError(createError, 'Please enter your display name');
      createYourName?.focus();
      return;
    }
    createBtn.disabled = true;
    try {
      const tmpl = (typeof getSelectedTemplateSettings === 'function') ? getSelectedTemplateSettings() : {};
      const adv = {
        waitingRoom: !!document.getElementById('advWaitingRoom')?.checked,
        guestAccess: document.getElementById('advGuestAccess') ? !!document.getElementById('advGuestAccess').checked : true,
        participantScreenShare: document.getElementById('advScreenShare') ? !!document.getElementById('advScreenShare').checked : true,
        participantMicrophone: document.getElementById('advMic') ? !!document.getElementById('advMic').checked : true,
        chat: document.getElementById('advChat') ? !!document.getElementById('advChat').checked : true,
        reactions: document.getElementById('advReactions') ? !!document.getElementById('advReactions').checked : true,
        requireInviteKey: !!document.getElementById('advRequireKey')?.checked,
        inviteAccess: document.getElementById('advRequireKey')?.checked ? 'approval' : 'anyone',
      };
      const data = await api('/api/create', {
        method: 'POST',
        body: JSON.stringify(Object.assign({ name, participantName: yourName, device: detectDevice() }, tmpl, adv)),
      });
      if (data.inviteToken) {
        try { sessionStorage.setItem('meet-invite-' + data.code, data.inviteToken); } catch (_) {}
        window.__lastInviteToken = data.inviteToken;
        window.__lastInviteLink = data.inviteLink;
      }
      await showMeeting(data, true, { participantName: yourName });
    } catch (e) {
      showError(createError, e.message);
    } finally {
      createBtn.disabled = false;
    }
  });

  function normalizeLetters(v) { return (v || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3); }
  function normalizeNumbers(v) { return (v || '').replace(/\D/g, '').slice(0, 3); }

  joinLetters?.addEventListener('input', () => {
    joinLetters.value = normalizeLetters(joinLetters.value);
    if (joinLetters.value.length === 3) joinNumbers?.focus();
  });
  joinNumbers?.addEventListener('input', () => {
    joinNumbers.value = normalizeNumbers(joinNumbers.value);
  });

  joinBtn?.addEventListener('click', async () => {
    hideError(joinError);
    const letters = normalizeLetters(joinLetters?.value);
    const numbers = normalizeNumbers(joinNumbers?.value);
    const yourName = normalizeDisplayName(joinYourName?.value || displayNameOf(currentUser));
    if (letters.length !== 3 || numbers.length !== 3) {
      showError(joinError, 'Enter 3 letters and 3 numbers');
      return;
    }
    if (!isValidDisplayName(yourName)) {
      showError(joinError, 'Please enter your display name');
      joinYourName?.focus();
      return;
    }
    joinBtn.disabled = true;
    try {
      const urlKey = new URLSearchParams(location.search).get('key') || undefined;
      const data = await api('/api/join', {
        method: 'POST',
        body: JSON.stringify({ letters, numbers, participantName: yourName, key: urlKey, device: detectDevice() }),
      });
      await showMeeting(data, false, { participantName: yourName });
    } catch (e) {
      showError(joinError, e.message);
    } finally {
      joinBtn.disabled = false;
    }
  });

  const nameModal = $('nameModal');
  const nameModalInput = $('nameModalInput');
  const nameModalError = $('nameModalError');
  const nameForm = $('nameForm');
  const nameModalCancel = $('nameModalCancel');
  let pendingJoin = null; // { code, participantId, isHost, resolve, reject }

  function openNameModal(prefill) {
    hideError(nameModalError);
    if (nameModalInput) {
      nameModalInput.value = isValidDisplayName(prefill) ? normalizeDisplayName(prefill) : '';
    }
    nameModal?.classList.remove('hidden');
    setTimeout(() => nameModalInput?.focus(), 50);
  }

  function closeNameModal() {
    nameModal?.classList.add('hidden');
    hideError(nameModalError);
    pendingJoin = null;
  }

  /** Prompt for display name; resolves with valid name or rejects on cancel. */
  function promptDisplayName(prefill) {
    return new Promise((resolve, reject) => {
      pendingJoin = { resolve, reject };
      openNameModal(prefill);
    });
  }

  nameForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    hideError(nameModalError);
    const name = normalizeDisplayName(nameModalInput?.value);
    if (!isValidDisplayName(name)) {
      showError(nameModalError, 'Please enter your display name (at least 2 characters)');
      nameModalInput?.focus();
      return;
    }
    const pending = pendingJoin;
    nameModal?.classList.add('hidden');
    pendingJoin = null;
    pending?.resolve(name);
  });

  nameModalCancel?.addEventListener('click', () => {
    const pending = pendingJoin;
    closeNameModal();
    pending?.reject(new Error('cancelled'));
  });

  // Backdrop does not dismiss — name is required

  async function joinWithCode(code, opts = {}) {
    const session = loadSession();
    const sameSession = session && session.code === code;
    let participantName = normalizeDisplayName(
      opts.participantName
      || (sameSession && session.participantName)
      || displayNameOf(currentUser)
    );
    const participantId = opts.participantId
      || (sameSession ? session.participantId : undefined);
    const isHost = opts.isHost != null
      ? !!opts.isHost
      : !!(sameSession && session.isHost);

    if (!isValidDisplayName(participantName)) {
      try {
        participantName = await promptDisplayName(participantName || displayNameOf(currentUser) || '');
      } catch {
        // User cancelled name prompt
        saveSession(null);
        clearMeetingUrl(true);
        return false;
      }
    }

    try {
      const body = {
        code,
        letters: code.slice(0, 3),
        numbers: code.slice(3),
        participantName,
      };
      if (participantId) body.participantId = participantId;

      const data = await api('/api/join', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      await showMeeting(data, isHost, { participantName, replaceUrl: true });
      return true;
    } catch (e) {
      saveSession(null);
      clearMeetingUrl(true);
      console.warn('[rejoin]', e.message || e);
      return false;
    }
  }

  /** Rejoin from URL (refresh or shared link). Always requires a real display name. */
  async function tryRejoinFromUrl() {
    const code = parseMeetingCodeFromPath(location.pathname);
    if (!code) return false;
    return joinWithCode(code);
  }

  window.addEventListener('popstate', async () => {
    const code = parseMeetingCodeFromPath(location.pathname);
    if (code) {
      if (currentMeeting && currentMeeting.code === code) return;
      if (currentMeeting) {
        stopPolling();
        if (wsRetryTimer) clearTimeout(wsRetryTimer);
        if (ws) { try { ws.onclose = null; ws.close(); } catch (_) {} ws = null; }
        await disconnectLiveKit();
        clearBigView();
        currentMeeting = null;
        participants = [];
      }
      await tryRejoinFromUrl();
    } else if (currentMeeting) {
      await leaveMeeting();
    }
  });

  // Do NOT leave on refresh — session + URL allow seamless rejoin when a name is known.
  // Leave only when the user clicks Leave (or navigates away via back to home).



  // Landing mock: typewriter messages inside the stage preview
  function runLandingTypewriter() {
    const lines = document.querySelectorAll('.hero-stage .type-line[data-text]');
    if (!lines.length) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      lines.forEach((el) => {
        el.textContent = el.getAttribute('data-text') || '';
        el.classList.add('done');
      });
      return;
    }

    const schedule = [400, 1600, 2900]; // when each message starts typing
    const speed = 28; // ms per character

    lines.forEach((el, i) => {
      const full = el.getAttribute('data-text') || '';
      el.textContent = '';
      const startAt = schedule[i] ?? (400 + i * 1400);
      setTimeout(() => {
        el.classList.add('typing');
        let n = 0;
        const tick = () => {
          n += 1;
          el.textContent = full.slice(0, n);
          if (n < full.length) {
            setTimeout(tick, speed);
          } else {
            el.classList.remove('typing');
            el.classList.add('done');
          }
        };
        tick();
      }, startAt);
    });
  }

  // Kick off once DOM is ready (script is at end of body)
  runLandingTypewriter();

  // =====================================================================
  // Upgrade: chat, reactions, content share, remote, schedule, devices
  // =====================================================================

  let currentContent = null;
  let localVideoObjectUrl = null;
  let pdfDoc = null;
  let pdfPageNum = 1;

  function hashHue(str) {
    var h = 0;
    var s = String(str || 'user');
    for (var i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return Math.abs(h) % 360;
  }

  function selfChatColor() {
    var key = (currentUser && (currentUser.displayName || currentUser.username || currentUser.email))
      || (currentMeeting && currentMeeting.participantName)
      || 'me';
    return 'hsl(' + hashHue(key) + ' 70% 55%)';
  }

  function applySelfChatColor() {
    var c = selfChatColor();
    document.documentElement.style.setProperty('--chat-self-color', c);
  }

  function linkifyAndMentions(text, mentions) {
    var escaped = escapeHtml(text || '');
    // URLs: http(s)://... or bare domain.tld/...
    escaped = escaped.replace(
      /(https?:\/\/[^\s<]+)|(www\.[^\s<]+)|(\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?:\/[^\s<]*)?)/gi,
      function (m) {
        var href = m;
        if (!/^https?:\/\//i.test(href)) href = 'https://' + href;
        return '<a class="chat-link" href="' + escapeHtml(href) + '" target="_blank" rel="noopener noreferrer">' + m + '</a>';
      }
    );
    // @mentions: only the @Name token (no bold bleed into following words)
    if (mentions && mentions.length) {
      mentions.forEach(function (mn) {
        var name = String(mn.name || '').trim();
        if (!name) return;
        var re = new RegExp('@' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w-])', 'gi');
        escaped = escaped.replace(re, '<span class="chat-mention">@' + escapeHtml(name) + '</span>');
      });
    } else {
      // single token only — no spaces (avoids bolding the rest of the sentence)
      escaped = escaped.replace(/@([A-Za-z0-9_.-]{1,40})/g, '<span class="chat-mention">@$1</span>');
    }
    return escaped;
  }

  function formatBytes(n) {
    if (!n || n < 1024) return (n || 0) + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function appendChatMessage(msg) {
    const box = $('chatMessages');
    if (!box) return;
    applySelfChatColor();
    const row = document.createElement('div');
    const isMe = msg.participantId === currentMeeting?.participantId;
    row.className = 'chat-msg-row' + (isMe ? ' is-me' : '');
    if (isMe) row.style.setProperty('--chat-self-color', selfChatColor());

    var who = escapeHtml(isMe ? 'You' : (msg.name || 'User'));
    var body = linkifyAndMentions(msg.text || '', msg.mentions);
    var attachHtml = '';
    if (msg.attachment) {
      var a = msg.attachment;
      if (a.kind === 'image' && a.dataUrl) {
        attachHtml =
          '<div class="chat-attach">' +
          '<img class="chat-attach-img" src="' + a.dataUrl.replace(/"/g, '') + '" alt="' + escapeHtml(a.name || 'image') + '" data-full="' + a.dataUrl.replace(/"/g, '') + '" data-name="' + escapeHtml(a.name || 'image.webp') + '">' +
          '<a class="chat-attach-file" href="' + a.dataUrl.replace(/"/g, '') + '" download="' + escapeHtml(a.name || 'image.webp') + '"><i class="fa-solid fa-download"></i> ' + escapeHtml(a.name || 'image.webp') + '</a>' +
          '</div>';
      } else if (a.kind === 'voice' && a.dataUrl) {
        attachHtml =
          '<div class="chat-voice-player" data-voice="1">' +
          '<audio controls preload="metadata" src="' + a.dataUrl.replace(/"/g, '') + '"></audio>' +
          '<div class="chat-voice-speeds">' +
          '<button type="button" data-rate="1" class="active">1x</button>' +
          '<button type="button" data-rate="1.5">1.5x</button>' +
          '<button type="button" data-rate="2">2x</button>' +
          '<button type="button" data-rate="3">3x</button>' +
          '</div></div>';
      } else if (a.dataUrl) {
        attachHtml =
          '<div class="chat-attach">' +
          '<a class="chat-attach-file" href="' + a.dataUrl.replace(/"/g, '') + '" download="' + escapeHtml(a.name || 'file') + '">' +
          '<i class="fa-solid fa-paperclip"></i> ' + escapeHtml(a.name || 'file') +
          (a.size ? ' <span>(' + formatBytes(a.size) + ')</span>' : '') +
          '</a></div>';
      } else if (a.omitted) {
        attachHtml = '<div class="chat-attach"><span class="chat-attach-file">Attachment too large for history replay</span></div>';
      }
    }

    row.innerHTML =
      '<span class="chat-who">' + who + '</span>' +
      (body ? '<div class="chat-msg-body">' + body + '</div>' : '') +
      attachHtml;

    var img = row.querySelector('.chat-attach-img');
    if (img) {
      img.addEventListener('click', function () {
        openChatImagePreview(img.getAttribute('data-full'), img.getAttribute('data-name'));
      });
    }
    var voiceWrap = row.querySelector('.chat-voice-player');
    if (voiceWrap) bindVoicePlayer(voiceWrap);

    box.appendChild(row);
    box.scrollTop = box.scrollHeight;

    // Mirror into screen overlay + PiP when fullscreen / overlay open
    mirrorChatToOverlay(row);
    if (!isMe) maybeShowChatPip(msg, who, body, msg.attachment);
  }

  function bindVoicePlayer(wrap) {
    var audio = wrap.querySelector('audio');
    if (!audio) return;
    wrap.querySelectorAll('.chat-voice-speeds button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var rate = parseFloat(btn.getAttribute('data-rate') || '1') || 1;
        audio.playbackRate = rate;
        wrap.querySelectorAll('.chat-voice-speeds button').forEach(function (b) {
          b.classList.toggle('active', b === btn);
        });
      });
    });
  }

  function isScreenFullscreen() {
    var fs = document.fullscreenElement;
    return !!(fs && (fs.id === 'bigView' || (fs.contains && fs.contains($('bigView')))));
  }

  function maybeShowChatPip(msg, whoHtml, bodyHtml, attachment) {
    if (!isScreenFullscreen()) return;
    var stack = $('chatPipStack');
    if (!stack) return;
    var pip = document.createElement('div');
    pip.className = 'chat-pip';
    var preview = '';
    if (msg.text) preview = escapeHtml(String(msg.text).slice(0, 120));
    else if (attachment && attachment.kind === 'voice') preview = '🎤 Voice note';
    else if (attachment && attachment.kind === 'image') preview = '🖼️ Image';
    else if (attachment) preview = '📎 Attachment';
    pip.innerHTML = '<div class="pip-who">' + whoHtml + '</div><div class="pip-text">' + preview + '</div>';
    pip.addEventListener('click', function () {
      openChatScreenOverlay();
      pip.remove();
    });
    stack.appendChild(pip);
    setTimeout(function () { try { pip.remove(); } catch (_) {} }, 6000);
  }

  function mirrorChatToOverlay(sourceRow) {
    var box = $('chatOverlayMessages');
    if (!box) return;
    var clone = sourceRow.cloneNode(true);
    var voice = clone.querySelector('.chat-voice-player');
    if (voice) bindVoicePlayer(voice);
    box.appendChild(clone);
    box.scrollTop = box.scrollHeight;
  }

  function openChatScreenOverlay() {
    var el = $('chatScreenOverlay');
    if (!el) return;
    el.classList.remove('hidden');
    $('chatOverlayBtn')?.setAttribute('aria-pressed', 'true');
    $('chatOverlayInput')?.focus();
  }
  function closeChatScreenOverlay() {
    var el = $('chatScreenOverlay');
    if (!el) return;
    el.classList.add('hidden');
    $('chatOverlayBtn')?.setAttribute('aria-pressed', 'false');
  }
  function toggleChatScreenOverlay() {
    var el = $('chatScreenOverlay');
    if (!el) return;
    if (el.classList.contains('hidden')) openChatScreenOverlay();
    else closeChatScreenOverlay();
  }

  function openChatImagePreview(src, name) {
    var overlay = $('chatPreviewOverlay');
    var img = $('chatPreviewImg');
    var dl = $('chatPreviewDownload');
    if (!overlay || !img) return;
    img.src = src || '';
    if (dl) {
      dl.href = src || '#';
      dl.setAttribute('download', name || 'image.webp');
    }
    overlay.classList.remove('hidden');
    overlay.setAttribute('aria-hidden', 'false');
  }

  function closeChatImagePreview() {
    var overlay = $('chatPreviewOverlay');
    if (!overlay) return;
    overlay.classList.add('hidden');
    overlay.setAttribute('aria-hidden', 'true');
    var img = $('chatPreviewImg');
    if (img) img.src = '';
  }

  function compressImageToWebp(file, maxEdge, quality) {
    maxEdge = maxEdge || 720;
    quality = quality || 0.82;
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth || img.width;
        var h = img.naturalHeight || img.height;
        var scale = Math.min(1, maxEdge / Math.max(w, h));
        var cw = Math.max(1, Math.round(w * scale));
        var ch = Math.max(1, Math.round(h * scale));
        var canvas = document.createElement('canvas');
        canvas.width = cw;
        canvas.height = ch;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, cw, ch);
        URL.revokeObjectURL(url);
        canvas.toBlob(
          function (blob) {
            if (!blob) return reject(new Error('Could not compress image'));
            var reader = new FileReader();
            reader.onload = function () {
              resolve({
                dataUrl: reader.result,
                mime: 'image/webp',
                name: (file.name || 'image').replace(/\.[^.]+$/, '') + '.webp',
                size: blob.size,
              });
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          },
          'image/webp',
          quality
        );
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('Invalid image'));
      };
      img.src = url;
    });
  }

  function readFileAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        resolve(reader.result);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function extractMentionsFromText(text) {
    var found = [];
    var re = /@([A-Za-z0-9_.\- ]{1,40})/g;
    var m;
    while ((m = re.exec(text))) {
      var name = m[1].trim();
      var p = participants.find(function (x) {
        return x.name && x.name.toLowerCase() === name.toLowerCase();
      });
      if (p) found.push({ id: p.id, name: p.name });
      else found.push({ id: '', name: name });
    }
    return found;
  }

  function sendChatPayload(text, attachment) {
    text = (text || '').trim();
    if (!text && !attachment) return;
    var mentions = extractMentionsFromText(text);
    sendWS({
      type: 'chat',
      text: text,
      mentions: mentions,
      attachment: attachment || null,
    });
  }

  function showReaction(msg) {
    const overlay = $('reactionOverlay');
    if (!overlay) return;
    const el = document.createElement('div');
    el.className = 'flying-reaction';
    el.textContent = msg.emoji || '👍';
    el.style.left = (20 + Math.random() * 60) + '%';
    overlay.appendChild(el);
    setTimeout(function () { el.remove(); }, 2100);
  }

  async function forceMuteLocal(msg) {
    try {
      if (room && room.localParticipant) {
        await room.localParticipant.setMicrophoneEnabled(false);
      }
      micOn = false;
      if (typeof updateMicButton === 'function') updateMicButton();
    } catch (e) { console.warn(e); }
    var who = msg.byName ? (' by ' + msg.byName) : '';
    var el = $('liveStatusText');
    if (el) el.textContent = 'Mic muted' + who;
  }

  function openContentModal(mode) {
    var modal = $('contentModal');
    if (!modal) return;
    modal.classList.remove('hidden');
    modal.dataset.mode = mode;
    var title = $('contentModalTitle');
    var urlInput = $('contentUrlInput');
    var fileArea = $('filePickArea');
    var err = $('contentModalError');
    if (err) err.classList.add('hidden');
    var urlLabel = document.querySelector('label[for="contentUrlInput"]');
    if (mode === 'url') {
      if (title) title.textContent = 'Browse a URL together';
      if (urlInput) { urlInput.classList.remove('hidden'); urlInput.required = true; }
      if (urlLabel) urlLabel.classList.remove('hidden');
      if (fileArea) fileArea.classList.add('hidden');
    } else if (mode === 'file') {
      if (title) title.textContent = 'Share a document';
      if (urlInput) { urlInput.classList.add('hidden'); urlInput.required = false; }
      if (urlLabel) urlLabel.classList.add('hidden');
      if (fileArea) fileArea.classList.remove('hidden');
      if ($('fileInput')) $('fileInput').accept = '.pdf,.csv,.xlsx,.xls,.pptx,.ppt,.doc,.docx,image/*';
    } else {
      if (title) title.textContent = 'Share a local movie';
      if (urlInput) { urlInput.classList.add('hidden'); urlInput.required = false; }
      if (urlLabel) urlLabel.classList.add('hidden');
      if (fileArea) fileArea.classList.remove('hidden');
      if ($('fileInput')) $('fileInput').accept = 'video/*';
    }
  }

  function closeContentModal() {
    var m = $('contentModal');
    if (m) m.classList.add('hidden');
  }

  if ($('contentModalClose')) $('contentModalClose').addEventListener('click', closeContentModal);
  if ($('contentModalBackdrop')) $('contentModalBackdrop').addEventListener('click', closeContentModal);
  if ($('browseUrlBtn')) $('browseUrlBtn').addEventListener('click', function () { openContentModal('url'); });
  if ($('shareFileBtn')) $('shareFileBtn').addEventListener('click', function () { openContentModal('file'); });
  if ($('shareVideoBtn')) $('shareVideoBtn').addEventListener('click', function () { openContentModal('video'); });

  if ($('contentForm')) $('contentForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var mode = ($('contentModal') && $('contentModal').dataset.mode) || 'url';
    var title = (($('contentTitleInput') && $('contentTitleInput').value) || '').trim();
    var uniform = !!($('contentUniformScroll') && $('contentUniformScroll').checked);
    var err = $('contentModalError');
    if (mode === 'url') {
      var url = (($('contentUrlInput') && $('contentUrlInput').value) || '').trim();
      if (!url) { if (err) { err.textContent = 'Enter a URL'; err.classList.remove('hidden'); } return; }
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      sendWS({ type: 'content-start', contentType: 'url', title: title || url, url: url, scrollMode: uniform ? 'uniform' : 'free' });
      closeContentModal();
      return;
    }
    var file = $('fileInput') && $('fileInput').files && $('fileInput').files[0];
    if (!file) { if (err) { err.textContent = 'Choose a file'; err.classList.remove('hidden'); } return; }
    if (mode === 'video' || (file.type && file.type.indexOf('video/') === 0)) {
      await startLocalVideoShare(file, title || file.name, uniform);
      closeContentModal();
      return;
    }
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      await startPdfShare(file, title || file.name, uniform);
      closeContentModal();
      return;
    }
    if ((file.type && file.type.indexOf('image/') === 0) || /\.(png|jpe?g|gif|webp|svg)$/i.test(file.name)) {
      var ireader = new FileReader();
      ireader.onload = function () {
        sendWS({
          type: 'content-start',
          contentType: 'image',
          title: title || file.name,
          scrollMode: uniform ? 'uniform' : 'free',
          fileMeta: { name: file.name, size: file.size, mime: file.type || 'image/*', dataUrl: ireader.result }
        });
        closeContentModal();
      };
      ireader.readAsDataURL(file);
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      var dataUrl = reader.result;
      if (typeof dataUrl === 'string' && dataUrl.length > 2000000) dataUrl = dataUrl.slice(0, 2000000);
      sendWS({
        type: 'content-start',
        contentType: 'file',
        title: title || file.name,
        scrollMode: uniform ? 'uniform' : 'free',
        fileMeta: { name: file.name, size: file.size, mime: file.type, dataUrl: dataUrl }
      });
      closeContentModal();
    };
    reader.readAsDataURL(file);
  });

  async function startLocalVideoShare(file, title, uniform) {
    if (localVideoObjectUrl) URL.revokeObjectURL(localVideoObjectUrl);
    localVideoObjectUrl = URL.createObjectURL(file);
    var vid = $('localMediaVideo');
    if (vid) {
      vid.src = localVideoObjectUrl;
      vid.classList.remove('hidden');
      try { await vid.play(); } catch (_) {}
    }
    try {
      if (room && room.localParticipant && vid && vid.captureStream) {
        var stream = vid.captureStream();
        var vTrack = stream.getVideoTracks()[0];
        if (vTrack) {
          // Publish as ScreenShare so existing subscribers attach it to the main stage
          await room.localParticipant.publishTrack(vTrack, {
            name: 'local-movie',
            source: LK.Track.Source.ScreenShare,
          });
          isSharing = true;
          if (typeof updateShareButton === 'function') updateShareButton();
          sendWS({ type: 'start-share' });
          // Owner also sees local element; others get the LiveKit track
          if (typeof watchParticipant === 'function' && currentMeeting) {
            watchingId = null;
            watchParticipant(currentMeeting.participantId);
          }
        }
      }
    } catch (e) { console.warn('local video publish', e); }
    sendWS({
      type: 'content-start',
      contentType: 'local-video',
      title: title,
      scrollMode: uniform ? 'uniform' : 'free',
      media: { playing: true, currentTime: 0 },
      fileMeta: { name: file.name, size: file.size, mime: file.type }
    });
  }

  async function startPdfShare(file, title, uniform) {
    var buf = await file.arrayBuffer();
    try {
      await window.pdfjsLibReady;
      if (!window.pdfjsLib) throw new Error('PDF.js not loaded');
      pdfDoc = await window.pdfjsLib.getDocument({ data: buf }).promise;
      pdfPageNum = 1;
      await renderPdfPage(1);
      if (localVideoObjectUrl) URL.revokeObjectURL(localVideoObjectUrl);
      localVideoObjectUrl = URL.createObjectURL(file);
      sendWS({
        type: 'content-start',
        contentType: 'pdf',
        title: title,
        scrollMode: uniform ? 'uniform' : 'free',
        page: 1,
        fileMeta: { name: file.name, size: file.size, mime: 'application/pdf' }
      });
    } catch (e) {
      alert('Could not open PDF: ' + (e.message || e));
    }
  }

  async function renderPdfPage(num) {
    if (!pdfDoc) return;
    pdfPageNum = Math.max(1, Math.min(num, pdfDoc.numPages));
    var page = await pdfDoc.getPage(pdfPageNum);
    var canvas = $('pdfCanvas');
    var wrap = $('pdfCanvasWrap');
    if (!canvas || !wrap) return;
    wrap.classList.remove('hidden');
    var viewport = page.getViewport({ scale: 1.4 });
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: viewport }).promise;
    var pdfLabel = $('pdfPageLabel');
    if (pdfLabel && pdfDoc) pdfLabel.textContent = pdfPageNum + ' / ' + pdfDoc.numPages;
  }

  function applyContentState(content) {
    currentContent = content;
    var view = $('contentView');
    var placeholder = $('bigPlaceholder');
    var remoteVideo = $('remoteVideo');
    if (!content) {
      if (view) view.classList.add('hidden');
      updateContentToolbar();
      return;
    }
    if (view) view.classList.remove('hidden');
    if (placeholder) placeholder.classList.add('hidden');
    if (remoteVideo) remoteVideo.style.opacity = '0';
    var frame = $('contentFrame');
    var fallback = $('contentFrameFallback');
    var pdfWrap = $('pdfCanvasWrap');
    var localVid = $('localMediaVideo');
    var imgEl = $('contentImage');
    if (frame) frame.classList.add('hidden');
    if (fallback) fallback.classList.add('hidden');
    if (pdfWrap) pdfWrap.classList.add('hidden');
    if (imgEl) imgEl.classList.add('hidden');
    if (localVid && content.type !== 'local-video') localVid.classList.add('hidden');

    if (content.type === 'url' && content.url) {
      if (frame) {
        frame.classList.remove('hidden');
        // Detect blocked embeds after load
        frame.onload = function () {
          try {
            // Same-origin only; cross-origin throws — treat empty as possible block
            var doc = frame.contentDocument;
            if (doc && (!doc.body || !doc.body.innerHTML)) showUrlFallback(content.url);
          } catch (e) {
            // Cross-origin: cannot inspect; many sites still refuse and show blank
            setTimeout(function () {
              // Heuristic: if still about:blank-ish user will use fallback button
            }, 800);
          }
        };
        if (frame.src !== content.url) frame.src = content.url;
      }
      var ext = $('contentOpenExternal');
      if (ext) ext.href = content.url;
      // Always offer external open in toolbar context via fallback toggle button
    } else if (content.type === 'pdf') {
      if (pdfWrap) pdfWrap.classList.remove('hidden');
      if (content.page && content.page !== pdfPageNum && pdfDoc) renderPdfPage(content.page);
    } else if (content.type === 'image' || (content.type === 'file' && content.fileMeta && /^image\//.test(content.fileMeta.mime || ''))) {
      if (imgEl && content.fileMeta && content.fileMeta.dataUrl) {
        imgEl.src = content.fileMeta.dataUrl;
        imgEl.classList.remove('hidden');
      }
    } else if (content.type === 'local-video') {
      // Owner: local element with controls. Others: LiveKit screen track on big view.
      if (content.ownerId === (currentMeeting && currentMeeting.participantId) && localVid) {
        localVid.classList.remove('hidden');
      }
    } else if (content.type === 'file') {
      // Downloadable only — show fallback message in toolbar title
    }
    updateContentToolbar();
  }

  function showUrlFallback(url) {
    var frame = $('contentFrame');
    var fallback = $('contentFrameFallback');
    if (frame) frame.classList.add('hidden');
    if (fallback) fallback.classList.remove('hidden');
    var ext = $('contentOpenExternal');
    if (ext && url) ext.href = url;
  }

  function applyContentUpdate(content, from) {
    if (!content) return;
    currentContent = content;
    if (content.type === 'pdf' && content.page != null && from !== currentMeeting?.participantId && content.scrollMode === 'uniform') {
      renderPdfPage(content.page);
    }
    if (content.type === 'local-video' && content.media && from !== currentMeeting?.participantId) {
      var vid = $('localMediaVideo');
      if (vid && content.ownerId === currentMeeting?.participantId) {
        if (typeof content.media.currentTime === 'number' && Math.abs(vid.currentTime - content.media.currentTime) > 1.5) {
          vid.currentTime = content.media.currentTime;
        }
        if (content.media.playing === false) vid.pause();
        else if (content.media.playing) vid.play().catch(function () {});
      }
    }
    updateContentToolbar();
  }

  function updateContentToolbar() {
    var c = currentContent;
    var title = $('contentTitle');
    var remoteBadge = $('remoteBadge');
    var claimBtn = $('claimRemoteBtn');
    var handoffBtn = $('handoffRemoteBtn');
    var scrollSel = $('scrollModeSelect');
    var dlBtn = $('downloadContentBtn');
    var stopBtn = $('stopContentBtn');
    var myId = currentMeeting && currentMeeting.participantId;
    if (!c) {
      [remoteBadge, claimBtn, handoffBtn, scrollSel, dlBtn, stopBtn].forEach(function (el) { if (el) el.classList.add('hidden'); });
      if (title) title.textContent = '';
      return;
    }
    if (title) title.textContent = c.title || 'Shared content';
    var isHolder = c.remoteHolderId === myId;
    var isOwner = c.ownerId === myId;
    if (remoteBadge) remoteBadge.classList.toggle('hidden', !isHolder);
    if (claimBtn) claimBtn.classList.toggle('hidden', !!isHolder);
    if (handoffBtn) handoffBtn.classList.toggle('hidden', !(isHolder || isOwner));
    if (scrollSel) {
      scrollSel.classList.toggle('hidden', !(isHolder || isOwner));
      scrollSel.value = c.scrollMode || 'uniform';
    }
    var isHost = !!(participants.find(function (p) { return p.id === myId; }) || {}).isHost;
    if (stopBtn) stopBtn.classList.toggle('hidden', !(isOwner || isHost));
    if (dlBtn) dlBtn.classList.toggle('hidden', !(c.fileMeta && c.type !== 'local-video'));
    var isPdf = c.type === 'pdf';
    var pdfPrev = $('pdfPrevBtn');
    var pdfNext = $('pdfNextBtn');
    var pdfLabel = $('pdfPageLabel');
    if (pdfPrev) pdfPrev.classList.toggle('hidden', !isPdf);
    if (pdfNext) pdfNext.classList.toggle('hidden', !isPdf);
    if (pdfLabel) {
      pdfLabel.classList.toggle('hidden', !isPdf);
      if (isPdf && pdfDoc) pdfLabel.textContent = pdfPageNum + ' / ' + pdfDoc.numPages;
      else if (isPdf) pdfLabel.textContent = (c.page || 1) + '';
    }
  }

  if ($('claimRemoteBtn')) $('claimRemoteBtn').addEventListener('click', function () { sendWS({ type: 'remote-claim' }); });
  if ($('stopContentBtn')) $('stopContentBtn').addEventListener('click', function () { sendWS({ type: 'content-stop' }); });
  if ($('scrollModeSelect')) $('scrollModeSelect').addEventListener('change', function (e) {
    sendWS({ type: 'content-update', scrollMode: e.target.value });
  });
  if ($('downloadContentBtn')) $('downloadContentBtn').addEventListener('click', function () {
    var meta = currentContent && currentContent.fileMeta;
    if (!meta) return;
    if (meta.dataUrl) {
      var a = document.createElement('a');
      a.href = meta.dataUrl;
      a.download = meta.name || 'download';
      a.click();
    } else if (localVideoObjectUrl) {
      var a2 = document.createElement('a');
      a2.href = localVideoObjectUrl;
      a2.download = meta.name || 'download';
      a2.click();
    }
  });

  if ($('handoffRemoteBtn')) $('handoffRemoteBtn').addEventListener('click', function () {
    var modal = $('handoffModal');
    var list = $('handoffList');
    if (!modal || !list) return;
    list.innerHTML = '';
    participants.forEach(function (p) {
      if (p.id === currentMeeting?.participantId) return;
      var li = document.createElement('li');
      li.innerHTML = '<i class="fa-solid ' + deviceIcon(p.device) + '"></i> ' + escapeHtml(p.name) + (p.isHost ? ' (Host)' : '');
      li.addEventListener('click', function () {
        sendWS({ type: 'remote-handoff', targetId: p.id });
        modal.classList.add('hidden');
      });
      list.appendChild(li);
    });
    var keep = document.createElement('li');
    keep.innerHTML = '<i class="fa-solid fa-rotate-left"></i> Keep / reclaim as owner';
    keep.addEventListener('click', function () {
      sendWS({ type: 'remote-handoff', targetId: currentContent && currentContent.ownerId });
      modal.classList.add('hidden');
    });
    list.appendChild(keep);
    modal.classList.remove('hidden');
  });
  if ($('handoffModalClose')) $('handoffModalClose').addEventListener('click', function () { $('handoffModal').classList.add('hidden'); });
  if ($('handoffModalBackdrop')) $('handoffModalBackdrop').addEventListener('click', function () { $('handoffModal').classList.add('hidden'); });

  if ($('chatForm')) $('chatForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var input = $('chatInput');
    var text = (input && input.value || '').trim();
    if (!text) return;
    sendChatPayload(text, null);
    if (input) input.value = '';
    hideMentionMenu();
  });

  // --- @mention autocomplete ---
  var mentionActiveIndex = 0;
  function hideMentionMenu() {
    var menu = $('mentionMenu');
    if (menu) menu.classList.add('hidden');
  }
  function showMentionMenu(filter) {
    var menu = $('mentionMenu');
    if (!menu) return;
    var q = (filter || '').toLowerCase();
    var list = (participants || []).filter(function (p) {
      if (!p.name) return false;
      if (currentMeeting && p.id === currentMeeting.participantId) return false;
      return !q || p.name.toLowerCase().indexOf(q) === 0 || p.name.toLowerCase().indexOf(q) >= 0;
    }).slice(0, 8);
    if (!list.length) {
      menu.classList.add('hidden');
      return;
    }
    mentionActiveIndex = 0;
    menu.innerHTML = list.map(function (p, i) {
      return '<div class="mention-item' + (i === 0 ? ' active' : '') + '" data-name="' + escapeHtml(p.name) + '" role="option">' + escapeHtml(p.name) + '</div>';
    }).join('');
    menu.classList.remove('hidden');
    menu.querySelectorAll('.mention-item').forEach(function (el) {
      el.addEventListener('mousedown', function (ev) {
        ev.preventDefault();
        insertMention(el.getAttribute('data-name'));
      });
    });
  }
  function insertMention(name) {
    var input = $('chatInput');
    if (!input || !name) return;
    var v = input.value || '';
    var caret = input.selectionStart != null ? input.selectionStart : v.length;
    var before = v.slice(0, caret);
    var after = v.slice(caret);
    var at = before.lastIndexOf('@');
    if (at < 0) return;
    var next = before.slice(0, at) + '@' + name + ' ' + after;
    input.value = next;
    var pos = at + name.length + 2;
    input.setSelectionRange(pos, pos);
    input.focus();
    hideMentionMenu();
  }
  if ($('chatInput')) {
    $('chatInput').addEventListener('input', function () {
      var input = $('chatInput');
      var v = input.value || '';
      var caret = input.selectionStart != null ? input.selectionStart : v.length;
      var before = v.slice(0, caret);
      var m = before.match(/@([A-Za-z0-9_.\-]*)$/);
      if (m) showMentionMenu(m[1] || '');
      else hideMentionMenu();
    });
    $('chatInput').addEventListener('keydown', function (e) {
      var menu = $('mentionMenu');
      if (!menu || menu.classList.contains('hidden')) return;
      var items = menu.querySelectorAll('.mention-item');
      if (!items.length) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        mentionActiveIndex = (mentionActiveIndex + 1) % items.length;
        items.forEach(function (el, i) { el.classList.toggle('active', i === mentionActiveIndex); });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        mentionActiveIndex = (mentionActiveIndex - 1 + items.length) % items.length;
        items.forEach(function (el, i) { el.classList.toggle('active', i === mentionActiveIndex); });
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        var active = items[mentionActiveIndex];
        if (active) {
          e.preventDefault();
          insertMention(active.getAttribute('data-name'));
        }
      } else if (e.key === 'Escape') {
        hideMentionMenu();
      }
    });
  }

  // Image (compressed webp 720) vs file attachment (original)
  if ($('chatImageBtn') && $('chatImageInput')) {
    $('chatImageBtn').addEventListener('click', function () { $('chatImageInput').click(); });
    $('chatImageInput').addEventListener('change', async function () {
      var file = $('chatImageInput').files && $('chatImageInput').files[0];
      $('chatImageInput').value = '';
      if (!file) return;
      try {
        var compressed = await compressImageToWebp(file, 720, 0.82);
        if (compressed.dataUrl.length > 900000) {
          alert('Image still too large after compression. Try a smaller picture.');
          return;
        }
        var caption = ($('chatInput') && $('chatInput').value || '').trim();
        sendChatPayload(caption, {
          kind: 'image',
          name: compressed.name,
          mime: compressed.mime,
          size: compressed.size,
          dataUrl: compressed.dataUrl,
        });
        if ($('chatInput')) $('chatInput').value = '';
      } catch (err) {
        alert(err.message || 'Could not process image');
      }
    });
  }
  if ($('chatAttachBtn') && $('chatFileInput')) {
    $('chatAttachBtn').addEventListener('click', function () { $('chatFileInput').click(); });
    $('chatFileInput').addEventListener('change', async function () {
      var file = $('chatFileInput').files && $('chatFileInput').files[0];
      $('chatFileInput').value = '';
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) {
        alert('Attachments are limited to 2 MB over chat. Use a link for larger files.');
        return;
      }
      try {
        var dataUrl = await readFileAsDataUrl(file);
        if (dataUrl.length > 2800000) {
          alert('File too large to send in chat (max ~2 MB).');
          return;
        }
        var caption = ($('chatInput') && $('chatInput').value || '').trim();
        sendChatPayload(caption, {
          kind: 'file',
          name: file.name,
          mime: file.type || 'application/octet-stream',
          size: file.size,
          dataUrl: dataUrl,
        });
        if ($('chatInput')) $('chatInput').value = '';
      } catch (err) {
        alert(err.message || 'Could not read file');
      }
    });
  }
  if ($('chatPreviewClose')) $('chatPreviewClose').addEventListener('click', closeChatImagePreview);

  // Voice notes
  var voiceRecorder = null;
  var voiceChunks = [];
  var voiceStream = null;
  var voiceRecording = false;

  async function toggleVoiceNote() {
    if (voiceRecording) {
      stopVoiceNote();
      return;
    }
    try {
      voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      voiceChunks = [];
      var mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');
      voiceRecorder = mime ? new MediaRecorder(voiceStream, { mimeType: mime }) : new MediaRecorder(voiceStream);
      voiceRecorder.ondataavailable = function (ev) {
        if (ev.data && ev.data.size) voiceChunks.push(ev.data);
      };
      voiceRecorder.onstop = async function () {
        try {
          var blob = new Blob(voiceChunks, { type: voiceRecorder.mimeType || 'audio/webm' });
          if (blob.size > 2 * 1024 * 1024) {
            alert('Voice note too long (max ~2 MB). Keep it shorter.');
            return;
          }
          var dataUrl = await readFileAsDataUrl(blob);
          if (dataUrl.length > 2800000) {
            alert('Voice note too large to send.');
            return;
          }
          sendChatPayload('', {
            kind: 'voice',
            name: 'voice-note.webm',
            mime: blob.type || 'audio/webm',
            size: blob.size,
            dataUrl: dataUrl,
          });
        } catch (e) {
          alert(e.message || 'Could not send voice note');
        } finally {
          if (voiceStream) voiceStream.getTracks().forEach(function (tr) { tr.stop(); });
          voiceStream = null;
        }
      };
      voiceRecorder.start();
      voiceRecording = true;
      var btn = $('chatVoiceBtn');
      if (btn) btn.classList.add('recording');
      var st = $('chatVoiceStatus');
      if (st) {
        st.textContent = 'Recording… tap mic to send';
        st.classList.remove('hidden');
        st.classList.add('recording');
      }
    } catch (e) {
      alert('Microphone permission needed for voice notes.');
    }
  }
  function stopVoiceNote() {
    voiceRecording = false;
    var btn = $('chatVoiceBtn');
    if (btn) btn.classList.remove('recording');
    var st = $('chatVoiceStatus');
    if (st) {
      st.classList.add('hidden');
      st.classList.remove('recording');
      st.textContent = '';
    }
    if (voiceRecorder && voiceRecorder.state !== 'inactive') {
      try { voiceRecorder.stop(); } catch (_) {}
    } else if (voiceStream) {
      voiceStream.getTracks().forEach(function (tr) { tr.stop(); });
      voiceStream = null;
    }
  }
  if ($('chatVoiceBtn')) $('chatVoiceBtn').addEventListener('click', toggleVoiceNote);

  // Screen chat overlay + shortcut C
  if ($('chatOverlayBtn')) $('chatOverlayBtn').addEventListener('click', toggleChatScreenOverlay);
  if ($('chatOverlayClose')) $('chatOverlayClose').addEventListener('click', closeChatScreenOverlay);
  if ($('chatOverlayForm')) {
    $('chatOverlayForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var input = $('chatOverlayInput');
      var text = (input && input.value || '').trim();
      if (!text) return;
      sendChatPayload(text, null);
      if (input) input.value = '';
    });
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'c' || e.key === 'C') {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable)) return;
      if (!$('meetingView') || $('meetingView').classList.contains('hidden')) return;
      e.preventDefault();
      toggleChatScreenOverlay();
    }
    if (e.key === 'Escape') closeChatScreenOverlay();
  });

  if ($('chatPreviewBackdrop')) $('chatPreviewBackdrop').addEventListener('click', closeChatImagePreview);

  // Apply self color when auth / meeting ready
  try { applySelfChatColor(); } catch (_) {}

  document.querySelectorAll('.emoji-btn').forEach(function (btn) {
    if (btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', function () {
      var emoji = btn.getAttribute('data-emoji');
      if (emoji) sendWS({ type: 'reaction', emoji: emoji });
    });
  });

  if ($('deviceToggle')) $('deviceToggle').addEventListener('click', function () {
    showDeviceIcons = !showDeviceIcons;
    $('deviceToggle').setAttribute('aria-pressed', String(showDeviceIcons));
    renderParticipants();
  });

  function updateMeetingChrome() {
    var nameEl = $('meetingNameLabel');
    var nameTop = $('meetingNameTop');
    var name = (currentMeeting && currentMeeting.name) || 'Meeting';
    if (nameEl) nameEl.textContent = name;
    if (nameTop) {
      nameTop.textContent = name;
      nameTop.classList.toggle('hidden', !currentMeeting);
    }
    var myId = currentMeeting && currentMeeting.participantId;
    var isHost = !!(currentMeeting && currentMeeting.isHost) || !!(participants.find(function (p) { return p.id === myId; }) || {}).isHost;
    var endBtn = $('endMeetBtn');
    var endTop = $('endMeetBtnTop');
    if (endBtn) endBtn.classList.toggle('hidden', !isHost);
    if (endTop) endTop.classList.toggle('hidden', !isHost || !currentMeeting);
    var shareTop = $('shareLinkBtnTop');
    if (shareTop) shareTop.classList.toggle('hidden', !currentMeeting);
    if (typeof syncMoreMenuInCall === 'function') syncMoreMenuInCall();
  }

  async function copyInviteLink() {
    if (!currentMeeting || !currentMeeting.code) return;
    var url = location.origin + meetingPath(currentMeeting.code);
    try { await navigator.clipboard.writeText(url); var t = $('liveStatusText'); if (t) t.textContent = 'Link copied'; }
    catch (e) { prompt('Copy invite link:', url); }
  }
  function endMeetingConfirm() {
    if (!confirm('End the meeting for everyone?')) return;
    sendWS({ type: 'end-meeting' });
  }

  if ($('shareLinkBtn')) $('shareLinkBtn').addEventListener('click', copyInviteLink);
  if ($('shareLinkBtnTop')) $('shareLinkBtnTop').addEventListener('click', copyInviteLink);
  if ($('endMeetBtn')) $('endMeetBtn').addEventListener('click', endMeetingConfirm);
  if ($('endMeetBtnTop')) $('endMeetBtnTop').addEventListener('click', endMeetingConfirm);

  if ($('meetingView')) {
    new MutationObserver(function () {
      if (!$('meetingView').classList.contains('hidden') && currentMeeting) {
        updateMeetingChrome();
        sendWS({ type: 'device', device: detectDevice() });
      }
    }).observe($('meetingView'), { attributes: true, attributeFilter: ['class'] });
  }

  document.querySelectorAll('.history-tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      document.querySelectorAll('.history-tab').forEach(function (t) { t.classList.remove('active'); });
      tab.classList.add('active');
      var which = tab.getAttribute('data-tab');
      if ($('pastTab')) $('pastTab').classList.toggle('hidden', which !== 'past');
      if ($('scheduledTab')) $('scheduledTab').classList.toggle('hidden', which !== 'scheduled');
      if (which === 'scheduled') loadScheduled();
    });
  });

  async function loadScheduled() {
    if (!authToken) return;
    try {
      var res = await fetch('/api/schedule', { headers: { Authorization: 'Bearer ' + authToken } });
      var data = await res.json();
      var list = $('scheduledList');
      var empty = $('scheduledEmpty');
      if (!list) return;
      list.innerHTML = '';
      var meetings = data.meetings || [];
      if (empty) empty.classList.toggle('hidden', meetings.length > 0);
      meetings.forEach(function (m) {
        var li = document.createElement('li');
        li.className = 'history-item';
        var start = m.scheduledStart ? new Date(m.scheduledStart).toLocaleString() : '';
        var codeFmt = m.code ? (m.code.slice(0, 3) + '-' + m.code.slice(3)) : '';
        li.innerHTML = '<div><strong>' + escapeHtml(m.name) + '</strong> <span class="status-pill ' + escapeHtml(m.status) + '">' + escapeHtml(m.status) + '</span>' +
          (m.isLive ? ' <span class="status-pill live">in room</span>' : '') + '</div>' +
          '<div class="history-meta">' + escapeHtml(start) + ' · ' + escapeHtml(codeFmt) + '</div>' +
          '<div class="scheduled-item-actions">' +
          '<button type="button" class="btn small-btn primary-btn" data-start="' + m.id + '">Start</button>' +
          '<button type="button" class="btn small-btn" data-copy="' + escapeHtml(m.link || '') + '">Copy link</button>' +
          '<button type="button" class="btn small-btn danger-btn" data-del="' + m.id + '">Delete</button></div>';
        list.appendChild(li);
      });
      list.querySelectorAll('[data-start]').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          var id = btn.getAttribute('data-start');
          var r = await fetch('/api/schedule/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + authToken },
            body: JSON.stringify({ id: Number(id) })
          });
          var d = await r.json();
          if (!r.ok) return alert(d.error || 'Failed');
          if ($('historyCloseBtn')) $('historyCloseBtn').click();
          try {
            var joinRes = await fetch('/api/join', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...(authToken ? { Authorization: 'Bearer ' + authToken } : {}) },
              body: JSON.stringify({ code: d.code, participantName: (currentUser && (currentUser.displayName || currentUser.username)) || 'Host', device: detectDevice() })
            });
            if (joinRes.ok) {
              location.href = meetingPath(d.code);
            } else {
              var createName = $('createName');
              if (createName) createName.value = d.name || 'Scheduled meeting';
              alert('Room not live yet. Create a meeting with the same name and share the new link.');
            }
          } catch (ex) { console.error(ex); }
        });
      });
      list.querySelectorAll('[data-copy]').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          var link = location.origin + (btn.getAttribute('data-copy') || '');
          try { await navigator.clipboard.writeText(link); } catch (e) { prompt('Link', link); }
        });
      });
      list.querySelectorAll('[data-del]').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          if (!confirm('Delete this scheduled meeting?')) return;
          await fetch('/api/schedule/' + btn.getAttribute('data-del'), { method: 'DELETE', headers: { Authorization: 'Bearer ' + authToken } });
          loadScheduled();
        });
      });
    } catch (e) { console.error(e); }
  }

  if ($('scheduleForm')) $('scheduleForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var err = $('scheduleError');
    if (err) err.classList.add('hidden');
    if (!authToken) { if (err) { err.textContent = 'Log in to schedule'; err.classList.remove('hidden'); } return; }
    var name = ($('scheduleName') && $('scheduleName').value.trim()) || 'Scheduled meeting';
    var start = $('scheduleStart') && $('scheduleStart').value;
    var end = $('scheduleEnd') && $('scheduleEnd').value;
    if (!start) return;
    try {
      var res = await fetch('/api/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + authToken },
        body: JSON.stringify({ name: name, scheduledStart: new Date(start).toISOString(), scheduledEnd: end ? new Date(end).toISOString() : null })
      });
      var data = await res.json();
      if (!res.ok) { if (err) { err.textContent = data.error || 'Failed'; err.classList.remove('hidden'); } return; }
      if ($('scheduleName')) $('scheduleName').value = '';
      loadScheduled();
    } catch (ex) { if (err) { err.textContent = ex.message; err.classList.remove('hidden'); } }
  });

  if ($('localMediaVideo')) $('localMediaVideo').addEventListener('timeupdate', function () {
    if (!currentContent || currentContent.type !== 'local-video') return;
    if (currentContent.remoteHolderId !== (currentMeeting && currentMeeting.participantId)) return;
    var vid = $('localMediaVideo');
    if (!vid) return;
    sendWS({ type: 'content-update', media: { currentTime: vid.currentTime, playing: !vid.paused } });
  });

  function pdfGo(delta) {
    if (!currentContent || currentContent.type !== 'pdf') return;
    var myId = currentMeeting && currentMeeting.participantId;
    var canControl = currentContent.remoteHolderId === myId || currentContent.ownerId === myId;
    if (!canControl && currentContent.scrollMode === 'uniform') return;
    var next = (pdfPageNum || 1) + delta;
    if (pdfDoc) next = Math.max(1, Math.min(next, pdfDoc.numPages));
    renderPdfPage(next);
    if (canControl) sendWS({ type: 'content-update', page: next });
  }
  if ($('pdfPrevBtn')) $('pdfPrevBtn').addEventListener('click', function () { pdfGo(-1); });
  if ($('pdfNextBtn')) $('pdfNextBtn').addEventListener('click', function () { pdfGo(1); });
  document.addEventListener('keydown', function (e) {
    if (!currentContent) return;
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    if (currentContent.type === 'pdf') {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'PageDown') { e.preventDefault(); pdfGo(1); }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') { e.preventDefault(); pdfGo(-1); }
    }
  });
  // Manual "site blocked" helper: double-click iframe area opens fallback
  if ($('contentFrame')) {
    $('contentFrame').addEventListener('load', function () {
      // After short delay, if URL share and user reports blank, they can use Open in new tab
      var c = currentContent;
      if (c && c.type === 'url' && c.url) {
        var ext = $('contentOpenExternal');
        if (ext) ext.href = c.url;
      }
    });
  }

  restoreSession().then(function () { tryRejoinFromUrl(); });


  // ========== PHASE 1: moderation UI helpers ==========

  function showToast(message, actions) {
    const host = document.getElementById('toastHost');
    if (!host) return;
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `<span>${escapeHtml(message)}</span>`;
    if (actions && actions.length) {
      actions.forEach((a) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = a.label;
        b.addEventListener('click', () => {
          a.onClick && a.onClick();
          el.remove();
        });
        el.appendChild(b);
      });
    }
    host.appendChild(el);
    setTimeout(() => { try { el.remove(); } catch (_) {} }, 5000);
  }

  function openParticipantMenu(p, x, y, opts) {
    const menu = document.getElementById('participantMenu');
    if (!menu) {
      console.warn('[meet] #participantMenu missing from DOM');
      return;
    }
    ensureModPermissions();
    const role = p.role || (p.isHost ? 'host' : 'participant');
    const hostLike = myRole === 'host' || myRole === 'cohost' || !!(currentMeeting && currentMeeting.isHost);

    let html = `<div class="menu-head">${escapeHtml(p.name)}</div><div class="menu-sub">${escapeHtml(p.roleLabel || role)}</div><div class="menu-sep"></div>`;

    if (opts && opts.waiting) {
      html += `<button type="button" data-act="admit"><i class="fa-solid fa-check"></i> Admit</button>`;
      html += `<button type="button" data-act="decline" class="danger"><i class="fa-solid fa-xmark"></i> Decline</button>`;
    } else {
      const canMute = !!(myPermissions.muteOthers || hostLike);
      const canLower = !!(myPermissions.lowerHands || hostLike);
      const canRole = !!(myPermissions.manageRoles || myRole === 'host');
      const canRemove = !!(myPermissions.removePeople || hostLike);

      if (canMute) {
        html += `<button type="button" data-act="mute"><i class="fa-solid fa-microphone-slash"></i> Mute</button>`;
        html += `<button type="button" data-act="ask-unmute"><i class="fa-solid fa-microphone"></i> Ask to unmute</button>`;
      }
      if (canLower && p.handRaised) {
        html += `<button type="button" data-act="lower-hand"><i class="fa-solid fa-hand"></i> Lower hand</button>`;
      }
      if (p.sharing && canMute) {
        html += `<button type="button" data-act="stop-share"><i class="fa-solid fa-desktop"></i> Stop sharing</button>`;
      }
      html += `<div class="menu-sep"></div>`;
      if (canRole && role !== 'host') {
        if (role !== 'cohost') {
          html += `<button type="button" data-act="make-cohost"><i class="fa-solid fa-user-shield"></i> Make co-host</button>`;
        } else {
          html += `<button type="button" data-act="remove-cohost"><i class="fa-solid fa-user"></i> Remove co-host</button>`;
        }
        const pp = p.permissions || {};
        html += `<div class="menu-sub">Permissions</div>`;
        html += `<label class="perm-row"><span>Microphone</span><input type="checkbox" data-perm="microphone" ${pp.microphone !== false ? 'checked' : ''}></label>`;
        html += `<label class="perm-row"><span>Screen share</span><input type="checkbox" data-perm="screenShare" ${pp.screenShare !== false ? 'checked' : ''}></label>`;
        html += `<label class="perm-row"><span>Chat</span><input type="checkbox" data-perm="chat" ${pp.chat !== false ? 'checked' : ''}></label>`;
      }
      if (myRole === 'host' && role !== 'host') {
        html += `<button type="button" data-act="transfer-host"><i class="fa-solid fa-crown"></i> Transfer host</button>`;
      }
      if (canRemove && role !== 'host') {
        html += `<button type="button" data-act="remove" class="danger"><i class="fa-solid fa-user-minus"></i> Remove from meeting</button>`;
      }
      if (!canMute && !canRole && !canRemove) {
        html += `<div class="menu-sub">No actions available</div>`;
      }
    }

    const isMobileSheet = window.matchMedia('(max-width: 700px)').matches;
    if (isMobileSheet) {
      // header with close for bottom sheet
      html = `<div class="menu-sheet-top"><button type="button" class="menu-sheet-close" data-act="close-menu" aria-label="Close">&times;</button></div>` + html;
    }
    menu.innerHTML = html;
    menu.classList.remove('hidden');
    menu.classList.toggle('is-sheet', isMobileSheet);
    menu.style.display = 'block';
    menu.style.zIndex = '3000';
    menu.style.position = 'fixed';

    if (isMobileSheet) {
      menu.style.left = '0px';
      menu.style.right = '0px';
      menu.style.bottom = '0px';
      menu.style.top = 'auto';
      menu.style.width = '100%';
      menu.style.maxWidth = '100%';
    } else {
      const pad = 8;
      const mw = Math.max(menu.offsetWidth || 280, 240);
      const mh = Math.max(menu.offsetHeight || 120, 80);
      let left = typeof x === 'number' ? x : 40;
      let top = typeof y === 'number' ? y : 40;
      left = Math.min(Math.max(pad, left), window.innerWidth - mw - pad);
      top = Math.min(Math.max(pad, top), window.innerHeight - mh - pad);
      menu.style.left = left + 'px';
      menu.style.top = top + 'px';
      menu.style.right = 'auto';
      menu.style.bottom = 'auto';
      menu.style.width = '';
      menu.style.maxWidth = '';
    }

    menu.onclick = (e) => {
      const permInput = e.target.closest('input[data-perm]');
      if (permInput) {
        e.stopPropagation();
        const permissions = {};
        menu.querySelectorAll('input[data-perm]').forEach((inp) => {
          permissions[inp.getAttribute('data-perm')] = !!inp.checked;
        });
        sendWS({ type: 'set-participant-permissions', targetId: p.id, permissions });
        return;
      }
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const act = btn.getAttribute('data-act');
      if (act === 'mute') sendWS({ type: 'mute-participant', targetId: p.id });
      if (act === 'ask-unmute') sendWS({ type: 'ask-unmute', targetId: p.id });
      if (act === 'lower-hand') sendWS({ type: 'lower-hand', targetId: p.id });
      if (act === 'stop-share') sendWS({ type: 'force-stop-share', targetId: p.id });
      if (act === 'make-cohost') sendWS({ type: 'set-role', targetId: p.id, role: 'cohost' });
      if (act === 'remove-cohost') sendWS({ type: 'set-role', targetId: p.id, role: 'participant' });
      if (act === 'transfer-host') {
        if (confirm('Transfer host? You will become a co-host.')) {
          sendWS({ type: 'transfer-host', targetId: p.id });
        }
      }
      if (act === 'close-menu') {
        menu.classList.add('hidden');
        menu.classList.remove('is-sheet');
        menu.style.display = '';
        return;
      }
      if (act === 'admit') sendWS({ type: 'admit-participant', targetId: p.id });
      if (act === 'decline') sendWS({ type: 'decline-participant', targetId: p.id });
      if (act === 'remove') openRemoveModal(p);
      menu.classList.add('hidden');
      menu.classList.remove('is-sheet');
      menu.style.display = '';
    };

    // Close on outside click — next tick so this open click does not close it
    window.__meetMenuCloser && document.removeEventListener('click', window.__meetMenuCloser);
    window.__meetMenuCloser = function (ev) {
      if (!menu.contains(ev.target) && !ev.target.closest('.participant-more')) {
        menu.classList.add('hidden');
        menu.classList.remove('is-sheet');
        menu.style.display = '';
        document.removeEventListener('click', window.__meetMenuCloser);
        window.__meetMenuCloser = null;
      }
    };
    setTimeout(function () {
      document.addEventListener('click', window.__meetMenuCloser);
    }, 0);
  }

  function openRemoveModal(p) {
    removeTargetId = p.id;
    const modal = document.getElementById('removeModal');
    const title = document.getElementById('removeModalTitle');
    if (title) title.textContent = `Remove ${p.name}?`;
    const prevent = document.getElementById('removePreventRejoin');
    if (prevent) prevent.checked = false;
    if (modal) modal.classList.remove('hidden');
  }

  function applySecurityToForm(sec) {
    if (!sec) return;
    const map = {
      secWaitingRoom: 'waitingRoom',
      secGuestAccess: 'guestAccess',
      secLocked: 'locked',
      secScreenShare: 'participantScreenShare',
      secMicrophone: 'participantMicrophone',
      secChat: 'chat',
      secReactions: 'reactions',
      secRaiseHand: 'raiseHand',
      secPartInvite: 'participantsCanInvite',
      secGuestInvite: 'guestsCanInvite',
    };
    Object.keys(map).forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.checked = !!sec[map[id]];
    });
  }


  function wireMeetingToolbar() {
    if (window.__meetToolbarWired) return;
    window.__meetToolbarWired = true;

    const moreBtn = document.getElementById('meetingMoreBtn');
    const morePanel = document.getElementById('meetingMorePanel');
    function closeMore() {
      if (!morePanel) return;
      morePanel.classList.add('hidden');
      if (moreBtn) moreBtn.setAttribute('aria-expanded', 'false');
    }
    function toggleMore(e) {
      if (e) e.stopPropagation();
      if (!morePanel) return;
      const open = morePanel.classList.contains('hidden');
      morePanel.classList.toggle('hidden', !open);
      if (moreBtn) moreBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    if (moreBtn) moreBtn.addEventListener('click', toggleMore);
    document.addEventListener('click', (ev) => {
      if (!morePanel || morePanel.classList.contains('hidden')) return;
      if (morePanel.contains(ev.target) || (moreBtn && moreBtn.contains(ev.target))) return;
      closeMore();
    });

    // Close more panel after a reaction is sent from inside it
    morePanel?.addEventListener('click', (ev) => {
      if (ev.target.closest('.emoji-btn')) closeMore();
    });

    const openDiag = () => {
      if (typeof refreshDiagnostics === 'function') refreshDiagnostics();
      if (typeof openDrawer === 'function') openDrawer('diagDrawer');
      closeMore();
    };
    document.getElementById('moreConnectionBtn')?.addEventListener('click', openDiag);
    document.getElementById('liveStatus')?.addEventListener('click', openDiag);

    document.getElementById('moreActivityBtn')?.addEventListener('click', () => {
      if (typeof openDrawer === 'function') openDrawer('activityDrawer');
      closeMore();
    });
    document.getElementById('moreRecordBtn')?.addEventListener('click', () => {
      document.getElementById('recordModal')?.classList.remove('hidden');
      closeMore();
    });
    document.getElementById('moreInviteBtn')?.addEventListener('click', () => {
      if (typeof openInviteDrawer === 'function') openInviteDrawer();
      else document.getElementById('inviteDrawer')?.classList.remove('hidden');
      closeMore();
    });
    document.getElementById('moreFullscreenBtn')?.addEventListener('click', () => {
      document.getElementById('fullscreenBtn')?.click();
      closeMore();
    });

    document.getElementById('toolbarChatBtn')?.addEventListener('click', () => {
      if (window.matchMedia('(max-width: 700px)').matches) {
        openChatSheet();
        return;
      }
      const overlayBtn = document.getElementById('chatOverlayBtn');
      if (overlayBtn) overlayBtn.click();
      else {
        const chat = document.querySelector('.chat-panel, #chatPanel, .panel-chat');
        if (chat) chat.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });
    document.getElementById('toolbarPeopleBtn')?.addEventListener('click', () => {
      if (window.matchMedia('(max-width: 700px)').matches) {
        openPeopleSheet();
        return;
      }
      const col = document.getElementById('col1');
      if (col) {
        col.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        const search = document.getElementById('peopleSearch');
        if (search) setTimeout(() => search.focus(), 200);
      }
    });
  }

  function openPeopleSheet() {
    const sheet = document.getElementById('peopleSheet');
    const body = document.getElementById('peopleSheetBody');
    if (!sheet || !body) return;
    // Clone live people content from sidebar
    const source = document.querySelector('#col1 .people-panel, #col1 .panel, #col1');
    if (source) {
      body.innerHTML = '';
      const clone = source.cloneNode(true);
      // Remove nested IDs that would duplicate; rebind 3-dot via event delegation on original render
      clone.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
      body.appendChild(clone);
      // Wire participant-more clicks inside sheet to original handlers via data
      body.querySelectorAll('.participant-more').forEach((btn, i) => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const original = document.querySelectorAll('#col1 .participant-more')[i];
          if (original) original.click();
        });
      });
    }
    sheet.classList.remove('hidden');
    sheet.setAttribute('aria-hidden', 'false');
  }

  function closePeopleSheet() {
    const sheet = document.getElementById('peopleSheet');
    if (!sheet) return;
    sheet.classList.add('hidden');
    sheet.setAttribute('aria-hidden', 'true');
  }

  function openChatSheet() {
    const sheet = document.getElementById('chatSheet');
    if (!sheet) return;
    // Sync messages from main chat
    const src = document.getElementById('chatMessages');
    const dest = document.getElementById('chatSheetMessages');
    if (src && dest) dest.innerHTML = src.innerHTML;
    sheet.classList.remove('hidden');
    sheet.setAttribute('aria-hidden', 'false');
    const input = document.getElementById('chatSheetInput');
    if (input) setTimeout(() => input.focus(), 150);
  }

  function closeChatSheet() {
    const sheet = document.getElementById('chatSheet');
    if (!sheet) return;
    sheet.classList.add('hidden');
    sheet.setAttribute('aria-hidden', 'true');
  }

  function wireMobileSheets() {
    if (window.__meetSheetsWired) return;
    window.__meetSheetsWired = true;
    document.getElementById('peopleSheetClose')?.addEventListener('click', closePeopleSheet);
    document.getElementById('peopleSheetBackdrop')?.addEventListener('click', closePeopleSheet);
    document.getElementById('chatSheetClose')?.addEventListener('click', closeChatSheet);
    document.getElementById('chatSheetBackdrop')?.addEventListener('click', closeChatSheet);

    const form = document.getElementById('chatSheetForm');
    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = document.getElementById('chatSheetInput');
      const mainInput = document.getElementById('chatInput');
      const mainForm = document.getElementById('chatForm');
      if (input && mainInput && mainForm) {
        mainInput.value = input.value;
        mainForm.requestSubmit ? mainForm.requestSubmit() : mainForm.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        input.value = '';
        // refresh sheet messages shortly after
        setTimeout(() => {
          const src = document.getElementById('chatMessages');
          const dest = document.getElementById('chatSheetMessages');
          if (src && dest) dest.innerHTML = src.innerHTML;
        }, 120);
      }
    });
  }

  function wirePhase1UI() {
    wireMeetingToolbar();
    wireMobileSheets();
    const peopleSearch = document.getElementById('peopleSearch');
    if (peopleSearch && !peopleSearch.dataset.wired) {
      peopleSearch.dataset.wired = '1';
      peopleSearch.addEventListener('input', () => renderParticipants());
    }
    const raiseBtn = document.getElementById('raiseHandBtn');
    if (raiseBtn) {
      raiseBtn.addEventListener('click', () => {
        if (handRaised) {
          sendWS({ type: 'lower-hand' });
          handRaised = false;
          raiseBtn.classList.remove('active');
          raiseBtn.setAttribute('aria-pressed', 'false');
        } else {
          sendWS({ type: 'raise-hand' });
          handRaised = true;
          raiseBtn.classList.add('active');
          raiseBtn.setAttribute('aria-pressed', 'true');
        }
      });
    }

    const secBtn = document.getElementById('securityBtn');
    const drawer = document.getElementById('securityDrawer');
    const closeSec = document.getElementById('securityDrawerClose');
    const backdrop = document.getElementById('securityDrawerBackdrop');
    function openSecurity() {
      if (!drawer) return;
      applySecurityToForm(securityState);
      drawer.classList.remove('hidden');
      drawer.setAttribute('aria-hidden', 'false');
    }
    function closeSecurity() {
      if (!drawer) return;
      drawer.classList.add('hidden');
      drawer.setAttribute('aria-hidden', 'true');
    }
    if (secBtn) secBtn.addEventListener('click', openSecurity);
    if (closeSec) closeSec.addEventListener('click', closeSecurity);
    if (backdrop) backdrop.addEventListener('click', closeSecurity);

    const secIds = ['secWaitingRoom','secGuestAccess','secLocked','secScreenShare','secMicrophone','secChat','secReactions','secRaiseHand','secPartInvite','secGuestInvite'];
    secIds.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', () => {
        const settings = {
          waitingRoom: !!document.getElementById('secWaitingRoom')?.checked,
          guestAccess: !!document.getElementById('secGuestAccess')?.checked,
          locked: !!document.getElementById('secLocked')?.checked,
          participantScreenShare: !!document.getElementById('secScreenShare')?.checked,
          participantMicrophone: !!document.getElementById('secMicrophone')?.checked,
          chat: !!document.getElementById('secChat')?.checked,
          reactions: !!document.getElementById('secReactions')?.checked,
          raiseHand: !!document.getElementById('secRaiseHand')?.checked,
          participantsCanInvite: !!document.getElementById('secPartInvite')?.checked,
          guestsCanInvite: !!document.getElementById('secGuestInvite')?.checked,
        };
        sendWS({ type: 'update-security', settings });
        if (id === 'secLocked') {
          sendWS({ type: settings.locked ? 'lock-meeting' : 'unlock-meeting' });
        }
      });
    });

    const removeConfirm = document.getElementById('removeConfirmBtn');
    const removeCancel = document.getElementById('removeCancelBtn');
    const removeBackdrop = document.getElementById('removeModalBackdrop');
    const removeModal = document.getElementById('removeModal');
    if (removeConfirm) {
      removeConfirm.addEventListener('click', () => {
        if (!removeTargetId) return;
        const prevent = !!document.getElementById('removePreventRejoin')?.checked;
        sendWS({ type: 'remove-participant', targetId: removeTargetId, preventRejoin: prevent });
        removeTargetId = null;
        if (removeModal) removeModal.classList.add('hidden');
      });
    }
    function closeRemove() {
      removeTargetId = null;
      if (removeModal) removeModal.classList.add('hidden');
    }
    if (removeCancel) removeCancel.addEventListener('click', closeRemove);
    if (removeBackdrop) removeBackdrop.addEventListener('click', closeRemove);

    // menu outside-click handled in openParticipantMenu


    const reviewBtn = document.getElementById('reviewWaitingBtn');
    if (reviewBtn) {
      reviewBtn.addEventListener('click', () => {
        document.getElementById('waitingSectionLabel')?.scrollIntoView({ behavior: 'smooth' });
      });
    }

    const waitingLeave = document.getElementById('waitingLeaveBtn');
    if (waitingLeave) {
      waitingLeave.addEventListener('click', () => {
        leaveMeeting && leaveMeeting();
      });
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      if (!currentMeeting) return;
      if (e.key === 'h' || e.key === 'H') {
        e.preventDefault();
        raiseBtn && raiseBtn.click();
      }
    });
  }

  function showWaitingRoom(data) {
    const wv = document.getElementById('waitingView');
    const hv = document.getElementById('homeView');
    const mv = document.getElementById('meetingView');
    if (hv) hv.classList.add('hidden');
    if (mv) mv.classList.add('hidden');
    if (wv) {
      wv.classList.remove('hidden');
      const codeLabel = document.getElementById('waitingCodeLabel');
      if (codeLabel && data) {
        const c = data.code || '';
        codeLabel.textContent = c.length === 6 ? c.slice(0, 3) + '-' + c.slice(3) : c;
      }
    }
  }

  function hideWaitingRoom() {
    const wv = document.getElementById('waitingView');
    if (wv) wv.classList.add('hidden');
  }

  // Hook into boot
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wirePhase1UI);
  } else {
    wirePhase1UI();
  }




  // ========== PHASE 2 ==========
  let activityEntries = [];
  let recordingState = null;
  let recordingTimerInterval = null;
  let templatesCache = [];

  function formatActivityLabel(entry) {
    const name = entry.actorName || 'Someone';
    const t = entry.eventType || '';
    const map = {
      hand_raised: name + ' raised hand',
      hand_lowered: name + ' lowered a hand',
      role_changed: name + ' changed a role',
      host_transferred: name + ' transferred host',
      participant_removed: name + ' removed a participant',
      muted: name + ' muted someone',
      locked: name + ' locked the meeting',
      unlocked: name + ' unlocked the meeting',
      share_started: name + ' started sharing',
      share_stopped: name + ' stopped sharing',
      recording_started: name + ' started recording',
      recording_stopped: name + ' stopped recording',
      joined: name + ' joined',
      left: name + ' left',
    };
    return map[t] || (name + ' · ' + t);
  }

  function formatClock(ts) {
    const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function renderActivityList() {
    const list = document.getElementById('activityList');
    const empty = document.getElementById('activityEmpty');
    if (!list) return;
    list.innerHTML = '';
    const items = activityEntries.slice().reverse();
    if (!items.length) {
      if (empty) empty.classList.remove('hidden');
      return;
    }
    if (empty) empty.classList.add('hidden');
    items.forEach((e) => {
      const li = document.createElement('li');
      li.innerHTML = `<span class="act-time">${escapeHtml(formatClock(e.at))}</span>
        <span><span class="act-dot"></span>${escapeHtml(formatActivityLabel(e))}</span>`;
      list.appendChild(li);
    });
  }

  function openDrawer(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('hidden');
    el.setAttribute('aria-hidden', 'false');
  }
  function closeDrawer(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.add('hidden');
    el.setAttribute('aria-hidden', 'true');
  }

  async function loadActivity() {
    if (!currentMeeting) return;
    try {
      const data = await api('/api/activity?code=' + encodeURIComponent(currentMeeting.code));
      const hist = (data.history || []).map((r) => ({
        at: r.at,
        actorName: r.actorName,
        eventType: r.eventType,
        detail: r.detail,
      }));
      const live = (data.live || []).map((e) => ({
        at: e.at,
        actorName: e.actorName,
        eventType: e.eventType,
        detail: e.detail,
      }));
      activityEntries = hist.length ? hist : live;
      renderActivityList();
    } catch (_) {}
  }

  function updateRecordingBadge() {
    const badge = document.getElementById('recordingBadge');
    const timer = document.getElementById('recordingTimer');
    if (!badge) return;
    if (recordingState && recordingState.status === 'recording') {
      badge.classList.remove('hidden');
      const start = recordingState.startedAt || Date.now();
      const tick = () => {
        const sec = Math.max(0, Math.floor((Date.now() - start) / 1000));
        const m = String(Math.floor(sec / 60)).padStart(2, '0');
        const s = String(sec % 60).padStart(2, '0');
        if (timer) timer.textContent = m + ':' + s;
      };
      tick();
      if (recordingTimerInterval) clearInterval(recordingTimerInterval);
      recordingTimerInterval = setInterval(tick, 1000);
    } else {
      badge.classList.add('hidden');
      if (recordingTimerInterval) clearInterval(recordingTimerInterval);
      recordingTimerInterval = null;
    }
  }

  async function refreshDiagnostics() {
    setTimeout(function(){ if (window.__meetEnhanceDiag) window.__meetEnhanceDiag(); }, 50);
    const label = document.getElementById('diagLabel');
    const dot = document.getElementById('diagDot');
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    let quality = 'Excellent';
    let cls = 'good';
    let latency = '—';
    let audio = 'Excellent';
    let video = 'Excellent';
    let share = 'Excellent';
    try {
      if (typeof room !== 'undefined' && room && room.engine) {
        // LiveKit room stats if available
      }
      if (navigator.connection) {
        const c = navigator.connection;
        set('diagNetwork', (c.effectiveType || 'Wi-Fi') + (c.downlink ? ' · ' + c.downlink + ' Mbps' : ''));
        if (c.rtt != null) latency = c.rtt + ' ms';
        if (c.rtt > 200 || c.effectiveType === '2g') { quality = 'Unstable'; cls = 'bad'; }
        else if (c.rtt > 100 || c.effectiveType === '3g') { quality = 'Fair'; cls = 'warn'; }
      } else {
        set('diagNetwork', 'Wi-Fi / Ethernet');
      }
      if (ws && ws.readyState === 1) {
        // soft ping via message timestamp not available; use online
      } else {
        quality = 'Disconnected';
        cls = 'bad';
      }
    } catch (_) {}
    if (label) label.textContent = quality;
    if (dot) { dot.className = 'diag-dot ' + cls; }
    set('diagLatency', latency);
    set('diagAudio', audio);
    set('diagVideo', video);
    set('diagShare', share);
    const hint = document.getElementById('diagHint');
    if (hint) {
      hint.textContent = cls === 'bad'
        ? 'Your connection may affect audio and screen sharing.'
        : cls === 'warn'
          ? 'Connection is usable but may fluctuate.'
          : '';
    }
  }

  async function loadTemplates() {
    try {
      const data = await api('/api/templates');
      templatesCache = data.templates || [];
      const sel = document.getElementById('templateSelect');
      if (!sel) return;
      sel.innerHTML = '';
      templatesCache.forEach((t) => {
        const opt = document.createElement('option');
        opt.value = t.slug;
        opt.textContent = t.name;
        sel.appendChild(opt);
      });
    } catch (_) {}
  }

  function getSelectedTemplateSettings() {
    const sel = document.getElementById('templateSelect');
    if (!sel) return {};
    const t = templatesCache.find((x) => x.slug === sel.value);
    return (t && t.settings) || {};
  }

  function wirePhase2UI() {
    loadTemplates();

    const pairs = [
      ['activityDrawerClose', 'activityDrawer'],
      ['activityDrawerBackdrop', 'activityDrawer'],
      ['diagDrawerClose', 'diagDrawer'],
      ['diagDrawerBackdrop', 'diagDrawer'],
    ];
    pairs.forEach(([btnId, drawerId]) => {
      const el = document.getElementById(btnId);
      if (el) el.addEventListener('click', () => closeDrawer(drawerId));
    });

    document.getElementById('liveStatus')?.addEventListener('click', () => {
      refreshDiagnostics();
      openDrawer('diagDrawer');
    });

    // More menu actions
    document.getElementById('moreMenu')?.addEventListener('click', (e) => {
      const item = e.target.closest('[data-action]');
      if (!item) return;
      const act = item.getAttribute('data-action');
      if (act === 'activity') {
        loadActivity();
        openDrawer('activityDrawer');
      }
      if (act === 'record') {
        if (recordingState && recordingState.status === 'recording') {
          sendWS({ type: 'stop-recording' });
        } else {
          document.getElementById('recordModal')?.classList.remove('hidden');
        }
      }
    });

    document.getElementById('recordCancelBtn')?.addEventListener('click', () => {
      document.getElementById('recordModal')?.classList.add('hidden');
    });
    document.getElementById('recordModalBackdrop')?.addEventListener('click', () => {
      document.getElementById('recordModal')?.classList.add('hidden');
    });
    document.getElementById('recordStartBtn')?.addEventListener('click', () => {
      sendWS({
        type: 'start-recording',
        audio: !!document.getElementById('recAudio')?.checked,
        video: !!document.getElementById('recVideo')?.checked,
        screenShare: !!document.getElementById('recScreen')?.checked,
        chat: !!document.getElementById('recChat')?.checked,
      });
      document.getElementById('recordModal')?.classList.add('hidden');
    });

    // Keyboard shortcuts expansion
    document.addEventListener('keydown', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT')) return;
      if (!currentMeeting) return;
      if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        try { toggleMic(); } catch (_) {}
      }
      if (e.key === 's' || e.key === 'S') {
        if (e.metaKey || e.ctrlKey) return;
        e.preventDefault();
        try {
          if (typeof isSharing !== 'undefined' && isSharing) stopShare();
          else startShare();
        } catch (_) {}
      }
    });
  }

  // Extend WS handler side-effects via polling override: patch into existing by monkey-patch after connect
  const _origShowMeeting = typeof showMeeting === 'function' ? showMeeting : null;

  // Show activity/record in more menu when in meeting
  function refreshPhase2Chrome() {
    const act = document.querySelector('.more-activity');
    const rec = document.querySelector('.more-record');
    if (act) act.classList.toggle('hidden', !currentMeeting);
    if (rec) {
      const isHost = myRole === 'host' || currentMeeting?.isHost;
      rec.classList.toggle('hidden', !currentMeeting || !isHost);
      if (rec && recordingState && recordingState.status === 'recording') {
        rec.innerHTML = '<i class="fa-solid fa-stop"></i> Stop recording';
      } else if (rec) {
        rec.innerHTML = '<i class="fa-solid fa-circle"></i> Record';
      }
    }
  }

  // Listen for phase2 WS messages - append to socket handler by intercepting
  const _phase2MsgTypes = {
    activity: function (msg) {
      if (msg.entry) {
        activityEntries.push(msg.entry);
        if (activityEntries.length > 200) activityEntries.shift();
        renderActivityList();
      }
    },
    'recording-state': function (msg) {
      recordingState = msg.recording || null;
      updateRecordingBadge();
      refreshPhase2Chrome();
    },
    toast: function (msg) {
      if (msg.message) showToast(msg.message);
    },
  };

  // Hook: wrap connectWS message path - find by patching after definition is hard;
  // Use event delegation on a custom bus if available, else interval-free monkey on WebSocket
  const _NativeWS = window.WebSocket;
  // Safer: extend the existing handler block was done for phase1; add duplicate check via Mutation of last message handler
  // Install capture on message by overriding sendWS/connectWS post-init
  setTimeout(function installPhase2WsHook() {
    // Patch into socket.onmessage by wrapping connectWS if possible
    if (typeof connectWS !== 'function') return;
    const orig = connectWS;
    // Can't easily wrap without replacing - use document-level CustomEvent from phase1 handler
  }, 0);

  // Direct: append handler by observing - inject into onmessage via periodic check
  // Better approach: add to the message if block already patched - add phase2 types to the big if chain
  // We already have force-mute etc. We'll use MutationObserver-free approach:
  const _wsMsgInterceptor = function (msg) {
    const fn = _phase2MsgTypes[msg.type];
    if (fn) fn(msg);
    if (msg.type === 'participants' || msg.type === 'participant-joined') refreshPhase2Chrome();
  };
  // Attach by wrapping JSON parse path - hook send is not enough
  window.__meetPhase2OnMsg = _wsMsgInterceptor;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wirePhase2UI);
  } else {
    wirePhase2UI();
  }




  // ========== P0/P1 invite + rejoin + advanced ==========
  function openInviteDrawer() {
    const drawer = document.getElementById('inviteDrawer');
    if (!drawer || !currentMeeting) return;
    const input = document.getElementById('inviteLinkInput');
    const code = currentMeeting.code || '';
    const formatted = code.length === 6 ? code.slice(0, 3) + '-' + code.slice(3) : code;
    let token = window.__lastInviteToken || '';
    try { token = token || sessionStorage.getItem('meet-invite-' + code) || ''; } catch (_) {}
    const origin = location.origin;
    const link = token
      ? origin + '/' + formatted + '?key=' + token
      : origin + '/' + formatted;
    if (input) input.value = link;
    drawer.classList.remove('hidden');
    drawer.setAttribute('aria-hidden', 'false');
  }
  function closeInviteDrawer() {
    const drawer = document.getElementById('inviteDrawer');
    if (!drawer) return;
    drawer.classList.add('hidden');
    drawer.setAttribute('aria-hidden', 'true');
  }

  function wireInviteAndAdvanced() {
    document.getElementById('createAdvancedToggle')?.addEventListener('click', () => {
      document.getElementById('createAdvanced')?.classList.toggle('hidden');
    });
    document.getElementById('inviteDrawerClose')?.addEventListener('click', closeInviteDrawer);
    document.getElementById('inviteDrawerBackdrop')?.addEventListener('click', closeInviteDrawer);
    document.getElementById('copyInviteBtn')?.addEventListener('click', async () => {
      const input = document.getElementById('inviteLinkInput');
      if (!input) return;
      try {
        await navigator.clipboard.writeText(input.value);
        showToast('Link copied');
      } catch (_) {
        input.select();
        document.execCommand('copy');
        showToast('Link copied');
      }
    });
    document.getElementById('regenInviteBtn')?.addEventListener('click', async () => {
      if (!currentMeeting) return;
      try {
        const data = await api('/api/invite/regenerate', {
          method: 'POST',
          body: JSON.stringify({ code: currentMeeting.code, participantId: currentMeeting.participantId }),
        });
        window.__lastInviteToken = data.inviteToken;
        try { sessionStorage.setItem('meet-invite-' + currentMeeting.code, data.inviteToken); } catch (_) {}
        openInviteDrawer();
        showToast('Invite link regenerated');
      } catch (e) {
        showToast(e.message || 'Could not regenerate');
      }
    });
    // shareLinkBtn opens invite
    const shareLink = document.getElementById('shareLinkBtn');
    if (shareLink && !shareLink.dataset.inviteWired) {
      shareLink.dataset.inviteWired = '1';
      shareLink.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openInviteDrawer();
      });
    }
    document.getElementById('moreMenu')?.addEventListener('click', (e) => {
      const item = e.target.closest('[data-action="invite"]');
      if (item) openInviteDrawer();
    });

    // Guest label
    function updateGuestLabel() {
      let label = document.getElementById('joinGuestLabel');
      const nameInput = document.getElementById('joinYourName') || document.querySelector('#joinForm input[type="text"]');
      if (!nameInput) return;
      if (!label) {
        label = document.createElement('div');
        label.id = 'joinGuestLabel';
        label.className = 'guest-label hidden';
        label.textContent = 'Guest';
        nameInput.parentNode?.appendChild(label);
      }
      const loggedIn = !!(typeof currentUser !== 'undefined' && currentUser);
      label.classList.toggle('hidden', loggedIn);
    }
    updateGuestLabel();
    setInterval(updateGuestLabel, 2000);

    // Rejoin bar when session exists for code in URL
    try {
      const sess = typeof loadSession === 'function' ? loadSession() : null;
      const pathCode = (location.pathname || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      if (sess && sess.code && pathCode && sess.code === pathCode && !currentMeeting) {
        const bar = document.getElementById('rejoinBar');
        if (bar) {
          bar.classList.remove('hidden');
          document.getElementById('rejoinBtn')?.addEventListener('click', async () => {
            bar.classList.add('hidden');
            const yourName = sess.participantName || (typeof displayNameOf === 'function' ? displayNameOf(currentUser) : 'Guest');
            const urlKey = new URLSearchParams(location.search).get('key') || sessionStorage.getItem('meet-invite-' + sess.code) || undefined;
            try {
              const data = await api('/api/join', {
                method: 'POST',
                body: JSON.stringify({
                  code: sess.code,
                  participantId: sess.participantId,
                  participantName: yourName,
                  key: urlKey,
                  device: detectDevice(),
                }),
              });
              await showMeeting(data, !!sess.isHost, { participantName: yourName });
            } catch (e) {
              showToast(e.message || 'Could not rejoin');
            }
          });
        }
      }
    } catch (_) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireInviteAndAdvanced);
  } else {
    wireInviteAndAdvanced();
  }




  // ========== Phase 2 full: camera, chat drawer, diagnostics ==========
  let cameraEnabled = false;
  let localCameraTrack = null;

  async function toggleCamera() {
    const btn = document.getElementById('cameraBtn');
    try {
      if (!cameraEnabled) {
        if (typeof LivekitClient === 'undefined' && typeof room === 'undefined') {
          showToast('Camera needs an active meeting connection');
          return;
        }
        // Prefer LiveKit local participant if room exists
        const lkRoom = (typeof room !== 'undefined' && room) ? room : null;
        if (lkRoom && window.LivekitClient) {
          const track = await window.LivekitClient.createLocalVideoTrack({
            resolution: window.LivekitClient.VideoPresets.h720.resolution,
          });
          await lkRoom.localParticipant.publishTrack(track);
          localCameraTrack = track;
          cameraEnabled = true;
        } else if (navigator.mediaDevices) {
          const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
          localCameraTrack = stream;
          cameraEnabled = true;
          showToast('Camera preview on (publish when LiveKit room is ready)');
        }
      } else {
        if (localCameraTrack) {
          try {
            if (localCameraTrack.stop) localCameraTrack.stop();
            if (localCameraTrack.mediaStreamTrack) localCameraTrack.mediaStreamTrack.stop();
            if (typeof room !== 'undefined' && room && localCameraTrack.kind) {
              await room.localParticipant.unpublishTrack(localCameraTrack);
            }
          } catch (_) {}
          localCameraTrack = null;
        }
        cameraEnabled = false;
      }
      if (btn) {
        btn.setAttribute('aria-pressed', String(cameraEnabled));
        btn.classList.toggle('active', cameraEnabled);
      }
    } catch (e) {
      showToast(e.message || 'Camera unavailable');
    }
  }

  function wirePhase2Full() {
    document.getElementById('cameraBtn')?.addEventListener('click', toggleCamera);

    // Chat drawer toggle
    document.getElementById('chatToggleBtn')?.addEventListener('click', () => {
      const chat = document.getElementById('sideChat');
      if (!chat) return;
      chat.classList.toggle('chat-drawer-open');
    });
    // Also use chat overlay btn if present
    document.getElementById('chatOverlayBtn')?.addEventListener('click', () => {
      const chat = document.getElementById('sideChat');
      if (chat) chat.classList.toggle('chat-drawer-open');
    });

    // Keyboard V for camera
    document.addEventListener('keydown', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      if (!currentMeeting) return;
      if (e.key === 'v' || e.key === 'V') {
        e.preventDefault();
        toggleCamera();
      }
    });
  }

  // Improve diagnostics with LiveKit if available
  const _origRefreshDiag = typeof refreshDiagnostics === 'function' ? refreshDiagnostics : null;
  if (_origRefreshDiag) {
    // wrap by redefining after
  }
  window.__meetEnhanceDiag = function () {
    try {
      const lkRoom = (typeof room !== 'undefined') ? room : null;
      if (lkRoom && lkRoom.engine && lkRoom.engine.client) {
        // soft indicator that media is connected
        const el = document.getElementById('diagLabel');
        const dot = document.getElementById('diagDot');
        if (lkRoom.state === 'connected') {
          if (el && el.textContent === 'Checking…') el.textContent = 'Excellent';
          if (dot) dot.className = 'diag-dot good';
          const a = document.getElementById('diagAudio');
          const v = document.getElementById('diagVideo');
          if (a) a.textContent = 'Connected';
          if (v) v.textContent = 'Connected';
        }
      }
    } catch (_) {}
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wirePhase2Full);
  } else {
    wirePhase2Full();
  }



// ===== UI overhaul: tabs, notifications, media preview, list fixes =====
  (function wireSideTabsAndNotifs() {
    const tabs = document.querySelectorAll(".side-tab");
    const panels = document.querySelectorAll(".side-tab-panel");
    function switchTab(name) {
      tabs.forEach((t) => {
        const on = t.dataset.tab === name;
        t.classList.toggle("active", on);
        t.setAttribute("aria-selected", on ? "true" : "false");
      });
      panels.forEach((p) => {
        const on = p.dataset.tab === name;
        p.classList.toggle("active", on);
        p.classList.toggle("hidden", !on);
      });
      if (name === "notifications") renderNotifications();
      if (name === "chat") {
        const box = $("chatMessages");
        if (box) box.scrollTop = box.scrollHeight;
        const badge = $("chatUnreadBadge");
        if (badge) { badge.textContent = "0"; badge.classList.add("hidden"); }
      }
    }
    tabs.forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));

    let notifications = [];
    let notifIdSeq = 1;
    function addNotification(kind, text, meta) {
      const n = {
        id: notifIdSeq++,
        kind: kind || "info",
        text: text || "",
        meta: meta || {},
        attended: false,
        ts: Date.now(),
      };
      notifications.unshift(n);
      if (notifications.length > 80) notifications.length = 80;
      const badge = $("notifUnreadBadge");
      if (badge) {
        const c = notifications.filter((x) => !x.attended).length;
        badge.textContent = String(c);
        badge.classList.toggle("hidden", c === 0);
      }
      const active = document.querySelector(".side-tab.active");
      if (active && active.dataset.tab === "notifications") renderNotifications();
      return n;
    }
    window.__meetAddNotification = addNotification;

    function renderNotifications() {
      const list = $("notificationsList");
      const empty = $("notificationsEmpty");
      if (!list) return;
      const q = (($("notifSearch") && $("notifSearch").value) || "").trim().toLowerCase();
      list.innerHTML = "";
      let shown = 0;
      notifications.forEach((n) => {
        if (q && !String(n.text).toLowerCase().includes(q) && !String(n.kind).toLowerCase().includes(q)) return;
        shown++;
        const li = document.createElement("li");
        if (n.attended) li.classList.add("attended");
        const ago = Math.max(0, Math.round((Date.now() - n.ts) / 1000));
        const timeStr = ago < 60 ? ago + "s ago" : ago < 3600 ? Math.round(ago / 60) + "m ago" : Math.round(ago / 3600) + "h ago";
        li.innerHTML = "<div>" + escapeHtml(n.text) + '</div><span class="notif-time">' + timeStr + "</span>";
        if (!n.attended && (n.kind === "join-request" || n.kind === "raised-hand")) {
          const acts = document.createElement("div");
          acts.className = "notif-actions";
          if (n.kind === "join-request" && n.meta.participantId) {
            const admit = document.createElement("button");
            admit.type = "button";
            admit.className = "btn small-btn primary-btn";
            admit.textContent = "Admit";
            admit.addEventListener("click", (e) => {
              e.stopPropagation();
              sendWS({ type: "admit-participant", targetId: n.meta.participantId });
              n.attended = true;
              renderNotifications();
            });
            const deny = document.createElement("button");
            deny.type = "button";
            deny.className = "btn small-btn";
            deny.textContent = "Deny";
            deny.addEventListener("click", (e) => {
              e.stopPropagation();
              sendWS({ type: "decline-participant", targetId: n.meta.participantId });
              n.attended = true;
              renderNotifications();
            });
            acts.appendChild(admit);
            acts.appendChild(deny);
          }
          if (n.kind === "raised-hand" && n.meta.participantId) {
            const lower = document.createElement("button");
            lower.type = "button";
            lower.className = "btn small-btn";
            lower.textContent = "Lower hand";
            lower.addEventListener("click", (e) => {
              e.stopPropagation();
              sendWS({ type: "lower-hand", targetId: n.meta.participantId });
              n.attended = true;
              renderNotifications();
            });
            acts.appendChild(lower);
          }
          li.appendChild(acts);
        }
        li.addEventListener("click", () => {
          if (!n.attended) {
            n.attended = true;
            renderNotifications();
            const badge = $("notifUnreadBadge");
            if (badge) {
              const c = notifications.filter((x) => !x.attended).length;
              badge.textContent = String(c);
              badge.classList.toggle("hidden", c === 0);
            }
          }
        });
        list.appendChild(li);
      });
      if (empty) empty.classList.toggle("hidden", shown > 0);
    }
    if ($("notifSearch")) $("notifSearch").addEventListener("input", renderNotifications);

    // Media pre-send preview
    let pendingMedia = null;
    function showMediaPreview(attachment, caption) {
      pendingMedia = { attachment: attachment, caption: caption || "" };
      const bar = $("mediaPreviewBar");
      const content = $("mediaPreviewContent");
      if (!bar || !content) return;
      content.innerHTML = "";
      if (attachment.kind === "image" && attachment.dataUrl) {
        const img = document.createElement("img");
        img.src = attachment.dataUrl;
        img.alt = attachment.name || "Image";
        content.appendChild(img);
      } else if (attachment.kind === "voice" && attachment.dataUrl) {
        const audio = document.createElement("audio");
        audio.controls = true;
        audio.src = attachment.dataUrl;
        content.appendChild(audio);
      } else {
        const chip = document.createElement("div");
        chip.className = "file-chip";
        chip.innerHTML = '<i class="fa-solid fa-paperclip"></i> ' + escapeHtml(attachment.name || "File") +
          ' <span style="opacity:.7">(' + Math.round((attachment.size || 0) / 1024) + " KB)</span>";
        content.appendChild(chip);
      }
      if (caption) {
        const cap = document.createElement("div");
        cap.style.marginTop = "0.35rem";
        cap.style.opacity = "0.85";
        cap.textContent = caption;
        content.appendChild(cap);
      }
      bar.classList.remove("hidden");
    }
    function clearMediaPreview() {
      pendingMedia = null;
      const bar = $("mediaPreviewBar");
      if (bar) bar.classList.add("hidden");
      const content = $("mediaPreviewContent");
      if (content) content.innerHTML = "";
    }
    if ($("mediaPreviewCancel")) $("mediaPreviewCancel").addEventListener("click", clearMediaPreview);
    if ($("mediaPreviewSend")) $("mediaPreviewSend").addEventListener("click", function () {
      if (!pendingMedia) return;
      sendChatPayload(pendingMedia.caption || "", pendingMedia.attachment);
      if ($("chatInput")) $("chatInput").value = "";
      clearMediaPreview();
    });

    function rebindFileInput(inputId, kind) {
      const old = $(inputId);
      if (!old) return;
      const neu = old.cloneNode(true);
      old.parentNode.replaceChild(neu, old);
      neu.addEventListener("change", async function () {
        const file = neu.files && neu.files[0];
        neu.value = "";
        if (!file) return;
        try {
          if (kind === "image") {
            const compressed = await compressImageToWebp(file, 720, 0.82);
            if (compressed.dataUrl.length > 900000) {
              alert("Image still too large after compression. Try a smaller picture.");
              return;
            }
            const caption = ($("chatInput") && $("chatInput").value || "").trim();
            showMediaPreview({
              kind: "image",
              name: compressed.name,
              mime: compressed.mime,
              size: compressed.size,
              dataUrl: compressed.dataUrl,
            }, caption);
          } else {
            if (file.size > 2 * 1024 * 1024) {
              alert("Attachments are limited to 2 MB over chat. Use a link for larger files.");
              return;
            }
            const dataUrl = await readFileAsDataUrl(file);
            if (dataUrl.length > 2800000) {
              alert("File too large to send in chat (max ~2 MB).");
              return;
            }
            const caption = ($("chatInput") && $("chatInput").value || "").trim();
            showMediaPreview({
              kind: "file",
              name: file.name,
              mime: file.type || "application/octet-stream",
              size: file.size,
              dataUrl: dataUrl,
            }, caption);
          }
        } catch (err) {
          alert(err.message || "Could not process file");
        }
      });
    }
    rebindFileInput("chatImageInput", "image");
    rebindFileInput("chatFileInput", "file");

    // Voice preview
    const voiceBtn = $("chatVoiceBtn");
    if (voiceBtn) {
      let voiceRecorder2 = null, voiceChunks2 = [], voiceStream2 = null, voiceRecording2 = false;
      async function toggleVoiceNotePreview() {
        if (voiceRecording2) {
          voiceRecording2 = false;
          voiceBtn.classList.remove("recording");
          const st = $("chatVoiceStatus");
          if (st) { st.classList.add("hidden"); st.classList.remove("recording"); st.textContent = ""; }
          if (voiceRecorder2 && voiceRecorder2.state !== "inactive") {
            try { voiceRecorder2.stop(); } catch (_) {}
          } else if (voiceStream2) {
            voiceStream2.getTracks().forEach((tr) => tr.stop());
            voiceStream2 = null;
          }
          return;
        }
        try {
          voiceStream2 = await navigator.mediaDevices.getUserMedia({ audio: true });
          voiceChunks2 = [];
          const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "";
          voiceRecorder2 = mime ? new MediaRecorder(voiceStream2, { mimeType: mime }) : new MediaRecorder(voiceStream2);
          voiceRecorder2.ondataavailable = (e) => { if (e.data && e.data.size) voiceChunks2.push(e.data); };
          voiceRecorder2.onstop = async () => {
            try {
              const blob = new Blob(voiceChunks2, { type: voiceRecorder2.mimeType || "audio/webm" });
              const dataUrl = await new Promise((res, rej) => {
                const r = new FileReader();
                r.onload = () => res(r.result);
                r.onerror = rej;
                r.readAsDataURL(blob);
              });
              showMediaPreview({
                kind: "voice",
                name: "voice-note.webm",
                mime: blob.type || "audio/webm",
                size: blob.size,
                dataUrl: dataUrl,
              }, "");
            } catch (e) {
              alert(e.message || "Could not process voice note");
            } finally {
              if (voiceStream2) voiceStream2.getTracks().forEach((tr) => tr.stop());
              voiceStream2 = null;
            }
          };
          voiceRecorder2.start();
          voiceRecording2 = true;
          voiceBtn.classList.add("recording");
          const st = $("chatVoiceStatus");
          if (st) {
            st.textContent = "Recording… tap mic to preview";
            st.classList.remove("hidden");
            st.classList.add("recording");
          }
        } catch (e) {
          alert("Microphone permission needed for voice notes.");
        }
      }
      const neuBtn = voiceBtn.cloneNode(true);
      voiceBtn.parentNode.replaceChild(neuBtn, voiceBtn);
      neuBtn.id = "chatVoiceBtn";
      neuBtn.addEventListener("click", toggleVoiceNotePreview);
    }

    // Fix raised-hands orphan button
    const raisedObsTarget = document.getElementById("raisedHandsList");
    if (raisedObsTarget) {
      const mo = new MutationObserver(function () {
        const lowerAll = document.getElementById("lowerAllHandsBtn");
        const label = document.getElementById("raisedHandsLabel");
        if (lowerAll && label && label.classList.contains("hidden")) lowerAll.remove();
        if (lowerAll && raisedObsTarget.children.length === 0) lowerAll.remove();
      });
      mo.observe(raisedObsTarget, { childList: true });
      if (raisedObsTarget.parentNode) {
        mo.observe(raisedObsTarget.parentNode, { childList: true, subtree: true });
      }
    }

    // Notifications for raise / waiting (poll lightweight)
    let prevRaisedIds = new Set();
    let prevWaitingIds = new Set();
    setInterval(function () {
      if (!currentMeeting) return;
      const raised = (typeof raisedHands !== "undefined" && raisedHands) ? raisedHands : [];
      const waiting = (typeof waitingList !== "undefined" && waitingList) ? waitingList : [];
      raised.forEach((h) => {
        if (!prevRaisedIds.has(h.id)) {
          addNotification("raised-hand", (h.name || "Someone") + " raised their hand", { participantId: h.id });
        }
      });
      prevRaisedIds = new Set(raised.map((h) => h.id));
      waiting.forEach((w) => {
        if (!prevWaitingIds.has(w.id)) {
          addNotification("join-request", (w.name || "Someone") + " wants to join", { participantId: w.id });
        }
      });
      prevWaitingIds = new Set(waiting.map((w) => w.id));
      notifications.forEach((n) => {
        if (n.kind === "raised-hand" && n.meta.participantId && !prevRaisedIds.has(n.meta.participantId)) {
          n.attended = true;
        }
        if (n.kind === "join-request" && n.meta.participantId && !prevWaitingIds.has(n.meta.participantId)) {
          n.attended = true;
        }
      });
      const badge = $("notifUnreadBadge");
      if (badge) {
        const c = notifications.filter((x) => !x.attended).length;
        badge.textContent = String(c);
        badge.classList.toggle("hidden", c === 0);
      }
    }, 1500);

    // Improve participant sort: host, cohost, participant, guest
    // Patch rank inside renderParticipants by redefining sort if we can intercept
    // Also client-side progressive render for many users
    window.__peopleRenderLimit = window.__peopleRenderLimit || 50;
    const peopleListEl = $("participantList");
    if (peopleListEl) {
      peopleListEl.addEventListener("scroll", function () {
        if (peopleListEl.scrollTop + peopleListEl.clientHeight >= peopleListEl.scrollHeight - 48) {
          if (typeof participants !== "undefined" && window.__peopleRenderLimit < participants.length) {
            window.__peopleRenderLimit += 40;
            if (typeof renderParticipants === "function") renderParticipants();
          }
        }
      });
    }
  })();

})();
