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
    // Never kick the user out of an active meeting (mobile 3-dots History)
    const inCall = !!(currentMeeting && meetingView && !meetingView.classList.contains('hidden'));
    if (inCall && typeof window.__openDynamicPane === 'function' && window.matchMedia('(max-width: 900px)').matches) {
      window.__openDynamicPane('more', 'History');
      const pane = document.getElementById('dynPaneMore');
      if (pane) {
        pane.innerHTML = '<p class="st-empty">Loading history…</p>';
        try {
          const data = await api('/api/history');
          const items = data.history || [];
          if (!items.length) {
            pane.innerHTML = '<p class="st-empty">No past meetings.</p>';
          } else {
            const ul = document.createElement('ul');
            ul.className = 'history-list';
            items.forEach((h) => {
              const li = document.createElement('li');
              li.className = 'history-item';
              li.innerHTML = `<div class="history-item-main"><strong>${escapeHtml(h.name)}</strong>
                <span class="history-code">${escapeHtml((h.code || '').slice(0, 3))}—${escapeHtml((h.code || '').slice(3))}</span></div>`;
              ul.appendChild(li);
            });
            pane.innerHTML = '';
            pane.appendChild(ul);
          }
        } catch (e) {
          pane.innerHTML = `<p class="error-msg">${escapeHtml(e.message || 'Failed')}</p>`;
        }
      }
      return;
    }
    if (inCall) {
      historyView?.classList.remove('hidden');
      historyView.style.position = 'fixed';
      historyView.style.inset = '0';
      historyView.style.zIndex = '1400';
      historyView.style.background = 'var(--bg)';
    } else {
      homeView?.classList.add('hidden');
      meetingView?.classList.add('hidden');
      historyView?.classList.remove('hidden');
    }
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
            ${h.artifactUrl ? '<button type="button" class="btn small-btn history-artifact-btn" data-artifact-url="' + escapeHtml(h.artifactUrl) + '">View Artifacts</button>' : ''}
          </div>
        `;
        li.addEventListener('click', (ev) => {
          if (ev.target && ev.target.closest && ev.target.closest('[data-artifact-url]')) {
            ev.stopPropagation();
            const url = ev.target.closest('[data-artifact-url]').getAttribute('data-artifact-url');
            if (url) openArtifactFromPath(url);
            return;
          }
          openHistoryDetail(h.id);
        });
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
      let artBtn = document.getElementById('historyArtifactBtn');
      if (!artBtn && historyDetail) {
        artBtn = document.createElement('button');
        artBtn.id = 'historyArtifactBtn';
        artBtn.className = 'btn primary-btn';
        artBtn.style.marginTop = '0.75rem';
        historyDetail.appendChild(artBtn);
      }
      if (artBtn) {
        if (data.artifact && data.artifact.url) {
          artBtn.classList.remove('hidden');
          artBtn.textContent = 'View Artifacts';
          artBtn.onclick = () => openArtifactFromPath(data.artifact.url);
        } else {
          artBtn.classList.add('hidden');
        }
      }
    } catch (e) {
      alert(e.message);
    }
  }

  function openArtifactFromPath(path) {
    const parts = String(path).split('/').filter(Boolean);
    if (parts.length >= 3) openArtifactViewer(parts[1], parts[2]);
  }

  async function openArtifactViewer(code, slug) {
    try {
      const data = await api('/api/artifacts/' + encodeURIComponent(code) + '/' + encodeURIComponent(slug));
      const av = document.getElementById('artifactView');
      document.getElementById('homeView')?.classList.add('hidden');
      document.getElementById('meetingView')?.classList.add('hidden');
      document.getElementById('historyView')?.classList.add('hidden');
      if (av) av.classList.remove('hidden');
      const title = document.getElementById('artifactTitle');
      if (title) title.textContent = (data.meeting && data.meeting.name) || 'Meeting Artifact';
      const meta = document.getElementById('artifactMeta');
      if (meta) {
        meta.textContent = 'Code ' + (data.artifact.code || code) +
          (data.meeting && data.meeting.endedAt ? ' · Ended ' + formatDate(data.meeting.endedAt) : '') +
          (data.artifact.isLive ? ' · LIVE' : ' · Archived');
      }
      const chatEl = document.getElementById('artifactChat');
      if (chatEl) {
        chatEl.innerHTML = (data.chat || []).map(function (c) {
          return '<div class="msg"><strong>' + escapeHtml(c.senderName || 'Someone') + '</strong> ' + escapeHtml(c.body || '') + '</div>';
        }).join('') || '<p class="history-empty">No chat messages saved.</p>';
      }
      const partEl = document.getElementById('artifactParticipants');
      if (partEl) {
        partEl.innerHTML = '';
        (data.participants || []).forEach(function (p) {
          const li = document.createElement('li');
          li.textContent = p.displayName + (p.joinedAt ? ' · ' + formatDate(p.joinedAt) : '');
          partEl.appendChild(li);
        });
      }
      const recEl = document.getElementById('artifactRecordings');
      if (recEl) {
        recEl.innerHTML = '';
        (data.recordings || []).forEach(function (r) {
          const li = document.createElement('li');
          li.textContent = 'Recording #' + r.id + ' · ' + (r.status || '') + (r.fileUrl ? '' : ' (no file yet)');
          if (r.fileUrl) {
            li.innerHTML = '<a href="' + escapeHtml(r.fileUrl) + '" target="_blank" rel="noopener">Recording #' + r.id + '</a>';
          }
          recEl.appendChild(li);
        });
        if (!(data.recordings || []).length) recEl.innerHTML = '<li class="history-empty">No recordings</li>';
      }
      const notes = document.getElementById('artifactNotes');
      if (notes) notes.value = (data.note && data.note.content) || '';
      const restart = document.getElementById('artifactRestartBtn');
      if (restart) {
        restart.classList.toggle('hidden', !data.isHost);
        restart.onclick = async function () {
          try {
            const res = await api('/api/artifacts/' + encodeURIComponent(code) + '/' + encodeURIComponent(slug) + '/restart', { method: 'POST', body: '{}' });
            if (res.joinUrl) location.href = res.joinUrl;
          } catch (err) { alert(err.message); }
        };
      }
      const saveNotes = document.getElementById('artifactSaveNotes');
      if (saveNotes) {
        saveNotes.onclick = async function () {
          try {
            await api('/api/artifacts/' + encodeURIComponent(code) + '/' + encodeURIComponent(slug) + '/note', {
              method: 'POST',
              body: JSON.stringify({ content: (document.getElementById('artifactNotes') || {}).value || '' }),
            });
            if (typeof showToast === 'function') showToast('Notes saved');
          } catch (err) { alert(err.message); }
        };
      }
      const closeBtn = document.getElementById('artifactCloseBtn');
      if (closeBtn) closeBtn.onclick = function () { if (av) av.classList.add('hidden'); showHistory(); };
    } catch (e) {
      alert(e.message || 'Failed to load artifact');
    }
  }

  (function checkArtifactDeepLink() {
    const m = location.pathname.match(/^\/m\/([^/]+)\/([^/]+)\/?$/);
    if (m) setTimeout(function () { openArtifactViewer(m[1], m[2]); }, 200);
  })();

  historyBtn?.addEventListener('click', showHistory);
  historyCloseBtn?.addEventListener('click', () => {
    const inCall = !!(currentMeeting && meetingView && !meetingView.classList.contains('hidden'));
    if (inCall) {
      historyView?.classList.add('hidden');
      historyView.style.position = '';
      historyView.style.inset = '';
      historyView.style.zIndex = '';
      historyView.style.background = '';
      return;
    }
    showHome();
  });
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
      // Screen timeline must be handled here (not a fragile one-shot wrapper)
      try {
        if (msg && typeof window.__handleTimelineMsg === 'function') {
          window.__handleTimelineMsg(msg);
        }
      } catch (_) {}
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
            try { if (typeof window.__syncMobileChrome === 'function') window.__syncMobileChrome(); } catch (_) {}
          } else {
            ensureModPermissions();
          }
        }
        try { syncSharingFlagsFromLiveKit(); } catch (_) {
          renderParticipants();
          renderCards();
        }
        try { updateShareButton(); } catch (_) {}
        try { if (typeof window.__meetRefreshChatLive === 'function') window.__meetRefreshChatLive(); } catch (_) {}
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
        showToast((msg.byName || 'Host') + ' wants you to unmute', [
          { label: 'Unmute', onClick: function () {
            try {
              if (!micOn) toggleMic();
            } catch (_) {}
            try { sendWS({ type: 'unmute-self' }); } catch (_) {}
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
            try { if (typeof window.__syncMobileChrome === 'function') window.__syncMobileChrome(); } catch (_) {}
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
        appendChatMessage(msg); try { if (typeof window.__syncAllChatSurfaces === 'function') window.__syncAllChatSurfaces(); } catch (_) {}
        try {
          if (typeof window.__meetNotePublicChat === 'function') {
            window.__meetNotePublicChat(msg.text || '', msg.name || '', msg.participantId);
          }
        } catch (_) {}
        return;
      }
      if (msg.type === 'chat-history') {
        var box = $('chatMessages');
        if (box) box.innerHTML = '';
        (msg.messages || []).forEach(function (m) { appendChatMessage(m); });
        try {
          if (typeof window.__meetNotePublicChat === 'function') {
            (msg.messages || []).forEach(function (m) {
              window.__meetNotePublicChat(m.text || '', m.name || '', m.participantId);
            });
          }
        } catch (_) {}
        // Sync mobile/tablet chat surfaces so history shows without needing to send first
        try {
          if (typeof window.__syncAllChatSurfaces === 'function') window.__syncAllChatSurfaces();
        } catch (_) {}
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
        try { if (typeof window.__syncMobileChrome === 'function') window.__syncMobileChrome(); } catch (_) {}
        // Refresh timeline add controls if screenTimeline permission changed
        try {
          if (typeof window.__syncMobileChrome === 'function') window.__syncMobileChrome();
        } catch (_) {}
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
      try {
        if (room?.localParticipant) {
          await room.localParticipant.setMicrophoneEnabled(false);
        }
      } catch (_) {}
      updateMicButton();
      try { if (typeof window.__syncMobileChrome === 'function') window.__syncMobileChrome(); } catch (_) {}
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
      // No screen share is active: keep the placeholder artwork visible instead
      // of letting the empty remote video element paint over the stage.
      remoteVideo.style.display = 'none';
      remoteVideo.style.opacity = '';
      remoteVideo.srcObject = null;
      remoteVideo.classList.remove('active');
    }
    // Prefer screen-timeline image fallback instead of black / empty stage
    if (typeof window.__showSelectedTimelineImage === 'function' && window.__hasTimelineImages?.()) {
      window.__showSelectedTimelineImage();
      renderCards();
      return;
    }
    bigPlaceholder?.classList.remove('hidden');
    if (bigViewLabel) {
      bigViewLabel.textContent = '';
      bigViewLabel.classList.remove('visible');
    }
    // restore default placeholder text
    if (bigPlaceholder) {
      const p = bigPlaceholder.querySelector('p');
      if (p) p.textContent = ''; /* idle art via CSS */;
    }
    const contentView = document.getElementById('contentView');
    if (contentView) contentView.classList.add('hidden');
    const contentImage = document.getElementById('contentImage');
    if (contentImage) { contentImage.removeAttribute('src'); contentImage.classList.add('hidden'); }
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
      const msg = String((e && (e.message || e.name || e.code)) || e);
      const denied = /NotAllowedError|Permission denied|denied|PermissionDismissed|AbortError/i.test(msg + (e && e.name ? e.name : ''));
      const unsupported = /NotSupportedError|getDisplayMedia|not supported|undefined is not/i.test(msg);
      if (denied) {
        // User cancelled or blocked the browser share dialog — do not retry
        if (typeof showToast === 'function') {
          showToast('Screen share cancelled or blocked. Tap Share again and allow the browser prompt.');
        } else {
          alert('Screen share was cancelled or blocked.\n\nTap Share again, then choose a screen/window and allow it.\nIf this keeps failing, check site permissions for camera/screen in your browser settings.');
        }
        return;
      }
      if (unsupported || !canScreenShare()) {
        alert(screenShareUnsupportedMessage());
        return;
      }
      try {
        await room.localParticipant.setScreenShareEnabled(true, { audio: true });
      } catch (e2) {
        console.error(e2);
        const m2 = String((e2 && (e2.message || e2.name)) || msg);
        if (/NotAllowedError|Permission denied|denied|AbortError/i.test(m2)) {
          if (typeof showToast === 'function') showToast('Screen share blocked — allow the browser permission prompt and try again.');
          else alert('Screen share permission was blocked. Allow the browser prompt and try again.');
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
    if (micBtn) {
      micBtn.classList.toggle('active', micOn);
      micBtn.classList.toggle('off', !micOn);
      micBtn.classList.toggle('muted-state', !micOn);
      micBtn.innerHTML = micOn
        ? '<i class="fa-solid fa-microphone"></i><span>Mic</span>'
        : '<i class="fa-solid fa-microphone-slash"></i><span>Mic</span>';
      micBtn.title = micOn ? 'Mute microphone (M)' : 'Unmute microphone (M)';
    }
    try {
      const rail = document.getElementById('railMicBtn') || document.querySelector('[data-panel="media"]');
      const mediaLabel = document.getElementById('mediaMicLabel');
      const mediaToggle = document.getElementById('mediaMicToggle');
      if (mediaLabel) mediaLabel.textContent = micOn ? 'Mic on' : 'Mic off';
      if (mediaToggle) {
        mediaToggle.innerHTML = micOn
          ? '<i class="fa-solid fa-microphone"></i> <span id="mediaMicLabel">Mic on</span>'
          : '<i class="fa-solid fa-microphone-slash"></i> <span id="mediaMicLabel">Mic off</span>';
      }
      document.querySelectorAll('#stageMicBtn').forEach((b) => {
        b.innerHTML = micOn
          ? '<i class="fa-solid fa-microphone"></i>'
          : '<i class="fa-solid fa-microphone-slash"></i>';
        b.classList.toggle('muted', !micOn);
        b.title = micOn ? 'Mute' : 'Unmute';
      });
    } catch (_) {}
    // Mobile/tablet footer mic must mirror state immediately (host force-mute etc.)
    var mfnMic = document.getElementById('mfnMic');
    if (mfnMic) {
      mfnMic.classList.toggle('muted-state', !micOn);
      mfnMic.classList.toggle('off', !micOn);
      mfnMic.classList.toggle('active', micOn);
      mfnMic.innerHTML = micOn
        ? '<i class="fa-solid fa-microphone"></i>'
        : '<i class="fa-solid fa-microphone-slash"></i>';
      mfnMic.title = micOn ? 'Mute microphone' : 'Unmute microphone';
    }
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
    microphone: true, camera: true, screenShare: true, screenTimeline: true, chat: true, reactions: true, raiseHand: true,
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
        screenShare: true, screenTimeline: true, chat: true, raiseHand: true, microphone: true,
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
    try { if (typeof window.__updateNavBadges === 'function') setTimeout(window.__updateNavBadges, 0); } catch (_) {}
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
        <span class="p-name">${escapeHtml(p.name)}${p.id === myId ? ' <span class="me-tag">(you)</span>' : ''}${roleHtml}${handHtml}${muteTag}<span class="p-wave hidden" data-wave-for="${escapeHtml(p.id)}"><span></span><span></span><span></span></span></span>
        ${p.sharing ? '<span class="live-dot" title="Sharing screen" aria-label="Sharing"></span>' : ''}
      `;
      if (p.id !== myId) {
        const pm = document.createElement('button');
        pm.type = 'button';
        pm.className = 'btn icon-btn pm-btn';
        pm.title = 'Private message';
        pm.innerHTML = '<i class="fa-regular fa-envelope"></i>';
        pm.addEventListener('click', (e) => {
          e.stopPropagation();
          if (typeof window.__meetOpenDm === 'function') {
            window.__meetOpenDm(p.id, p.name, p.userId || null);
          }
        });
        li.appendChild(pm);
      }

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
          const isMobile = window.matchMedia('(max-width: 900px)').matches;
          if (isMobile) {
            // Accordion: expand actions under this participant row
            const existing = li.querySelector('.participant-accordion');
            document.querySelectorAll('.participant-accordion').forEach((acc) => {
              if (acc !== existing) acc.remove();
            });
            document.querySelectorAll('.participant-item.is-expanded').forEach((row) => {
              if (row !== li) row.classList.remove('is-expanded');
            });
            if (existing) {
              existing.remove();
              li.classList.remove('is-expanded');
              return;
            }
            li.classList.add('is-expanded');
            const panel = document.createElement('div');
            panel.className = 'participant-accordion';
            // Build actions by temporarily using menu HTML generation
            ensureModPermissions();
            const role = p.role || (p.isHost ? 'host' : 'participant');
            const hostLike = myRole === 'host' || myRole === 'cohost' || !!(currentMeeting && currentMeeting.isHost);
            let actions = [];
            if (opts && opts.waiting) {
              actions = [
                { act: 'admit', label: 'Admit', icon: 'fa-check' },
                { act: 'decline', label: 'Decline', icon: 'fa-xmark', danger: true },
              ];
            } else {
              const canMute = !!(myPermissions.muteOthers || hostLike);
              const canLower = !!(myPermissions.lowerHands || hostLike);
              const canRole = !!(myPermissions.manageRoles || myRole === 'host');
              const canRemove = !!(myPermissions.removePeople || hostLike);
              if (canMute) {
                actions.push({ act: 'mute', label: 'Mute', icon: 'fa-microphone-slash' });
                actions.push({ act: 'ask-unmute', label: 'Ask to unmute', icon: 'fa-microphone' });
              }
              if (canLower && p.handRaised) actions.push({ act: 'lower-hand', label: 'Lower hand', icon: 'fa-hand' });
              if (p.sharing && canMute) actions.push({ act: 'stop-share', label: 'Stop sharing', icon: 'fa-desktop' });
              if (canRole && role !== 'host') {
                if (role !== 'cohost') actions.push({ act: 'make-cohost', label: 'Make co-host', icon: 'fa-user-shield' });
                else actions.push({ act: 'remove-cohost', label: 'Remove co-host', icon: 'fa-user' });
              }
              if (myRole === 'host' && role !== 'host') actions.push({ act: 'transfer-host', label: 'Transfer host', icon: 'fa-crown' });
              if (canRemove && role !== 'host') actions.push({ act: 'remove', label: 'Remove', icon: 'fa-user-minus', danger: true });
              // Per-user timeline permission for host/cohost
              if (canRole && role !== 'host') {
                const pp = p.permissions || {};
                const tlOn = !!pp.screenTimeline;
                actions.push({ act: 'toggle-timeline', label: tlOn ? 'Disable timeline' : 'Allow timeline', icon: 'fa-images' });
              }
            }
            if (!actions.length) {
              panel.innerHTML = '<div class="acc-empty">No actions available</div>';
            } else {
              actions.forEach((a) => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'acc-action' + (a.danger ? ' danger' : '');
                btn.innerHTML = '<i class="fa-solid ' + a.icon + '"></i> ' + a.label;
                btn.addEventListener('click', (ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                  // Reuse openParticipantMenu path by synthesizing click on floating menu actions
                  openParticipantMenu(p, 0, 0, opts);
                  setTimeout(() => {
                    const menu = document.getElementById('participantMenu');
                    if (!menu) return;
                    if (a.act === 'toggle-timeline') {
                      const inp = menu.querySelector('input[data-perm="screenTimeline"]');
                      if (inp) {
                        inp.checked = !inp.checked;
                        inp.dispatchEvent(new Event('change', { bubbles: true }));
                      }
                      menu.classList.add('hidden');
                      panel.remove();
                      li.classList.remove('is-expanded');
                      return;
                    }
                    const target = menu.querySelector('[data-act="' + a.act + '"]');
                    if (target) target.click();
                    menu.classList.add('hidden');
                    panel.remove();
                    li.classList.remove('is-expanded');
                  }, 30);
                });
                panel.appendChild(btn);
              });
            }
            li.appendChild(panel);
            return;
          }
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
    try { if (typeof window.__updateNavBadges === 'function') setTimeout(window.__updateNavBadges, 0); } catch (_) {}
    if (!screenCards) return;
    screenCards.innerHTML = '';

    // Only cards for people currently sharing (easy switch between live screens)
    const sharingList = participants.filter(
      (p) => p.sharing || (p.id === currentMeeting?.participantId && isSharing)
    );

    // Virtual timeline "screens" — if someone uploaded images, others can pick them
    const timelineState = (typeof window.__getTimelineState === 'function') ? window.__getTimelineState() : null;
    const hasTimeline = timelineState && timelineState.items && timelineState.items.length;

    if (!sharingList.length && !hasTimeline) {
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
    // Timeline cards (one card per uploader group — show as selectable stills)
    if (hasTimeline) {
      const owners = {};
      timelineState.items.forEach((it, idx) => {
        const key = it.ownerId || 'timeline';
        if (!owners[key]) owners[key] = { name: it.ownerName || 'Timeline', items: [], firstIdx: idx };
        owners[key].items.push(it);
      });
      Object.keys(owners).forEach((key) => {
        const o = owners[key];
        const card = document.createElement('div');
        card.className = 'screen-card timeline-card sharing';
        const thumb = o.items[0]?.dataUrl;
        card.innerHTML = (thumb ? '<img class="card-thumb" src="' + thumb + '" alt="">' : '<i class="fa-solid fa-images card-icon"></i>') +
          '<span class="card-name">' + escapeHtml(o.name) + ' · images</span>';
        card.addEventListener('click', () => {
          if (typeof window.__showSelectedTimelineImage === 'function') {
            // show primarily selected or first
            const st = window.__getTimelineState();
            const idx = (st && st.selected != null) ? st.selected : o.firstIdx;
            // force show via internal API
            try {
              const slots = document.querySelectorAll('#stSlots .st-slot, #stSlotsDesktop .st-slot');
              if (slots[idx]) slots[idx].click();
              else window.__showSelectedTimelineImage();
            } catch (_) { window.__showSelectedTimelineImage(); }
          }
        });
        row.appendChild(card);
      });
    }
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
    try { startMeetingDurationTimer(); } catch (_) {}
    try {
      const ed = document.getElementById('liveNotesEditor');
      if (ed && currentMeeting) {
        const v = localStorage.getItem('meet-notes-' + currentMeeting.code);
        if (v != null) ed.value = v;
      }
    } catch (_) {}
    try {
      if (typeof window.__meetMaybeAutoRecord === 'function') setTimeout(window.__meetMaybeAutoRecord, 800);
    } catch (_) {}
    leaveBtn?.classList.remove('hidden');
    try {
      const rb = document.getElementById('rejoinBar');
      if (rb) rb.classList.add('hidden');
    } catch (_) {}
    if (meetingBadge) {
      meetingBadge.textContent = formatCode(currentMeeting.letters, currentMeeting.numbers);
      meetingBadge.classList.remove('hidden');
      meetingBadge.classList.toggle('locked', !!(securityState && securityState.locked));
    }
    copyCodeBtn?.classList.remove('hidden');
    updateMeetingChrome();

    // Mobile-first: enter fullscreen meeting UI
    try {
      document.body.classList.add('in-meeting-mobile');
      const mobileName = document.getElementById('mobileMeetName');
      if (mobileName) {
        mobileName.textContent = currentMeeting.name || formatCode(currentMeeting.letters, currentMeeting.numbers);
      }
      if (window.matchMedia('(max-width: 900px)').matches) {
        const el = document.documentElement;
        if (!document.fullscreenElement && el.requestFullscreen) {
          el.requestFullscreen().catch(() => {});
        }
      }
      if (typeof window.__syncMobileChrome === 'function') window.__syncMobileChrome();
      if (typeof window.__initScreenTimeline === 'function') window.__initScreenTimeline();
      try { if (typeof syncMoreMenuInCall === 'function') syncMoreMenuInCall(); } catch (_) {}
    } catch (_) {}

    renderParticipants();
    renderCards();
    connectWS();
    startPolling();
    await loadConfig();
    await connectLiveKit();
  }

  function resetMeetingState() {
    // Phase 1: clear leaked DOM / JS state between meetings
    try {
      var chatBox = document.getElementById('chatMessages');
      if (chatBox) chatBox.innerHTML = '';
    } catch (_) {}
    try {
      var recent = document.getElementById('recentReactions');
      if (recent) recent.innerHTML = '';
    } catch (_) {}
    try {
      document.querySelectorAll('.reaction-overlay, .flying-reaction').forEach(function (el) {
        try { el.remove(); } catch (_) {}
      });
    } catch (_) {}
    try {
      if (typeof window.__resetScreenTimeline === 'function') window.__resetScreenTimeline();
    } catch (_) {}
    try { clearBigView(); } catch (_) {}
    try {
      var notes = document.getElementById('notesEditor');
      if (notes) notes.value = '';
    } catch (_) {}
    try {
      if (typeof activityEntries !== 'undefined') activityEntries.length = 0;
    } catch (_) {}
    try {
      if (typeof recentReactions !== 'undefined') recentReactions.length = 0;
    } catch (_) {}
    try { recordingState = null; } catch (_) {}
    try {
      if (window.__meetingDurationTimer) {
        clearInterval(window.__meetingDurationTimer);
        window.__meetingDurationTimer = null;
      }
      var durEl = document.getElementById('meetingDurationTimer');
      if (durEl) { durEl.textContent = ''; durEl.classList.add('hidden'); }
    } catch (_) {}
    try {
      var badge = document.getElementById('recordingBadge');
      if (badge) badge.classList.add('hidden');
      if (window.__recTimerInterval) {
        clearInterval(window.__recTimerInterval);
        window.__recTimerInterval = null;
      }
    } catch (_) {}
    try {
      if (window.__clientRecorder) {
        try { window.__clientRecorder.stop(); } catch (_) {}
        window.__clientRecorder = null;
      }
    } catch (_) {}
    participants = [];
  }


  function startMeetingDurationTimer() {
    try {
      if (window.__meetingDurationTimer) clearInterval(window.__meetingDurationTimer);
      var el = document.getElementById('meetingDurationTimer');
      if (!el) return;
      el.classList.remove('hidden');
      el.style.display = 'inline-flex';
      var start = Date.now();
      function tick() {
        var s = Math.floor((Date.now() - start) / 1000);
        var m = Math.floor(s / 60);
        var h = Math.floor(m / 60);
        m = m % 60; s = s % 60;
        el.textContent = h > 0
          ? (h + ':' + String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0'))
          : (String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0'));
      }
      tick();
      window.__meetingDurationTimer = setInterval(tick, 1000);
    } catch (_) {}
  }

  async function leaveMeeting() {
    try {
      if (typeof window.__meetFlushRecordingOnLeave === 'function') window.__meetFlushRecordingOnLeave();
    } catch (_) {}
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
    resetMeetingState();
    currentMeeting = null;
    saveSession(null);
    clearMeetingUrl(false);

    meetingView?.classList.add('hidden');
    homeView?.classList.remove('hidden');
    leaveBtn?.classList.add('hidden');
    meetingBadge?.classList.add('hidden');
    copyCodeBtn?.classList.add('hidden');
    $('meetingNameTop')?.classList.add('hidden');
    $('shareLinkBtnTop')?.classList.add('hidden');
    document.body.classList.remove('in-meeting-mobile');
    try {
      if (document.fullscreenElement) document.exitFullscreen?.();
    } catch (_) {}
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
    // When a private/sub-group thread is open, don't mix public messages into the thread DOM
    try {
      var chId = (typeof window.__meetActiveChannelId !== 'undefined') ? window.__meetActiveChannelId : null;
      if (chId && chId !== 'everyone') return;
    } catch (_) {}
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

    // Unread badge when chat pane/tab not focused
    if (!isMe) {
      try {
        var chatFocused = false;
        var activeTab = document.querySelector('.side-tab.active');
        if (activeTab && activeTab.dataset.tab === 'chat') chatFocused = true;
        var dyn = document.getElementById('dynamicPanel');
        if (dyn && dyn.classList.contains('open') && document.getElementById('dynPaneChat') && !document.getElementById('dynPaneChat').classList.contains('hidden')) chatFocused = true;
        var sheet = document.getElementById('chatSheet');
        if (sheet && !sheet.classList.contains('hidden')) chatFocused = true;
        if (!chatFocused) {
          var badge = document.getElementById('chatUnreadBadge');
          if (badge) {
            var n = parseInt(badge.textContent, 10) || 0;
            n += 1;
            badge.textContent = String(n);
            badge.classList.remove('hidden');
          }
        }
        if (typeof window.__updateNavBadges === 'function') window.__updateNavBadges();
      } catch (_) {}
    }
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
    try {
      if (typeof window.__meetNotePublicChat === 'function') {
        var nm = (participants || []).find(function (x) { return x.id === (currentMeeting && currentMeeting.participantId); });
        window.__meetNotePublicChat(text, (nm && nm.name) || 'Me');
      }
    } catch (_) {}
  }

  function showReaction(msg) {
    const overlay = $('reactionOverlay');
    if (!overlay) return;
    // debounce identical emoji+from within 400ms to prevent doubles
    const key = String(msg.fromId || msg.from || '') + '|' + String(msg.emoji || '');
    const now = Date.now();
    if (!window.__rxDedup) window.__rxDedup = {};
    if (window.__rxDedup[key] && now - window.__rxDedup[key] < 450) return;
    window.__rxDedup[key] = now;
    const el = document.createElement('div');
    el.className = 'flying-reaction';
    const name = msg.fromName || msg.from || msg.name || '';
    el.innerHTML = '<span class="rx-emoji">' + (msg.emoji || '👍') + '</span>' +
      (name ? '<span class="rx-name">' + escapeHtml(String(name)) + '</span>' : '');
    el.style.left = (20 + Math.random() * 60) + '%';
    overlay.appendChild(el);
    setTimeout(function () { el.remove(); }, 2100);
  }

  async function forceMuteLocal(msg) {
    micOn = false;
    try { if (typeof updateMicButton === 'function') updateMicButton(); } catch (_) {}
    try {
      if (room && room.localParticipant) {
        await room.localParticipant.setMicrophoneEnabled(false);
      }
    } catch (e) { console.warn(e); }
    micOn = false;
    try { if (typeof updateMicButton === 'function') updateMicButton(); } catch (_) {}
    var who = msg.byName ? (' by ' + msg.byName) : '';
    var el = $('liveStatusText');
    if (el) el.textContent = 'Mic muted' + who;
    if (typeof showToast === 'function') showToast('You were muted' + who);
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
    const isUnmuteAsk = !!(actions && actions.length && /unmute/i.test(message || ''));
    el.className = 'toast' + (isUnmuteAsk ? ' toast-unmute-ask' : '');
    if (isUnmuteAsk) {
      el.innerHTML = `<div class="toast-line1">${escapeHtml(message)}</div><div class="toast-line2"></div>`;
      const row = el.querySelector('.toast-line2');
      actions.forEach((a) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = a.label && /unmute/i.test(a.label) ? 'toast-btn primary' : 'toast-btn';
        b.textContent = a.label;
        b.addEventListener('click', () => {
          a.onClick && a.onClick();
          el.remove();
        });
        row.appendChild(b);
      });
    } else {
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
    }
    host.appendChild(el);
    setTimeout(() => { try { el.remove(); } catch (_) {} }, isUnmuteAsk ? 12000 : 5000);
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
        html += `<label class="perm-row"><span>Screen timeline</span><input type="checkbox" data-perm="screenTimeline" ${pp.screenTimeline ? 'checked' : ''}></label>`;
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
    try { sendWS({ type: 'chat-history-request' }); } catch (_) {}
    // Sync messages from main chat
    const src = document.getElementById('chatMessages');
    const dest = document.getElementById('chatSheetMessages');
    if (src && dest) {
      dest.innerHTML = src.innerHTML;
      try { dest.scrollTop = dest.scrollHeight; } catch (_) {}
    }
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
    const bar = document.getElementById('recControlsBar');
    const statusLabel = document.getElementById('recordingStatusLabel');
    const isHost = myRole === 'host' || currentMeeting?.isHost;
    if (!badge) return;
    const active = recordingState && (recordingState.status === 'recording' || recordingState.status === 'paused');
    if (active) {
      badge.classList.remove('hidden');
      if (statusLabel) statusLabel.textContent = recordingState.status === 'paused' ? 'Paused' : 'Recording';
      if (bar) {
        bar.classList.toggle('hidden', !isHost);
        const pauseBtn = document.getElementById('recPauseBtn');
        if (pauseBtn) pauseBtn.textContent = recordingState.status === 'paused' ? 'Resume' : 'Pause';
      }
      const start = recordingState.startedAt || Date.now();
      const pausedExtra = recordingState.pausedTotalMs || 0;
      const tick = () => {
        let elapsed = Date.now() - start - pausedExtra;
        if (recordingState.status === 'paused' && recordingState.pausedAt) {
          elapsed = recordingState.pausedAt - start - pausedExtra;
        }
        const sec = Math.max(0, Math.floor(elapsed / 1000));
        const m = String(Math.floor(sec / 60)).padStart(2, '0');
        const s = String(sec % 60).padStart(2, '0');
        if (timer) timer.textContent = m + ':' + s;
      };
      tick();
      if (recordingTimerInterval) clearInterval(recordingTimerInterval);
      recordingTimerInterval = setInterval(tick, 1000);
    } else {
      badge.classList.add('hidden');
      if (bar) bar.classList.add('hidden');
      if (recordingTimerInterval) clearInterval(recordingTimerInterval);
      recordingTimerInterval = null;
    }
    // Modal buttons
    try {
      const startBtn = document.getElementById('recordStartBtn');
      const pauseM = document.getElementById('recordPauseBtnModal');
      const stopM = document.getElementById('recordStopBtnModal');
      const stateEl = document.getElementById('recordModalState');
      if (active) {
        if (startBtn) { startBtn.classList.add('hidden'); startBtn.disabled = true; }
        if (pauseM) { pauseM.classList.remove('hidden'); pauseM.textContent = recordingState.status === 'paused' ? 'Resume' : 'Pause'; }
        if (stopM) stopM.classList.remove('hidden');
        if (stateEl) stateEl.textContent = recordingState.status === 'paused' ? 'Recording is paused.' : 'Recording in progress…';
      } else {
        if (startBtn) { startBtn.classList.remove('hidden'); startBtn.disabled = false; startBtn.textContent = 'Start recording'; }
        if (pauseM) pauseM.classList.add('hidden');
        if (stopM) stopM.classList.add('hidden');
        if (stateEl) stateEl.textContent = recordingState && recordingState.status === 'stopped' ? 'Last recording saved to Artifacts / history.' : '';
      }
    } catch (_) {}
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
      // Phase 1 recording UX: reflect state on menu / modal
      try {
        var recItem = document.querySelector('.more-record');
        if (recItem) {
          if (recordingState && recordingState.status === 'recording') {
            recItem.innerHTML = '<i class="fa-solid fa-stop"></i> Stop recording';
          } else if (recordingState && recordingState.status === 'stopped') {
            recItem.innerHTML = '<i class="fa-solid fa-circle"></i> Recorded → Artifacts';
          } else {
            recItem.innerHTML = '<i class="fa-solid fa-circle"></i> Record';
          }
        }
        var startBtn = document.getElementById('recordStartBtn');
        if (startBtn && recordingState && recordingState.status === 'recording') {
          startBtn.disabled = true;
          startBtn.textContent = 'Already recording…';
        } else if (startBtn) {
          startBtn.disabled = false;
          startBtn.textContent = 'Start recording';
        }
      } catch (_) {}
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

    // Auto-rejoin when session matches URL code (no sticky rejoin bar after success)
    try {
      const sess = typeof loadSession === 'function' ? loadSession() : null;
      const pathCode = (location.pathname || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      const bar = document.getElementById('rejoinBar');
      if (bar) bar.classList.add('hidden');
      if (sess && sess.code && pathCode && sess.code === pathCode && !currentMeeting) {
        const yourName = sess.participantName || (typeof displayNameOf === 'function' ? displayNameOf(currentUser) : '');
        const urlKey = new URLSearchParams(location.search).get('key') || sessionStorage.getItem('meet-invite-' + sess.code) || undefined;
        (async function autoRejoin() {
          try {
            if (!yourName) {
              // fall back to tryRejoinFromUrl / name prompt path
              if (typeof tryRejoinFromUrl === 'function') await tryRejoinFromUrl();
              return;
            }
            const data = await api('/api/join', {
              method: 'POST',
              body: JSON.stringify({
                code: sess.code,
                participantId: sess.participantId,
                participantName: yourName,
                key: urlKey,
                device: typeof detectDevice === 'function' ? detectDevice() : undefined,
              }),
            });
            await showMeeting(data, !!sess.isHost, { participantName: yourName, replaceUrl: true });
            if (bar) bar.classList.add('hidden');
          } catch (e) {
            // Only show bar if auto-rejoin failed
            if (bar) {
              bar.classList.remove('hidden');
              const btn = document.getElementById('rejoinBtn');
              if (btn && !btn.dataset.wired) {
                btn.dataset.wired = '1';
                btn.addEventListener('click', async () => {
                  bar.classList.add('hidden');
                  try {
                    if (typeof tryRejoinFromUrl === 'function') await tryRejoinFromUrl();
                  } catch (err) {
                    showToast(err.message || 'Could not rejoin');
                  }
                });
              }
            }
          }
        })();
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
        // Inline style beats any leftover !important layout rules
        if (on) {
          p.style.display = 'flex';
          p.style.visibility = 'visible';
          p.style.height = '';
          p.style.overflow = '';
        } else {
          p.style.display = 'none';
          p.style.visibility = 'hidden';
          p.style.height = '0';
          p.style.overflow = 'hidden';
        }
      });
      if (name === "notifications") renderNotifications();
      if (name === "chat") {
        const box = $("chatMessages");
        if (box) box.scrollTop = box.scrollHeight;
        const badge = $("chatUnreadBadge");
        if (badge) { badge.textContent = "0"; badge.classList.add("hidden"); }
        try { sendWS({ type: 'chat-history-request' }); } catch (_) {}
      }
      if (name === "timeline") {
        try {
          if (typeof window.__syncMobileChrome === 'function') window.__syncMobileChrome();
          if (typeof renderCards === 'function') renderCards();
        } catch (_) {}
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


  /* =========================================================
     Mobile-first meeting UX + Screen timeline
     ========================================================= */
  (function mobileMeetUX() {
    var screenTimeline = [];
    window.__syncAllChatSurfaces = function () {
      var src = document.getElementById('chatMessages');
      if (!src) return;
      var html = src.innerHTML;
      ['dynChatMessages', 'chatSheetMessages'].forEach(function (id) {
        var el = document.getElementById(id);
        if (!el) return;
        el.innerHTML = html;
        try { el.scrollTop = el.scrollHeight; } catch (_) {}
      });
    };

    var slideshowOn = false;
    var slideshowTimer = null;
    var slideshowIdx = 0;
    var recentReactions = [];
    var activePane = 'screens';

    function isMobileLayout() {
      return window.matchMedia('(max-width: 900px)').matches;
    }

    function openDynamicPane(pane, title) {
      activePane = pane || 'screens';
      var panel = document.getElementById('dynamicPanel');
      var titleEl = document.getElementById('dynamicPanelTitle');
      if (titleEl) titleEl.textContent = title || ({
        screens: 'Screens', chat: 'Chat', people: 'People',
        reactions: 'Reactions', security: 'Security', more: 'More'
      }[activePane] || 'Panel');
      document.querySelectorAll('.dyn-pane').forEach(function (p) {
        var on = p.getAttribute('data-pane') === activePane;
        p.classList.toggle('hidden', !on);
        if (on) {
          p.style.display = '';
          p.style.visibility = '';
        } else {
          p.style.display = 'none';
          p.style.visibility = 'hidden';
        }
      });
      // Prevent people list from leaking into other panes
      if (activePane !== 'people') {
        var dp = document.getElementById('dynPanePeople');
        if (dp && activePane !== 'people') {
          dp.classList.add('hidden');
          dp.style.display = 'none';
        }
      }
      if (panel) panel.classList.add('open');
      document.querySelectorAll('.mfn-btn[data-pane]').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-pane') === activePane);
      });
      if (activePane !== 'security') {
        try { restoreSecurityBody(); } catch (_) {}
      }
      if (activePane === 'screens') refreshDynScreens();
      if (activePane === 'chat') {
        fillDynChat();
        try {
          var badge = document.getElementById('chatUnreadBadge');
          if (badge) { badge.textContent = '0'; badge.classList.add('hidden'); }
          if (typeof window.__updateNavBadges === 'function') window.__updateNavBadges();
        } catch (_) {}
      }
      if (activePane === 'people') fillDynPeople();
      if (activePane === 'more') fillDynMore();
      if (activePane === 'security') fillDynSecurity();
      if (activePane === 'reactions') renderRecentReactions();
    }
    window.__openDynamicPane = openDynamicPane;

    function closeDynamicPane() {
      var panel = document.getElementById('dynamicPanel');
      if (panel) panel.classList.remove('open');
      document.querySelectorAll('.mfn-btn[data-pane]').forEach(function (b) {
        b.classList.remove('active');
      });
    }

    // close X removed — panel stays as content surface

    function syncMobileChrome() {
      var name = document.getElementById('mobileMeetName');
      if (name && currentMeeting) {
        name.textContent = currentMeeting.name || formatCode(currentMeeting.letters, currentMeeting.numbers);
      }
      var mfnMic = document.getElementById('mfnMic');
      var mic = document.getElementById('micBtn');
      if (mfnMic && mic) {
        var muted = mic.classList.contains('off') || mic.classList.contains('muted-state');
        mfnMic.className = 'mfn-btn' + (muted ? ' muted-state' : '');
        mfnMic.innerHTML = muted
          ? '<i class="fa-solid fa-microphone-slash"></i>'
          : '<i class="fa-solid fa-microphone"></i>';
      }
      var sec = document.getElementById('securityBtn');
      var mfnSec = document.getElementById('mfnSecurity');
      if (mfnSec && sec) {
        mfnSec.classList.toggle('hidden', sec.classList.contains('hidden'));
      }
      var canEdit = canEditTimeline();
      ['stActions', 'stActionsDesktop', 'stActionsSide'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) {
          el.classList.toggle('hidden', !canEdit);
          el.classList.add('host-cohost-only');
        }
      });
      if (isMobileLayout()) {
        var panel = document.getElementById('dynamicPanel');
        if (panel && !panel.classList.contains('open')) {
          openDynamicPane('screens', 'Screens');
        }
      }
    }
    window.__syncMobileChrome = syncMobileChrome;

    document.getElementById('mfnMic')?.addEventListener('click', function () {
      document.getElementById('micBtn')?.click();
      setTimeout(syncMobileChrome, 80);
    });
    document.getElementById('mfnScreen')?.addEventListener('click', function () {
      openDynamicPane('screens', 'Screens');
    });
    document.getElementById('mfnHand')?.addEventListener('click', function () {
      /* handled by pointer long-press/tap below */
    });
    (function wireHand() {
      var btn = document.getElementById('mfnHand');
      if (!btn || btn.dataset.handWired) return;
      btn.dataset.handWired = '1';
      var longPress = false, timer = null;
      btn.addEventListener('pointerdown', function () {
        longPress = false;
        timer = setTimeout(function () {
          longPress = true;
          openRaisedHandsPanel();
        }, 420);
      });
      function end() {
        if (timer) clearTimeout(timer);
        timer = null;
        if (!longPress) document.getElementById('raiseHandBtn')?.click();
      }
      btn.addEventListener('pointerup', end);
      btn.addEventListener('pointerleave', function () { if (timer) clearTimeout(timer); timer = null; });
      btn.addEventListener('pointercancel', function () { if (timer) clearTimeout(timer); timer = null; });
    })();

    function openRaisedHandsPanel() {
      openDynamicPane('people', 'Raised hands');
      var pane = document.getElementById('dynPanePeople');
      if (!pane) return;
      var raised = (participants || []).filter(function (p) { return p.handRaised; });
      // Order: earliest raised first if raisedHands array exists
      if (Array.isArray(raisedHands) && raisedHands.length) {
        var order = {};
        raisedHands.forEach(function (h, i) {
          var id = h.participantId || h.id || h;
          order[id] = i;
        });
        raised.sort(function (a, b) {
          var ia = order[a.id];
          var ib = order[b.id];
          if (ia == null) ia = 999;
          if (ib == null) ib = 999;
          return ia - ib;
        });
      }
      var hostLike = myRole === 'host' || myRole === 'cohost' || (currentMeeting && currentMeeting.isHost);
      var html = '<div class="raised-hands-panel">';
      if (!raised.length) html += '<p class="st-empty">No raised hands</p>';
      else {
        raised.forEach(function (p) {
          html += '<div class="rh-row" data-id="' + escapeHtml(p.id) + '">' +
            '<span class="rh-name">' + escapeHtml(p.name) + '</span>';
          if (hostLike) {
            html += '<button type="button" class="btn small-btn rh-lower" data-id="' + escapeHtml(p.id) + '">Lower</button>';
          }
          html += '</div>';
        });
      }
      html += '</div>';
      pane.innerHTML = html;
      pane.querySelectorAll('.rh-lower').forEach(function (b) {
        b.addEventListener('click', function () {
          try { sendWS({ type: 'lower-hand', targetId: b.getAttribute('data-id') }); } catch (_) {}
          setTimeout(openRaisedHandsPanel, 200);
        });
      });
    }

    window.__updateNavBadges = function updateNavBadges() {
      // Screens: live shares + timeline images present
      var screenCount = 0;
      try {
        screenCount = (participants || []).filter(function (p) {
          return p.sharing || (currentMeeting && p.id === currentMeeting.participantId && typeof isSharing !== 'undefined' && isSharing);
        }).length;
        if (typeof window.__hasTimelineImages === 'function' && window.__hasTimelineImages()) {
          // count timeline as at least 1 selectable screen group
          var st = window.__getTimelineState && window.__getTimelineState();
          var owners = {};
          (st && st.items || []).forEach(function (it) { owners[it.ownerId || 't'] = 1; });
          screenCount += Object.keys(owners).length;
        }
      } catch (_) {}
      // Hands
      var handCount = 0;
      try {
        handCount = (participants || []).filter(function (p) { return p.handRaised; }).length;
      } catch (_) {}
      // People
      var peopleCount = (participants || []).length;
      // Chat unread
      var chatUnread = 0;
      try {
        var badge = document.getElementById('chatUnreadBadge');
        if (badge && !badge.classList.contains('hidden')) chatUnread = parseInt(badge.textContent, 10) || 0;
      } catch (_) {}

      function setBadge(el, n) {
        if (!el) return;
        if (n > 0) {
          el.textContent = n > 99 ? '99+' : String(n);
          el.classList.remove('hidden');
        } else {
          el.textContent = '0';
          el.classList.add('hidden');
        }
      }
      setBadge(document.getElementById('mfnScreenBadge'), screenCount);
      setBadge(document.getElementById('mfnHandBadge'), handCount);
      setBadge(document.getElementById('mfnChatBadge'), chatUnread);
      setBadge(document.getElementById('mfnPeopleBadge'), peopleCount);
      // Desktop toolbar badges if present
      setBadge(document.getElementById('toolbarScreenBadge'), screenCount);
      setBadge(document.getElementById('toolbarHandBadge'), handCount);
      setBadge(document.getElementById('toolbarChatBadge'), chatUnread);
      setBadge(document.getElementById('toolbarPeopleBadge'), peopleCount);
      // Sidebar people count already on participantCount
      var pc = document.getElementById('participantCount');
      if (pc) pc.textContent = String(peopleCount);
    };
    document.getElementById('mfnChat')?.addEventListener('click', function () {
      if (isMobileLayout()) openDynamicPane('chat', 'Chat');
      else document.getElementById('toolbarChatBtn')?.click();
    });
    document.getElementById('mfnPeople')?.addEventListener('click', function () {
      if (isMobileLayout()) openDynamicPane('people', 'People');
      else document.getElementById('toolbarPeopleBtn')?.click();
    });
    document.getElementById('mfnSecurity')?.addEventListener('click', function () {
      if (isMobileLayout()) openDynamicPane('security', 'Security');
      else document.getElementById('securityBtn')?.click();
    });
    document.getElementById('mobileMeetMoreBtn')?.addEventListener('click', function () {
      openDynamicPane('more', 'More');
    });

    (function wireHeart() {
      var btn = document.getElementById('mfnHeart');
      if (!btn) return;
      var longPress = false;
      var timer = null;
      btn.addEventListener('pointerdown', function () {
        longPress = false;
        timer = setTimeout(function () {
          longPress = true;
          openDynamicPane('reactions', 'Reactions');
        }, 420);
      });
      function endPress() {
        if (timer) clearTimeout(timer);
        timer = null;
        if (!longPress && currentMeeting) {
          try { sendWS({ type: 'reaction', emoji: '😊' }); } catch (_) {}
        }
      }
      btn.addEventListener('pointerup', endPress);
      btn.addEventListener('pointerleave', function () { if (timer) clearTimeout(timer); timer = null; });
      btn.addEventListener('pointercancel', function () { if (timer) clearTimeout(timer); timer = null; });
    })();

    document.getElementById('dynShareBtn')?.addEventListener('click', function () {
      document.getElementById('shareBtn')?.click();
    });

    function refreshDynScreens() {
      var list = document.getElementById('dynScreensList');
      if (!list) return;
      list.innerHTML = '';
      // Live screen shares
      var src = document.getElementById('screenCards');
      if (src) {
        src.querySelectorAll('.screen-card').forEach(function (c) {
          var clone = c.cloneNode(true);
          clone.addEventListener('click', function () { c.click(); });
          list.appendChild(clone);
        });
      }
      // Always surface timeline images as selectable "screen" cards for everyone
      if (screenTimeline.length) {
        var owners = {};
        screenTimeline.forEach(function (it, idx) {
          var key = it.ownerId || 'timeline';
          if (!owners[key]) owners[key] = { name: it.ownerName || 'Timeline', firstIdx: idx, thumb: it.dataUrl };
        });
        Object.keys(owners).forEach(function (key) {
          // skip if already cloned a matching timeline-card from desktop
          var already = list.querySelector('.timeline-card');
          var o = owners[key];
          var card = document.createElement('div');
          card.className = 'screen-card timeline-card sharing';
          card.innerHTML = (o.thumb ? '<img class="card-thumb" src="' + o.thumb + '" alt="">' : '<i class="fa-solid fa-images card-icon"></i>') +
            '<span class="card-name">' + escapeHtml(o.name) + ' · images</span>';
          card.addEventListener('click', function () {
            showTimelineImage(o.firstIdx);
          });
          list.appendChild(card);
        });
      }
      renderTimelineSlots();
      var canEdit = canEditTimeline();
      ['stActions', 'stActionsDesktop', 'stActionsSide'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.classList.toggle('hidden', !canEdit);
      });
      try { if (typeof window.__updateNavBadges === 'function') window.__updateNavBadges(); } catch (_) {}
    }

    function fillDynChat() {
      var pane = document.getElementById('dynPaneChat');
      if (!pane) return;
      var src = document.getElementById('chatMessages');
      // Request history so mobile sees older messages without needing to send first
      try { sendWS({ type: 'chat-history-request' }); } catch (_) {}
      pane.innerHTML = '';
      var msgs = document.createElement('div');
      msgs.className = 'chat-messages';
      msgs.id = 'dynChatMessages';
      if (src) msgs.innerHTML = src.innerHTML;
      // Scroll to bottom after paint
      setTimeout(function () { try { msgs.scrollTop = msgs.scrollHeight; } catch (_) {} }, 50);
      pane.appendChild(msgs);
      var form = document.createElement('form');
      form.className = 'chat-form';
      form.innerHTML =
        '<div class="chat-form-row chat-form-row-input">' +
        '<input type="text" id="dynChatInput" maxlength="2000" placeholder=" Message... " autocomplete="off">' +
        '<button type="submit" class="btn icon-btn chat-send-btn" title="Send"><i class="fa-solid fa-paper-plane"></i></button>' +
        '</div>' +
        '<div class="chat-form-row chat-form-row-tools">' +
        '<button type="button" class="btn icon-btn" id="dynChatImageBtn" title="Send image"><i class="fa-regular fa-image"></i></button>' +
        '<button type="button" class="btn icon-btn" id="dynChatAttachBtn" title="Attach file"><i class="fa-solid fa-paperclip"></i></button>' +
        '<button type="button" class="btn icon-btn" id="dynChatVoiceBtn" title="Voice note"><i class="fa-solid fa-microphone"></i></button>' +
        '</div>';
      pane.appendChild(form);
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var input = document.getElementById('dynChatInput');
        var mainInput = document.getElementById('chatInput');
        if (input && mainInput) {
          mainInput.value = input.value;
          var cf = document.getElementById('chatForm');
          if (cf) {
            if (typeof cf.requestSubmit === 'function') cf.requestSubmit();
            else cf.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
          }
          input.value = '';
          setTimeout(function () { if (src) msgs.innerHTML = src.innerHTML; }, 120);
        }
      });
      document.getElementById('dynChatImageBtn')?.addEventListener('click', function () {
        document.getElementById('chatImageBtn')?.click();
      });
      document.getElementById('dynChatAttachBtn')?.addEventListener('click', function () {
        document.getElementById('chatAttachBtn')?.click();
      });
      document.getElementById('dynChatVoiceBtn')?.addEventListener('click', function () {
        document.getElementById('chatVoiceBtn')?.click();
      });
    }

    function fillDynPeople() {
      var pane = document.getElementById('dynPanePeople');
      if (!pane) return;
      pane.innerHTML = '';
      // Live people UI for mobile: search + device toggle + list (works, not a dead clone)
      var toolbar = document.createElement('div');
      toolbar.className = 'tab-toolbar dyn-people-toolbar';
      toolbar.innerHTML =
        '<input type="search" id="dynPeopleSearch" class="people-search" placeholder="Search participants…" autocomplete="off">' +
        '<button type="button" id="dynDeviceToggle" class="btn icon-btn device-toggle" title="Show device icons" aria-pressed="true">' +
        '<i class="fa-solid fa-mobile-screen"></i></button>';
      pane.appendChild(toolbar);
      var list = document.createElement('ul');
      list.className = 'participant-list';
      list.id = 'dynParticipantList';
      pane.appendChild(list);

      function paint() {
        list.innerHTML = '';
        var q = (document.getElementById('dynPeopleSearch')?.value || '').trim().toLowerCase();
        var src = participants || [];
        if (q) {
          src = src.filter(function (p) {
            return String(p.name || '').toLowerCase().indexOf(q) >= 0 ||
              String(p.roleLabel || p.role || '').toLowerCase().indexOf(q) >= 0;
          });
        }
        var sorted = src.slice().sort(function (a, b) {
          var rank = function (p) {
            if (p.role === 'host' || p.isHost) return 0;
            if (p.role === 'cohost') return 1;
            if (p.role === 'guest') return 3;
            return 2;
          };
          var ra = rank(a), rb = rank(b);
          if (ra !== rb) return ra - rb;
          return String(a.name || '').localeCompare(String(b.name || ''));
        });
        var myId = currentMeeting && currentMeeting.participantId;
        sorted.forEach(function (p) {
          var li = document.createElement('li');
          li.className = 'participant-item';
          if (p.id === myId) li.classList.add('me');
          var deviceHtml = (typeof showDeviceIcons !== 'undefined' && showDeviceIcons)
            ? '<i class="fa-solid ' + (typeof deviceIcon === 'function' ? deviceIcon(p.device) : 'fa-desktop') + ' device-icon"></i>'
            : '';
          var role = p.role || (p.isHost ? 'host' : 'participant');
          li.innerHTML = deviceHtml +
            '<span class="p-name">' + escapeHtml(p.name) +
            (p.id === myId ? ' <span class="me-tag">(you)</span>' : '') +
            ' <span class="role-tag">' + escapeHtml(p.roleLabel || role) + '</span>' +
            (p.handRaised ? ' ✋' : '') +
            (p.mutedByHost ? ' <span class="host-tag">muted</span>' : '') +
            '</span>';
          var canAct = p.id !== myId && (
            (typeof canModerateNow === 'function' && canModerateNow()) ||
            (typeof isHostLike === 'function' && isHostLike()) ||
            myRole === 'host' || myRole === 'cohost'
          );
          if (canAct) {
            var more = document.createElement('button');
            more.type = 'button';
            more.className = 'btn icon-btn participant-more';
            more.innerHTML = '<i class="fa-solid fa-ellipsis"></i>';
            more.addEventListener('click', function (e) {
              e.preventDefault();
              e.stopPropagation();
              // Expand accordion under this row on mobile/tablet
              var existing = li.querySelector('.participant-accordion');
              list.querySelectorAll('.participant-accordion').forEach(function (acc) {
                if (acc !== existing) acc.remove();
              });
              if (existing) { existing.remove(); return; }
              openParticipantMenu(p, e.clientX || 40, e.clientY || 40, {});
              // Move floating menu content under the row
              setTimeout(function () {
                var menu = document.getElementById('participantMenu');
                if (!menu || menu.classList.contains('hidden')) return;
                var panel = document.createElement('div');
                panel.className = 'participant-accordion';
                panel.innerHTML = menu.innerHTML;
                menu.classList.add('hidden');
                panel.querySelectorAll('button[data-act], label.perm-row input').forEach(function (el) {
                  el.addEventListener('click', function (ev) {
                    // re-open original menu actions by matching
                    var act = el.getAttribute('data-act');
                    if (act) {
                      openParticipantMenu(p, 0, 0, {});
                      setTimeout(function () {
                        var m2 = document.getElementById('participantMenu');
                        var t = m2 && m2.querySelector('[data-act="' + act + '"]');
                        if (t) t.click();
                        if (m2) m2.classList.add('hidden');
                      }, 20);
                    }
                  });
                });
                li.appendChild(panel);
              }, 40);
            });
            li.appendChild(more);
          }
          list.appendChild(li);
        });
        if (!sorted.length) {
          list.innerHTML = '<li class="participant-item"><span class="p-name st-empty">No matches</span></li>';
        }
      }
      document.getElementById('dynPeopleSearch')?.addEventListener('input', paint);
      document.getElementById('dynDeviceToggle')?.addEventListener('click', function () {
        try {
          showDeviceIcons = !showDeviceIcons;
          this.setAttribute('aria-pressed', String(showDeviceIcons));
          var main = document.getElementById('deviceToggle');
          if (main) main.setAttribute('aria-pressed', String(showDeviceIcons));
          if (typeof renderParticipants === 'function') renderParticipants();
        } catch (_) {}
        paint();
      });
      paint();
    }

    function fillDynMore() {
      var pane = document.getElementById('dynPaneMore');
      if (!pane) return;
      pane.innerHTML = '';
      try { if (typeof syncMoreMenuInCall === 'function') syncMoreMenuInCall(); } catch (_) {}

      function meetingCodeDisplay() {
        if (!currentMeeting) return '';
        var code = currentMeeting.code || '';
        if (currentMeeting.letters && currentMeeting.numbers) {
          return String(currentMeeting.letters).toUpperCase() + '-' + String(currentMeeting.numbers);
        }
        if (code.length >= 6) return code.slice(0, 3).toUpperCase() + '-' + code.slice(3);
        return code.toUpperCase();
      }
      function inviteUrl() {
        if (!currentMeeting) return location.href;
        var code = currentMeeting.code || '';
        var formatted = code.length === 6 ? code.slice(0, 3) + '-' + code.slice(3) : code;
        var token = window.__lastInviteToken || '';
        try { token = token || sessionStorage.getItem('meet-invite-' + code) || ''; } catch (_) {}
        return token
          ? (location.origin + '/' + formatted + '?key=' + token)
          : (location.origin + '/' + formatted);
      }
      function addItem(label, icon, onClick, extraHtml) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'more-item dyn-more-btn';
        b.innerHTML = '<i class="fa-solid ' + icon + '"></i> <span class="dyn-more-label">' + label + '</span>' + (extraHtml || '');
        b.addEventListener('click', onClick);
        pane.appendChild(b);
        return b;
      }
      function addSep() {
        var s = document.createElement('div');
        s.className = 'more-sep';
        pane.appendChild(s);
      }
      function panelBackBar(titleText) {
        var bar = document.createElement('div');
        bar.className = 'dyn-back-bar';
        var back = document.createElement('button');
        back.type = 'button';
        back.className = 'btn small-btn dyn-back-btn';
        back.innerHTML = '<i class="fa-solid fa-arrow-left"></i> Back';
        back.addEventListener('click', fillDynMore);
        var h = document.createElement('h4');
        h.className = 'dyn-sub-title';
        h.textContent = titleText;
        bar.appendChild(back);
        bar.appendChild(h);
        return bar;
      }

      // Reactions
      addItem('Reactions', 'fa-heart', function () {
        openDynamicPane('reactions', 'Reactions');
      });
      addSep();

      // Copy meeting code — show actual code e.g. THN-721 then copy icon
      var codeStr = meetingCodeDisplay() || '———';
      (function () {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'more-item dyn-more-btn dyn-copy-code-btn';
        b.innerHTML =
          '<span class="dyn-code-text">' + escapeHtml(codeStr) + '</span>' +
          '<i class="fa-regular fa-copy dyn-copy-icon" aria-hidden="true"></i>';
        b.title = 'Copy meeting code';
        b.addEventListener('click', function () {
          var pretty = meetingCodeDisplay() || codeStr;
          try {
            navigator.clipboard.writeText(pretty).then(function () {
              if (typeof showToast === 'function') showToast('Code copied: ' + pretty);
            }).catch(function () {
              prompt('Copy meeting code:', pretty);
            });
          } catch (_) {
            prompt('Copy meeting code:', pretty);
          }
        });
        pane.appendChild(b);
      })();

      // Share invite link — native share when available
      addItem('Share invite link', 'fa-share-nodes', function () {
        var url = inviteUrl();
        var title = (currentMeeting && currentMeeting.name) ? currentMeeting.name : 'Join my meeting';
        var text = 'Join the meeting' + (codeStr ? ' (' + codeStr + ')' : '');
        if (navigator.share) {
          navigator.share({ title: title, text: text, url: url }).catch(function () {});
        } else {
          // Fallback panel with copy + open
          pane.innerHTML = '';
          pane.appendChild(panelBackBar('Share invite'));
          var box = document.createElement('div');
          box.className = 'dyn-share-box';
          box.innerHTML =
            '<p class="dyn-share-url">' + escapeHtml(url) + '</p>' +
            '<button type="button" class="btn primary-btn full-width" id="dynCopyInvite"><i class="fa-regular fa-copy"></i> Copy link</button>';
          pane.appendChild(box);
          document.getElementById('dynCopyInvite')?.addEventListener('click', function () {
            try {
              navigator.clipboard.writeText(url).then(function () {
                if (typeof showToast === 'function') showToast('Link copied');
              });
            } catch (_) { prompt('Copy invite link:', url); }
          });
        }
      });
      addSep();

      // Connection — open in dynamic panel
      addItem('Connection', 'fa-signal', function () {
        pane.innerHTML = '';
        pane.appendChild(panelBackBar('Connection'));
        var live = document.getElementById('liveStatusText');
        var status = document.createElement('p');
        status.className = 'dyn-conn-status';
        status.textContent = (live && live.textContent) || 'Checking…';
        pane.appendChild(status);
        var diagBody = document.querySelector('#diagDrawer .drawer-body');
        if (diagBody) {
          var clone = diagBody.cloneNode(true);
          clone.querySelectorAll('[id]').forEach(function (el) { el.removeAttribute('id'); });
          pane.appendChild(clone);
        } else {
          var hint = document.createElement('p');
          hint.className = 'st-empty';
          hint.textContent = 'Connection details will appear here while you are in a call.';
          pane.appendChild(hint);
        }
        // Refresh diagnostics if available (without leaving panel)
        try {
          if (typeof openDrawer === 'function') {
            // touch openDiag internals by clicking then immediately hiding drawer
            var drawer = document.getElementById('diagDrawer');
            document.getElementById('moreConnectionBtn')?.click();
            if (drawer) {
              drawer.classList.add('hidden');
              drawer.setAttribute('aria-hidden', 'true');
            }
          }
        } catch (_) {}
        // Re-read status after a tick
        setTimeout(function () {
          var live2 = document.getElementById('liveStatusText');
          if (live2 && status) status.textContent = live2.textContent || status.textContent;
          var diagBody2 = document.querySelector('#diagDrawer .drawer-body');
          if (diagBody2 && !pane.querySelector('.drawer-body, .diag-body, .dyn-diag-clone')) {
            var c2 = diagBody2.cloneNode(true);
            c2.classList.add('dyn-diag-clone');
            c2.querySelectorAll('[id]').forEach(function (el) { el.removeAttribute('id'); });
            pane.appendChild(c2);
          }
        }, 200);
      });

      // Activity — open in dynamic panel
      addItem('Activity', 'fa-list', function () {
        pane.innerHTML = '';
        pane.appendChild(panelBackBar('Meeting activity'));
        var listWrap = document.createElement('div');
        listWrap.className = 'dyn-activity-wrap';
        listWrap.innerHTML = '<p class="st-empty">Loading activity…</p>';
        pane.appendChild(listWrap);
        (async function () {
          try {
            if (typeof loadActivity === 'function') await loadActivity();
          } catch (_) {}
          var srcList = document.getElementById('activityList');
          listWrap.innerHTML = '';
          if (srcList && srcList.children.length) {
            var clone = srcList.cloneNode(true);
            clone.removeAttribute('id');
            listWrap.appendChild(clone);
          } else {
            listWrap.innerHTML = '<p class="st-empty">No activity yet.</p>';
          }
        })();
      });

      // Record — open controls in dynamic panel
      addItem('Record', 'fa-circle', function () {
        pane.innerHTML = '';
        pane.appendChild(panelBackBar('Record meeting'));
        var isRec = !!(typeof recordingState !== 'undefined' && recordingState && recordingState.status === 'recording');
        var wrap = document.createElement('div');
        wrap.className = 'dyn-record-wrap';
        if (isRec) {
          wrap.innerHTML =
            '<p class="dyn-rec-live"><span class="rec-dot"></span> Recording in progress</p>' +
            '<button type="button" class="btn danger-btn full-width" id="dynStopRec"><i class="fa-solid fa-stop"></i> Stop recording</button>';
          pane.appendChild(wrap);
          document.getElementById('dynStopRec')?.addEventListener('click', function () {
            try { sendWS({ type: 'stop-recording' }); } catch (_) {}
            if (typeof showToast === 'function') showToast('Stopping recording…');
            setTimeout(fillDynMore, 400);
          });
        } else {
          // Pull options from record modal if present
          var modal = document.getElementById('recordModal');
          var opts = document.createElement('div');
          opts.className = 'dyn-record-opts';
          opts.innerHTML =
            '<label class="checkbox-label"><input type="checkbox" id="dynRecAudio" checked> Audio</label>' +
            '<label class="checkbox-label"><input type="checkbox" id="dynRecVideo" checked> Video</label>' +
            '<label class="checkbox-label"><input type="checkbox" id="dynRecScreen" checked> Screen share</label>' +
            '<label class="checkbox-label"><input type="checkbox" id="dynRecChat"> Chat</label>' +
            '<button type="button" class="btn primary-btn full-width" id="dynStartRec"><i class="fa-solid fa-circle"></i> Start recording</button>';
          // Sync from modal if exists
          try {
            if (document.getElementById('recAudio')) document.getElementById('dynRecAudio').checked = !!document.getElementById('recAudio').checked;
            if (document.getElementById('recVideo')) document.getElementById('dynRecVideo').checked = !!document.getElementById('recVideo').checked;
            if (document.getElementById('recScreen')) document.getElementById('dynRecScreen').checked = !!document.getElementById('recScreen').checked;
            if (document.getElementById('recChat')) document.getElementById('dynRecChat').checked = !!document.getElementById('recChat').checked;
          } catch (_) {}
          pane.appendChild(opts);
          document.getElementById('dynStartRec')?.addEventListener('click', function () {
            try {
              sendWS({
                type: 'start-recording',
                audio: !!document.getElementById('dynRecAudio')?.checked,
                video: !!document.getElementById('dynRecVideo')?.checked,
                screenShare: !!document.getElementById('dynRecScreen')?.checked,
                chat: !!document.getElementById('dynRecChat')?.checked,
              });
              if (typeof showToast === 'function') showToast('Recording started');
            } catch (_) {}
            setTimeout(fillDynMore, 400);
          });
        }
      });

      // Invite — open in dynamic panel
      addItem('Invite', 'fa-user-plus', function () {
        pane.innerHTML = '';
        pane.appendChild(panelBackBar('Invite people'));
        var url = inviteUrl();
        var box = document.createElement('div');
        box.className = 'dyn-invite-box';
        box.innerHTML =
          '<label class="dyn-field-label">Invite link</label>' +
          '<input type="text" class="dyn-invite-input" id="dynInviteInput" readonly value="' + escapeHtml(url) + '">' +
          '<div class="dyn-invite-actions">' +
          '<button type="button" class="btn primary-btn" id="dynInviteCopy"><i class="fa-regular fa-copy"></i> Copy</button>' +
          '<button type="button" class="btn" id="dynInviteShare"><i class="fa-solid fa-share-nodes"></i> Share</button>' +
          '</div>';
        pane.appendChild(box);
        document.getElementById('dynInviteCopy')?.addEventListener('click', function () {
          try {
            navigator.clipboard.writeText(url).then(function () {
              if (typeof showToast === 'function') showToast('Link copied');
            });
          } catch (_) { prompt('Copy invite link:', url); }
        });
        document.getElementById('dynInviteShare')?.addEventListener('click', function () {
          var title = (currentMeeting && currentMeeting.name) ? currentMeeting.name : 'Join my meeting';
          if (navigator.share) {
            navigator.share({ title: title, text: 'Join the meeting', url: url }).catch(function () {});
          } else {
            try {
              navigator.clipboard.writeText(url).then(function () {
                if (typeof showToast === 'function') showToast('Link copied');
              });
            } catch (_) {}
          }
        });
      });
      addSep();

      addItem('Theme', 'fa-moon', function () {
        document.querySelector('#moreMenu [data-action="theme"]')?.click();
      });
      addItem('Fullscreen', 'fa-expand', function () {
        document.querySelector('#moreMenu [data-action="fullscreen"]')?.click()
          || document.getElementById('fullscreenBtn')?.click();
      });
      addItem('History', 'fa-clock-rotate-left', function () {
        showHistory();
      });
      addSep();

      // Media quality — 3 lines with styled selects
      var qWrap = document.createElement('div');
      qWrap.className = 'dyn-quality';
      qWrap.innerHTML = '<div class="dyn-quality-title">Media quality</div>';
      var origSend = document.getElementById('sendQualitySelect');
      var origView = document.getElementById('viewQualitySelect');
      if (origSend) {
        var row1 = document.createElement('div');
        row1.className = 'dyn-quality-row';
        var lab1 = document.createElement('span');
        lab1.className = 'dyn-quality-label';
        lab1.textContent = 'Your screen';
        var sel = document.createElement('select');
        sel.className = 'dyn-quality-select';
        sel.id = 'dynSendQuality';
        sel.innerHTML = origSend.innerHTML;
        sel.value = origSend.value;
        sel.addEventListener('change', function () {
          origSend.value = sel.value;
          origSend.dispatchEvent(new Event('change', { bubbles: true }));
        });
        row1.appendChild(lab1);
        row1.appendChild(sel);
        qWrap.appendChild(row1);
      }
      if (origView) {
        var row2 = document.createElement('div');
        row2.className = 'dyn-quality-row';
        var lab2 = document.createElement('span');
        lab2.className = 'dyn-quality-label';
        lab2.textContent = 'Incoming';
        var sel2 = document.createElement('select');
        sel2.className = 'dyn-quality-select';
        sel2.id = 'dynViewQuality';
        sel2.innerHTML = origView.innerHTML;
        sel2.value = origView.value;
        sel2.addEventListener('change', function () {
          origView.value = sel2.value;
          origView.dispatchEvent(new Event('change', { bubbles: true }));
        });
        row2.appendChild(lab2);
        row2.appendChild(sel2);
        qWrap.appendChild(row2);
      }
      pane.appendChild(qWrap);
      addSep();

      var inCall = !!currentMeeting;
      if (inCall) {
        addItem('Leave call', 'fa-right-from-bracket', function () {
          document.getElementById('leaveBtn')?.click() || document.querySelector('#moreMenu [data-action="leave"]')?.click();
        });
        if (currentMeeting.isHost || myRole === 'host' || myRole === 'cohost') {
          addItem('End for everyone', 'fa-phone-slash', function () {
            document.querySelector('#moreMenu [data-action="end-meeting"]')?.click()
              || document.getElementById('endMeetBtn')?.click();
          });
        }
      }
      var loginBtn = document.querySelector('#moreMenu [data-action="login"]');
      var signupBtn = document.querySelector('#moreMenu [data-action="signup"]');
      var logoutBtn = document.querySelector('#moreMenu [data-action="logout"]');
      if (loginBtn && !loginBtn.classList.contains('hidden')) {
        addItem('Log in', 'fa-right-to-bracket', function () { loginBtn.click(); });
      }
      if (signupBtn && !signupBtn.classList.contains('hidden')) {
        addItem('Sign up', 'fa-user-plus', function () { signupBtn.click(); });
      }
      if (logoutBtn && !logoutBtn.classList.contains('hidden')) {
        addItem('Log out', 'fa-right-from-bracket', function () { logoutBtn.click(); });
      }
    }

    function fillDynLine1More() {
      // Alias: line1 3dots uses same rich more content
      fillDynMore();
    }

    function fillDynSecurity() {
      var pane = document.getElementById('dynPaneSecurity');
      if (!pane) return;
      document.body.classList.add('sec-in-panel');
      // Apply current security state onto the real form first
      try {
        if (typeof applySecurityToForm === 'function') applySecurityToForm(securityState);
      } catch (_) {}
      pane.innerHTML = '';
      var drawerBody = document.querySelector('#securityDrawer .drawer-body');
      if (!drawerBody) {
        pane.innerHTML = '<p class="st-empty">Security controls unavailable.</p>';
        return;
      }
      // Deep clone preserving checkbox checked state from the live form
      var clone = drawerBody.cloneNode(true);
      clone.querySelectorAll('input[type="checkbox"]').forEach(function (inp) {
        var orig = document.getElementById(inp.id);
        if (orig) {
          inp.checked = !!orig.checked;
          if (inp.checked) inp.setAttribute('checked', 'checked');
          else inp.removeAttribute('checked');
          // Wire changes back to original so existing listeners fire
          inp.addEventListener('change', function () {
            orig.checked = inp.checked;
            orig.dispatchEvent(new Event('change', { bubbles: true }));
          });
        }
        // Avoid duplicate IDs in the panel clone
        if (inp.id) inp.id = 'dyn_' + inp.id;
      });
      clone.querySelectorAll('[id]').forEach(function (el) {
        if (el.tagName === 'INPUT') return;
        el.removeAttribute('id');
      });
      pane.appendChild(clone);
    }

    function restoreSecurityBody() {
      document.body.classList.remove('sec-in-panel');
    }

    function noteReaction(from, emoji) {
      recentReactions.unshift({ from: from || 'Someone', emoji: emoji || '😊', t: Date.now() });
      if (recentReactions.length > 20) recentReactions.length = 20;
      if (activePane === 'reactions') renderRecentReactions();
    }
    function renderRecentReactions() {
      var el = document.getElementById('recentReactions');
      if (!el) return;
      if (!recentReactions.length) {
        el.innerHTML = '<p class="st-empty">Recent reactions will appear here</p>';
        return;
      }
      el.innerHTML = recentReactions.slice(0, 12).map(function (r) {
        return '<div class="recent-reaction-item"><span>' + r.emoji + '</span><span>' + escapeHtml(r.from) + '</span></div>';
      }).join('');
    }
    document.querySelectorAll('#dynEmojiBar .emoji-btn, #emojiBar .emoji-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var emoji = btn.getAttribute('data-emoji');
        if (emoji && currentMeeting) noteReaction(currentMeeting.participantName || 'You', emoji);
      });
    });

    function toWebpDataUrl(file, maxW, quality) {
      return new Promise(function (resolve, reject) {
        var img = new Image();
        var url = URL.createObjectURL(file);
        img.onload = function () {
          var w = img.width, h = img.height;
          var scale = Math.min(1, (maxW || 1280) / w);
          var canvas = document.createElement('canvas');
          canvas.width = Math.round(w * scale);
          canvas.height = Math.round(h * scale);
          var ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          URL.revokeObjectURL(url);
          try { resolve(canvas.toDataURL('image/webp', quality || 0.82)); }
          catch (e) { resolve(canvas.toDataURL('image/jpeg', quality || 0.82)); }
        };
        img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Image load failed')); };
        img.src = url;
      });
    }

    function canEditTimeline() {
      if (!currentMeeting) return false;
      if (currentMeeting.isHost || myRole === 'host' || myRole === 'cohost') return true;
      try {
        if (myPermissions && myPermissions.screenTimeline === true) return true;
      } catch (_) {}
      // Roster may carry resolved permissions after reload
      try {
        var me = (participants || []).find(function (p) {
          return currentMeeting && p.id === currentMeeting.participantId;
        });
        if (me && me.permissions && me.permissions.screenTimeline === true) {
          myPermissions = Object.assign({}, myPermissions || {}, me.permissions);
          return true;
        }
      } catch (_) {}
      return false;
    }

    function renderTimelineSlots() {
      ['stSlots', 'stSlotsDesktop', 'stSlotsSide'].forEach(function (id) {
        var slots = document.getElementById(id);
        if (!slots) return;
        slots.innerHTML = '';
        if (!screenTimeline.length) {
          var empty = document.createElement('p');
          empty.className = 'st-empty';
          empty.textContent = 'No timeline images yet. Hosts can add up to 10.';
          slots.appendChild(empty);
          return;
        }
        screenTimeline.forEach(function (item, idx) {
          var div = document.createElement('div');
          div.className = 'st-slot' + (idx === slideshowIdx ? ' active' : '');
          div.innerHTML = '<img src="' + item.dataUrl + '" alt="Timeline">' +
            (canEditTimeline() ? '<button type="button" class="st-remove" data-id="' + item.id + '" title="Remove">&times;</button>' : '');
          div.addEventListener('click', function (e) {
            if (e.target.classList.contains('st-remove')) return;
            var sync = isHostOrCohost() && !!slideshowOn;
            showTimelineImage(idx, { silent: !sync, sync: sync });
          });
          slots.appendChild(div);
        });
        slots.querySelectorAll('.st-remove').forEach(function (btn) {
          btn.addEventListener('click', function (e) {
            e.stopPropagation();
            removeTimelineImage(btn.getAttribute('data-id'));
          });
        });
      });
    }

    var _lastShownTimelineId = null;
    var _selectBroadcastTimer = null;
    function showTimelineImage(idx, opts) {
      opts = opts || {};
      if (!screenTimeline[idx]) return;
      var item = screenTimeline[idx];
      // Skip redundant redraw of the same image (stops glitch flicker)
      if (!opts.force && item.id && item.id === _lastShownTimelineId && slideshowIdx === idx) {
        return;
      }
      slideshowIdx = idx;
      _lastShownTimelineId = item.id || null;
      var img = document.getElementById('contentImage');
      var placeholder = document.getElementById('bigPlaceholder');
      var contentView = document.getElementById('contentView');
      var remoteVideo = document.getElementById('remoteVideo');
      var lkVid = document.getElementById('lkScreenVideo');
      if (remoteVideo) {
        remoteVideo.classList.add('hidden');
        remoteVideo.style.display = 'none';
      }
      if (lkVid) lkVid.style.display = 'none';
      if (contentView) contentView.classList.remove('hidden');
      if (img) {
        // Only reset src when the image actually changes
        if (img.getAttribute('src') !== item.dataUrl) {
          img.src = item.dataUrl;
        }
        img.classList.remove('hidden');
        img.classList.add('timeline-zoomable');
        if (!opts.keepZoom) {
          img.style.transform = 'scale(1)';
          img.dataset.zoom = '1';
        }
      }
      if (placeholder) placeholder.classList.add('hidden');
      ['contentFrame', 'pdfCanvasWrap', 'localMediaVideo'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.classList.add('hidden');
      });
      var label = document.getElementById('bigViewLabel');
      if (label) {
        var n = screenTimeline.length;
        label.textContent = (item.ownerName || 'Timeline') + ' · ' + (idx + 1) + '/' + n;
        label.classList.add('visible');
      }
      ensureTimelineNav();
      renderTimelineSlots();
      try { if (typeof renderCards === 'function') renderCards(); } catch (_) {}
      try { if (typeof window.__updateNavBadges === 'function') window.__updateNavBadges(); } catch (_) {}
      // Sync to others ONLY when a host/cohost drives the show with slideshow ON.
      // Everyone else's left/right is local-only (opts.silent or no broadcast).
      var shouldSync = !opts.silent && !!opts.sync;
      if (!shouldSync && !opts.silent) {
        // Convenience: auto-sync if host/cohost and slideshow is running
        try {
          shouldSync = !!slideshowOn && (myRole === 'host' || myRole === 'cohost' ||
            (currentMeeting && (currentMeeting.isHost || currentMeeting.role === 'host' || currentMeeting.role === 'cohost')));
        } catch (_) { shouldSync = false; }
      }
      if (shouldSync) {
        if (_selectBroadcastTimer) clearTimeout(_selectBroadcastTimer);
        _selectBroadcastTimer = setTimeout(function () {
          try { sendWS({ type: 'screen-timeline-select', index: slideshowIdx }); } catch (_) {}
        }, 80);
      }
    }

    function isHostOrCohost() {
      try {
        return myRole === 'host' || myRole === 'cohost' ||
          !!(currentMeeting && (currentMeeting.isHost || currentMeeting.role === 'host' || currentMeeting.role === 'cohost'));
      } catch (_) { return false; }
    }

    /** Navigate timeline. Local-only unless host/cohost with slideshow on. */
    function navigateTimeline(delta) {
      if (!screenTimeline.length) return;
      var next = (slideshowIdx + delta + screenTimeline.length) % screenTimeline.length;
      var sync = isHostOrCohost() && !!slideshowOn;
      showTimelineImage(next, { silent: !sync, sync: sync });
    }

    function ensureTimelineNav() {
      var big = document.getElementById('bigView');
      if (!big) return;
      var nav = document.getElementById('timelineNav');
      if (!nav) {
        nav = document.createElement('div');
        nav.id = 'timelineNav';
        nav.className = 'timeline-nav';
        nav.innerHTML =
          '<button type="button" class="tn-btn tn-prev" aria-label="Previous"><i class="fa-solid fa-chevron-left"></i></button>' +
          '<button type="button" class="tn-btn tn-next" aria-label="Next"><i class="fa-solid fa-chevron-right"></i></button>';
        big.appendChild(nav);
        nav.querySelector('.tn-prev').addEventListener('click', function (e) {
          e.stopPropagation();
          navigateTimeline(-1);
        });
        nav.querySelector('.tn-next').addEventListener('click', function (e) {
          e.stopPropagation();
          navigateTimeline(1);
        });
      }
      nav.style.display = screenTimeline.length > 1 ? 'flex' : 'none';

      // Swipe + keyboard + pinch-ish zoom (double-tap / click cycle)
      var img = document.getElementById('contentImage');
      if (img && !img.dataset.tlGestures) {
        img.dataset.tlGestures = '1';
        var touchX = 0;
        img.addEventListener('touchstart', function (e) {
          if (e.touches && e.touches[0]) touchX = e.touches[0].clientX;
        }, { passive: true });
        img.addEventListener('touchend', function (e) {
          if (!e.changedTouches || !e.changedTouches[0]) return;
          var dx = e.changedTouches[0].clientX - touchX;
          if (Math.abs(dx) < 40 || screenTimeline.length < 2) return;
          if (dx < 0) navigateTimeline(1);
          else navigateTimeline(-1);
        }, { passive: true });
        img.addEventListener('dblclick', function (e) {
          e.preventDefault();
          var z = parseFloat(img.dataset.zoom || '1');
          z = z >= 2.5 ? 1 : (z >= 1.5 ? 2.5 : 1.5);
          img.dataset.zoom = String(z);
          img.style.transform = 'scale(' + z + ')';
          img.style.cursor = z > 1 ? 'zoom-out' : 'zoom-in';
        });
        if (!window.__timelineKeysWired) {
          window.__timelineKeysWired = true;
          document.addEventListener('keydown', function (e) {
            if (!currentMeeting || !screenTimeline.length) return;
            if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable)) return;
            // Space: pause slideshow (host/cohost turns it off for everyone)
            if (e.code === 'Space' || e.key === ' ') {
              if (slideshowOn) {
                e.preventDefault();
                slideshowOn = false;
                stopSlideshow();
                document.querySelectorAll('#stSlideshowToggle, #stSlideshowToggleDesktop, #stSlideshowToggleSide').forEach(function (x) {
                  x.checked = false;
                });
                if (isHostOrCohost()) {
                  try { sendWS({ type: 'screen-timeline-slideshow', on: false }); } catch (_) {}
                }
                if (typeof showToast === 'function') showToast('Slideshow paused');
              }
              return;
            }
            if (e.key === 'ArrowLeft') {
              e.preventDefault();
              navigateTimeline(-1);
            } else if (e.key === 'ArrowRight') {
              e.preventDefault();
              navigateTimeline(1);
            }
          });
        }
      }
    }

    function startSlideshow() {
      stopSlideshow();
      if (!slideshowOn || screenTimeline.length < 2) return;
      // Only host/cohost runs the "driver" timer that syncs everyone.
      // Participants follow via screen-timeline-select; if they somehow have slideshowOn
      // without being host, advance locally without broadcasting.
      slideshowTimer = setInterval(function () {
        if (!slideshowOn || screenTimeline.length < 2) {
          stopSlideshow();
          return;
        }
        var next = (slideshowIdx + 1) % screenTimeline.length;
        var sync = isHostOrCohost();
        showTimelineImage(next, { silent: !sync, sync: sync });
      }, 5000);
    }
    function stopSlideshow() {
      if (slideshowTimer) {
        clearInterval(slideshowTimer);
        slideshowTimer = null;
      }
    }

    async function addTimelineImages(fileList) {
      if (!canEditTimeline()) {
        if (typeof showToast === 'function') showToast('You do not have permission to add timeline images');
        return;
      }
      if (!currentMeeting) return;
      var files = Array.from(fileList || []).filter(function (f) { return f.type.indexOf('image/') === 0; });
      var room = 10 - screenTimeline.length;
      if (room <= 0) { alert('Max 10 timeline images. Remove one to add another.'); return; }
      files = files.slice(0, room);
      var sent = 0;
      for (var i = 0; i < files.length; i++) {
        try {
          // Smaller payload so WS broadcast succeeds on mobile networks
          var dataUrl = await toWebpDataUrl(files[i], 960, 0.72);
          if (dataUrl && dataUrl.length > 900000) {
            dataUrl = await toWebpDataUrl(files[i], 720, 0.62);
          }
          var item = {
            id: 'st-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
            dataUrl: dataUrl,
            ownerId: currentMeeting.participantId,
            ownerName: currentMeeting.participantName || 'Host'
          };
          screenTimeline.push(item);
          var payload = { type: 'screen-timeline-add', item: { id: item.id, dataUrl: item.dataUrl, ownerId: item.ownerId, ownerName: item.ownerName } };
          if (ws && ws.readyState === 1) {
            try {
              ws.send(JSON.stringify(payload));
              sent++;
            } catch (err) {
              console.warn('[timeline] send failed', err);
              if (typeof showToast === 'function') showToast('Could not send image to others (connection issue)');
            }
          } else {
            console.warn('[timeline] WS not connected; image is local only until reconnect');
            if (typeof showToast === 'function') showToast('Not connected — image saved locally only');
          }
        } catch (e) { console.warn('timeline image failed', e); }
      }
      renderTimelineSlots();
      try { if (typeof renderCards === 'function') renderCards(); } catch (_) {}
      refreshDynScreens();
      // Stay on the first newly added image (or current) — do not cycle through batch
      if (screenTimeline.length) {
        var startIdx = Math.max(0, screenTimeline.length - Math.max(sent, files.length));
        if (_lastShownTimelineId == null) showTimelineImage(startIdx, { silent: true });
        else renderTimelineSlots();
      }
      if (slideshowOn) startSlideshow(); else stopSlideshow();
      if (sent && typeof showToast === 'function') showToast(sent === 1 ? 'Image shared to meeting' : sent + ' images shared');
    }

    function removeTimelineImage(id) {
      if (!canEditTimeline()) return;
      screenTimeline = screenTimeline.filter(function (x) { return x.id !== id; });
      try { sendWS({ type: 'screen-timeline-remove', id: id }); } catch (_) {}
      if (slideshowIdx >= screenTimeline.length) slideshowIdx = Math.max(0, screenTimeline.length - 1);
      renderTimelineSlots();
      if (screenTimeline.length) showTimelineImage(slideshowIdx);
      else {
        var img = document.getElementById('contentImage');
        if (img) { img.removeAttribute('src'); img.classList.add('hidden'); }
        document.getElementById('bigPlaceholder')?.classList.remove('hidden');
        document.getElementById('contentView')?.classList.add('hidden');
        stopSlideshow();
      }
    }

    function wireTimelineInputs() {
      function bind(btnId, inputId) {
        var btn = document.getElementById(btnId);
        var input = document.getElementById(inputId);
        if (!btn || !input) return;
        btn.addEventListener('click', function () { input.click(); });
        input.addEventListener('change', function () {
          if (input.files && input.files.length) addTimelineImages(input.files);
          input.value = '';
        });
      }
      bind('stAddImagesBtn', 'stImageInput');
      bind('stAddImagesBtnDesktop', 'stImageInputDesktop');
      bind('stAddImagesBtnSide', 'stImageInputSide');
      function bindToggle(id) {
        var t = document.getElementById(id);
        if (!t) return;
        t.addEventListener('change', function () {
          slideshowOn = !!t.checked;
          document.querySelectorAll('#stSlideshowToggle, #stSlideshowToggleDesktop, #stSlideshowToggleSide').forEach(function (x) {
            if (x !== t) x.checked = slideshowOn;
          });
          if (slideshowOn) {
            startSlideshow();
            // Align everyone to current slide when host starts the show
            if (isHostOrCohost()) {
              try { sendWS({ type: 'screen-timeline-slideshow', on: true }); } catch (_) {}
              try { sendWS({ type: 'screen-timeline-select', index: slideshowIdx }); } catch (_) {}
            } else {
              try { sendWS({ type: 'screen-timeline-slideshow', on: true }); } catch (_) {}
            }
          } else {
            stopSlideshow();
            try { sendWS({ type: 'screen-timeline-slideshow', on: false }); } catch (_) {}
          }
        });
      }
      bindToggle('stSlideshowToggle');
      bindToggle('stSlideshowToggleDesktop');
      bindToggle('stSlideshowToggleSide');
    }
    wireTimelineInputs();

    window.__initScreenTimeline = function () {
      screenTimeline = [];
      slideshowOn = false;
      slideshowIdx = 0;
      stopSlideshow();
      renderTimelineSlots();
      syncMobileChrome();
      // Ask server for current timeline after join/rejoin (covers missed register race)
      setTimeout(function () {
        try { sendWS({ type: 'screen-timeline-request' }); } catch (_) {}
      }, 500);
    };
    window.__resetScreenTimeline = function () {
      screenTimeline = [];
      stopSlideshow();
      renderTimelineSlots();
    };
    window.__hasTimelineImages = function () { return screenTimeline.length > 0; };
    window.__showSelectedTimelineImage = function () {
      if (!screenTimeline.length) return false;
      showTimelineImage(slideshowIdx);
      return true;
    };
    window.__getTimelineState = function () {
      return { items: screenTimeline.slice(), selected: slideshowIdx, slideshow: slideshowOn };
    };

    function handleTimelineMsg(msg) {
      if (!msg || !msg.type) return false;
      if (msg.type === 'screen-timeline-add' && msg.item) {
        if (!screenTimeline.some(function (x) { return x.id === msg.item.id; })) {
          var wasEmpty = screenTimeline.length === 0;
          screenTimeline.push(msg.item);
          if (screenTimeline.length > 10) screenTimeline = screenTimeline.slice(-10);
          renderTimelineSlots();
          try { if (typeof renderCards === 'function') renderCards(); } catch (_) {}
          refreshDynScreens();
          // Only auto-display the FIRST image. Extra images stay available on the card/slots —
          // do not jump index (that looked like a hyper slideshow when slideshow is off).
          var liveShare = false;
          try { liveShare = (participants || []).some(function (p) { return p.sharing; }) || !!isSharing; } catch (_) {}
          if (wasEmpty && !liveShare) {
            showTimelineImage(0, { silent: true });
          } else {
            // Keep current view stable; just refresh slot highlights
            renderTimelineSlots();
          }
        }
        return true;
      }
      if (msg.type === 'screen-timeline-remove' && msg.id) {
        var removedCurrent = screenTimeline[slideshowIdx] && screenTimeline[slideshowIdx].id === msg.id;
        screenTimeline = screenTimeline.filter(function (x) { return x.id !== msg.id; });
        if (slideshowIdx >= screenTimeline.length) slideshowIdx = Math.max(0, screenTimeline.length - 1);
        renderTimelineSlots();
        try { if (typeof renderCards === 'function') renderCards(); } catch (_) {}
        refreshDynScreens();
        if (!screenTimeline.length) {
          _lastShownTimelineId = null;
        } else if (removedCurrent) {
          showTimelineImage(slideshowIdx, { silent: true });
        }
        return true;
      }
      if (msg.type === 'screen-timeline-state' && Array.isArray(msg.items)) {
        var prevId = screenTimeline[slideshowIdx] && screenTimeline[slideshowIdx].id;
        var nextItems = msg.items.slice(0, 10);
        // Avoid full redraw storm if state is identical
        var same = nextItems.length === screenTimeline.length &&
          nextItems.every(function (it, i) { return screenTimeline[i] && screenTimeline[i].id === it.id; });
        var nextSelected = (typeof msg.selected === 'number') ? msg.selected : slideshowIdx;
        var nextSlide = !!msg.slideshow;
        if (same && nextSelected === slideshowIdx && nextSlide === slideshowOn) {
          return true; // no-op
        }
        screenTimeline = nextItems;
        slideshowOn = nextSlide;
        if (typeof msg.selected === 'number') slideshowIdx = msg.selected;
        document.querySelectorAll('#stSlideshowToggle, #stSlideshowToggleDesktop, #stSlideshowToggleSide').forEach(function (x) {
          x.checked = slideshowOn;
        });
        renderTimelineSlots();
        try { if (typeof renderCards === 'function') renderCards(); } catch (_) {}
        refreshDynScreens();
        if (screenTimeline.length) {
          var idx = Math.min(Math.max(0, slideshowIdx), screenTimeline.length - 1);
          var nextId = screenTimeline[idx] && screenTimeline[idx].id;
          // Only change the big view when the shown image actually changes
          if (nextId !== prevId || nextId !== _lastShownTimelineId) {
            showTimelineImage(idx, { silent: true });
          }
        }
        if (slideshowOn) startSlideshow(); else stopSlideshow();
        return true;
      }
      if (msg.type === 'screen-timeline-slideshow') {
        slideshowOn = !!msg.on;
        document.querySelectorAll('#stSlideshowToggle, #stSlideshowToggleDesktop, #stSlideshowToggleSide').forEach(function (x) {
          x.checked = slideshowOn;
        });
        if (slideshowOn) startSlideshow(); else stopSlideshow();
        return true;
      }
      if (msg.type === 'screen-timeline-select' && typeof msg.index === 'number') {
        if (screenTimeline[msg.index]) {
          if (slideshowIdx === msg.index && _lastShownTimelineId === (screenTimeline[msg.index].id || null)) {
            return true; // already showing
          }
          slideshowIdx = msg.index;
          var someoneSharing = false;
          try {
            someoneSharing = (typeof participants !== 'undefined') && participants.some(function (p) { return p.sharing; });
          } catch (_) {}
          if (!someoneSharing && !(typeof isSharing !== 'undefined' && isSharing)) {
            showTimelineImage(msg.index, { silent: true });
          } else {
            renderTimelineSlots();
          }
        }
        return true;
      }
      if (msg.type === 'reaction') {
        noteReaction(msg.fromName || msg.name || 'Someone', msg.emoji);
      }
      return false;
    }

    window.__handleTimelineMsg = handleTimelineMsg;
    // Keep a soft re-hook for older paths, but primary delivery is main onmessage
    function installWsHook() {
      /* no-op: timeline handled in connectWS onmessage via window.__handleTimelineMsg */
    }
    installWsHook();

    document.getElementById('chatSheetImageBtn')?.addEventListener('click', function () {
      document.getElementById('chatImageBtn')?.click();
    });
    document.getElementById('chatSheetAttachBtn')?.addEventListener('click', function () {
      document.getElementById('chatAttachBtn')?.click();
    });
    document.getElementById('chatSheetVoiceBtn')?.addEventListener('click', function () {
      document.getElementById('chatVoiceBtn')?.click();
    });

    var cardsEl = document.getElementById('screenCards');
    if (cardsEl && typeof MutationObserver !== 'undefined') {
      new MutationObserver(function () {
        if (activePane === 'screens') refreshDynScreens();
      }).observe(cardsEl, { childList: true, subtree: true });
    }

    window.addEventListener('resize', function () {
      if (currentMeeting) syncMobileChrome();
    });
  })();


  // ========== Phase 1/2 client features (INSIDE main IIFE scope) ==========
  (function phase2ClientFeatures() {
    let mediaRecorder = null;
    let recordedChunks = [];
    let notesSaveTimer = null;
    let autoRecordEnabled = false;

    function isHostNow() {
      try {
        return myRole === 'host' || !!(currentMeeting && currentMeeting.isHost);
      } catch (_) {
        return false;
      }
    }

    function safeSend(obj) {
      try {
        if (typeof sendWS === 'function') sendWS(obj);
      } catch (e) {
        console.warn('sendWS failed', e);
      }
    }

    // --- MediaRecorder capture (host) ---
    async function startClientCapture(options) {
      try {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') return;
        recordedChunks = [];
        const streams = [];
        try {
          if (!options || options.audio !== false) {
            const a = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            streams.push(a);
          }
        } catch (e) {
          console.warn('rec audio', e);
        }
        try {
          if (!options || options.screenShare !== false || options.video !== false) {
            const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
            streams.push(s);
            s.getVideoTracks().forEach((tr) => {
              tr.addEventListener('ended', () => {
                if (mediaRecorder && mediaRecorder.state !== 'inactive') {
                  try { mediaRecorder.stop(); } catch (_) {}
                }
              });
            });
          }
        } catch (e) {
          console.warn('rec display', e);
        }
        if (!streams.length) {
          if (typeof showToast === 'function') showToast('Could not access mic/screen for recording');
          return;
        }
        const mixed = new MediaStream();
        streams.forEach((st) => st.getTracks().forEach((tr) => mixed.addTrack(tr)));
        const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
          ? 'video/webm;codecs=vp9,opus'
          : (MediaRecorder.isTypeSupported('video/webm') ? 'video/webm' : '');
        const recOpts = mime ? { mimeType: mime } : {};
        mediaRecorder = new MediaRecorder(mixed, recOpts);
        mediaRecorder.ondataavailable = (e) => {
          if (e.data && e.data.size) recordedChunks.push(e.data);
        };
        mediaRecorder.onstop = () => {
          try {
            downloadRecordingChunks(mime || 'video/webm');
          } catch (err) {
            console.warn('rec onstop', err);
          }
          streams.forEach((st) => {
            try { st.getTracks().forEach((tr) => tr.stop()); } catch (_) {}
          });
          mediaRecorder = null;
          window.__clientRecorder = null;
        };
        mediaRecorder.start(1000);
        window.__clientRecorder = mediaRecorder;
        if (typeof showToast === 'function') showToast('Local recording capture started');
      } catch (e) {
        console.warn('startClientCapture', e);
        if (typeof showToast === 'function') showToast('Recording capture failed: ' + (e.message || e));
      }
    }

    function downloadRecordingChunks(mime) {
      if (!recordedChunks.length) return;
      const blob = new Blob(recordedChunks, { type: mime || 'video/webm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const code = (currentMeeting && currentMeeting.code) || 'meet';
      a.download = 'meet-' + code + '-' + Date.now() + '.webm';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      recordedChunks = [];
      if (typeof showToast === 'function') showToast('Recording downloaded');
    }

    function pauseClientCapture() {
      try {
        if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.pause();
      } catch (_) {}
    }
    function resumeClientCapture() {
      try {
        if (mediaRecorder && mediaRecorder.state === 'paused') mediaRecorder.resume();
      } catch (_) {}
    }
    function stopClientCaptureAndDownload() {
      try {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
          mediaRecorder.stop(); // triggers onstop → download
        } else if (recordedChunks.length) {
          downloadRecordingChunks('video/webm');
        }
      } catch (_) {}
    }

    function togglePauseRecording() {
      if (!recordingState) return;
      if (recordingState.status === 'recording') {
        safeSend({ type: 'pause-recording' });
        pauseClientCapture();
      } else if (recordingState.status === 'paused') {
        safeSend({ type: 'resume-recording' });
        resumeClientCapture();
      }
    }

    function stopAndSaveRecording() {
      // Download local media, then notify server
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        const orig = mediaRecorder.onstop;
        mediaRecorder.onstop = function () {
          try { downloadRecordingChunks('video/webm'); } catch (_) {}
          safeSend({ type: 'stop-recording' });
          mediaRecorder = null;
          window.__clientRecorder = null;
        };
        try { mediaRecorder.stop(); } catch (_) {
          safeSend({ type: 'stop-recording' });
        }
      } else {
        safeSend({ type: 'stop-recording' });
        if (recordedChunks.length) downloadRecordingChunks('video/webm');
      }
    }

    // Wire control buttons
    document.getElementById('recPauseBtn')?.addEventListener('click', togglePauseRecording);
    document.getElementById('recStopBtn')?.addEventListener('click', stopAndSaveRecording);
    document.getElementById('recordPauseBtnModal')?.addEventListener('click', togglePauseRecording);
    document.getElementById('recordStopBtnModal')?.addEventListener('click', () => {
      stopAndSaveRecording();
      document.getElementById('recordModal')?.classList.add('hidden');
    });

    // --- Notes autosave (pause typing 800ms) ---
    function notesStorageKey() {
      const code = (currentMeeting && currentMeeting.code) || 'none';
      return 'meet-notes-' + code;
    }
    function summaryStorageKey() {
      const code = (currentMeeting && currentMeeting.code) || 'none';
      return 'meet-summary-' + code;
    }
    function saveLiveNotesSilent() {
      const ed = document.getElementById('liveNotesEditor');
      if (!ed) return;
      try {
        localStorage.setItem(notesStorageKey(), ed.value || '');
      } catch (_) {}
    }
    function scheduleNotesAutosave() {
      if (notesSaveTimer) clearTimeout(notesSaveTimer);
      notesSaveTimer = setTimeout(() => {
        saveLiveNotesSilent();
        const hint = document.querySelector('#notesTab .notes-hint');
        if (hint) {
          const prev = hint.getAttribute('data-base') || hint.textContent;
          if (!hint.getAttribute('data-base')) hint.setAttribute('data-base', prev);
          hint.textContent = 'Saved locally ✓';
          setTimeout(() => {
            hint.textContent = hint.getAttribute('data-base') || 'Private to you.';
          }, 1500);
        }
      }, 800);
    }
    const notesEditor = document.getElementById('liveNotesEditor');
    if (notesEditor) {
      notesEditor.addEventListener('input', scheduleNotesAutosave);
      notesEditor.addEventListener('blur', saveLiveNotesSilent);
    }
    document.getElementById('liveNotesSave')?.addEventListener('click', () => {
      saveLiveNotesSilent();
      if (typeof showToast === 'function') showToast('Notes saved');
    });
    document.getElementById('summarySaveBtn')?.addEventListener('click', () => {
      const box = document.getElementById('meetingSummaryBox');
      if (box) {
        try { localStorage.setItem(summaryStorageKey(), box.innerText || ''); } catch (_) {}
        if (typeof showToast === 'function') showToast('Summary saved');
      }
    });
    document.getElementById('summaryGenerateBtn')?.addEventListener('click', () => {
      const box = document.getElementById('meetingSummaryBox');
      if (!box) return;
      const list = Array.isArray(participants) ? participants : [];
      const names = list.map((p) => p.name || p.displayName).filter(Boolean);
      const notes = document.getElementById('liveNotesEditor')?.value || '';
      box.innerText =
        'Meeting ' + ((currentMeeting && currentMeeting.code) || '') + '\n' +
        'Participants: ' + (names.join(', ') || '—') + '\n' +
        'Notes: ' + notes.slice(0, 500);
      try { localStorage.setItem(summaryStorageKey(), box.innerText); } catch (_) {}
    });
    document.querySelectorAll('.side-tab[data-tab="notes"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const ed = document.getElementById('liveNotesEditor');
        if (ed) {
          try { ed.value = localStorage.getItem(notesStorageKey()) || ed.value || ''; } catch (_) {}
        }
        const sum = document.getElementById('meetingSummaryBox');
        if (sum) {
          try {
            const s = localStorage.getItem(summaryStorageKey());
            if (s) sum.innerText = s;
          } catch (_) {}
        }
      });
    });

    // --- Private chat ---
    let chatMode = 'public';
    let privateTargetId = '';
    function refreshPrivateSelect() {
      const sel = document.getElementById('privateChatSelect');
      if (!sel) return;
      const cur = sel.value;
      sel.innerHTML = '<option value="">Select participant…</option>';
      const list = Array.isArray(participants) ? participants : [];
      const selfId = currentMeeting && currentMeeting.participantId;
      list.forEach((p) => {
        const id = p.id || p.participantId;
        if (!id || id === selfId) return;
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = p.name || p.displayName || id;
        sel.appendChild(opt);
      });
      if (cur) sel.value = cur;
    }
    document.getElementById('chatModePublic')?.addEventListener('click', () => {
      chatMode = 'public';
      document.getElementById('chatModePublic')?.classList.add('active');
      document.getElementById('chatModePrivate')?.classList.remove('active');
      document.getElementById('privateChatTarget')?.classList.add('hidden');
    });
    document.getElementById('chatModePrivate')?.addEventListener('click', () => {
      chatMode = 'private';
      document.getElementById('chatModePrivate')?.classList.add('active');
      document.getElementById('chatModePublic')?.classList.remove('active');
      document.getElementById('privateChatTarget')?.classList.remove('hidden');
      refreshPrivateSelect();
    });
    document.getElementById('privateChatSelect')?.addEventListener('change', (e) => {
      privateTargetId = e.target.value || '';
    });
    const chatInput = document.getElementById('chatInput');
    if (chatInput) {
      chatInput.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' || e.shiftKey) return;
        if ((window.__railChatMode || chatMode) !== 'private') return;
        e.preventDefault();
        e.stopPropagation();
        if (!privateTargetId) {
          if (typeof showToast === 'function') showToast('Select a participant for private chat');
          return;
        }
        const text = chatInput.value.trim();
        if (!text) return;
        safeSend({ type: 'private-chat', targetId: privateTargetId, text });
        chatInput.value = '';
      }, true);
    }

    // --- PiP / blur ---
    window.__meetRequestPiP = async function () {
      try {
        const vid = document.querySelector('#bigView video, #screenCards video, video');
        if (vid && document.pictureInPictureEnabled) {
          if (document.pictureInPictureElement) await document.exitPictureInPicture();
          else await vid.requestPictureInPicture();
        } else if (typeof showToast === 'function') showToast('PiP not available');
      } catch (e) {
        if (typeof showToast === 'function') showToast('PiP failed');
      }
    };
    let blurOn = false;
    window.__meetToggleBlur = function () {
      blurOn = !blurOn;
      document.querySelectorAll('video').forEach((v) => {
        v.style.filter = blurOn ? 'blur(12px)' : '';
      });
      if (typeof showToast === 'function') showToast(blurOn ? 'Blur on' : 'Blur off');
    };

    // --- Whiteboard ---
    let wbDrawing = false;
    let wbErase = false;
    let wbPoints = [];
    const canvas = document.getElementById('whiteboardCanvas');
    const ctx2d = canvas ? canvas.getContext('2d') : null;
    function wbPos(e) {
      const r = canvas.getBoundingClientRect();
      const cx = e.clientX != null ? e.clientX : (e.touches && e.touches[0] && e.touches[0].clientX);
      const cy = e.clientY != null ? e.clientY : (e.touches && e.touches[0] && e.touches[0].clientY);
      return {
        x: (cx - r.left) * (canvas.width / r.width),
        y: (cy - r.top) * (canvas.height / r.height),
      };
    }
    function drawStroke(stroke) {
      if (!ctx2d || !stroke.points || !stroke.points.length) return;
      ctx2d.strokeStyle = stroke.erase ? '#ffffff' : (stroke.color || '#111');
      ctx2d.lineWidth = stroke.erase ? 20 : (stroke.width || 3);
      ctx2d.lineCap = 'round';
      ctx2d.beginPath();
      stroke.points.forEach((pt, i) => {
        if (i === 0) ctx2d.moveTo(pt.x, pt.y);
        else ctx2d.lineTo(pt.x, pt.y);
      });
      ctx2d.stroke();
    }
    if (canvas && ctx2d) {
      canvas.addEventListener('mousedown', (e) => { wbDrawing = true; wbPoints = [wbPos(e)]; });
      canvas.addEventListener('mousemove', (e) => {
        if (!wbDrawing) return;
        wbPoints.push(wbPos(e));
        drawStroke({
          points: wbPoints.slice(-2),
          color: document.getElementById('wbColor')?.value,
          erase: wbErase,
        });
      });
      const endDraw = () => {
        if (!wbDrawing) return;
        wbDrawing = false;
        if (wbPoints.length > 1) {
          safeSend({
            type: 'wb-stroke',
            points: wbPoints,
            color: document.getElementById('wbColor')?.value || '#111',
            erase: wbErase,
          });
        }
        wbPoints = [];
      };
      canvas.addEventListener('mouseup', endDraw);
      canvas.addEventListener('mouseleave', endDraw);
    }
    document.getElementById('wbEraser')?.addEventListener('click', () => { wbErase = true; });
    document.getElementById('wbPen')?.addEventListener('click', () => { wbErase = false; });
    document.getElementById('wbClear')?.addEventListener('click', () => {
      safeSend({ type: 'wb-clear' });
      if (ctx2d && canvas) ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    });
    document.getElementById('wbExport')?.addEventListener('click', () => {
      if (!canvas) return;
      const a = document.createElement('a');
      a.href = canvas.toDataURL('image/png');
      a.download = 'whiteboard.png';
      a.click();
    });
    document.getElementById('whiteboardClose')?.addEventListener('click', () => {
      document.getElementById('whiteboardModal')?.classList.add('hidden');
    });
    document.getElementById('whiteboardModalBackdrop')?.addEventListener('click', () => {
      document.getElementById('whiteboardModal')?.classList.add('hidden');
    });
    window.__meetOpenWhiteboard = function () {
      document.getElementById('whiteboardModal')?.classList.remove('hidden');
      safeSend({ type: 'wb-sync' });
    };

    // --- Breakout ---
    document.getElementById('breakoutCreate')?.addEventListener('click', () => {
      const count = parseInt(document.getElementById('breakoutCount')?.value || '2', 10);
      safeSend({ type: 'breakout-create', count });
    });
    document.getElementById('breakoutCloseAll')?.addEventListener('click', () => {
      safeSend({ type: 'breakout-close' });
    });
    document.getElementById('breakoutCancel')?.addEventListener('click', () => {
      document.getElementById('breakoutModal')?.classList.add('hidden');
    });
    window.__meetOpenBreakout = function () {
      document.getElementById('breakoutModal')?.classList.remove('hidden');
    };

    document.addEventListener('click', (e) => {
      const item = e.target.closest && e.target.closest('[data-action]');
      if (!item) return;
      const act = item.getAttribute('data-action');
      if (act === 'pip') { e.preventDefault(); window.__meetRequestPiP && window.__meetRequestPiP(); }
      if (act === 'blur') { e.preventDefault(); window.__meetToggleBlur && window.__meetToggleBlur(); }
      if (act === 'whiteboard') { e.preventDefault(); window.__meetOpenWhiteboard && window.__meetOpenWhiteboard(); }
      if (act === 'breakout') { e.preventDefault(); window.__meetOpenBreakout && window.__meetOpenBreakout(); }
      if (act === 'notes') {
        e.preventDefault();
        const tab = document.querySelector('.side-tab[data-tab="notes"]');
        if (tab) tab.click();
      }
    });

    const morePanel = document.getElementById('dynPaneMore');
    if (morePanel && !document.getElementById('phase2MoreInject')) {
      const div = document.createElement('div');
      div.id = 'phase2MoreInject';
      div.innerHTML =
        '<div class="more-hub-section">Collaboration</div>' +
        '<button type="button" class="more-item" data-action="notes"><i class="fa-solid fa-note-sticky"></i> Notes</button>' +
        '<button type="button" class="more-item" data-action="whiteboard"><i class="fa-solid fa-chalkboard"></i> Whiteboard</button>' +
        '<button type="button" class="more-item" data-action="breakout"><i class="fa-solid fa-people-group"></i> Breakout rooms</button>' +
        '<div class="more-hub-section">Media</div>' +
        '<button type="button" class="more-item" data-action="pip"><i class="fa-solid fa-window-restore"></i> Picture-in-Picture</button>' +
        '<button type="button" class="more-item" data-action="blur"><i class="fa-solid fa-droplet"></i> Background blur</button>';
      morePanel.appendChild(div);
    }

    // Auto-record checkbox in record modal
    const recModal = document.getElementById('recordModal');
    if (recModal && !document.getElementById('autoRecordToggle')) {
      const label = document.createElement('label');
      label.className = 'checkbox-label';
      label.style.display = 'block';
      label.style.marginTop = '0.5rem';
      label.innerHTML = '<input type="checkbox" id="autoRecordToggle"> Auto-record when I start a meeting (host)';
      const actions = recModal.querySelector('.modal-actions');
      if (actions) recModal.querySelector('.modal-card')?.insertBefore(label, actions);
      else recModal.querySelector('.modal-card')?.appendChild(label);
      try {
        autoRecordEnabled = localStorage.getItem('meet-auto-record') === '1';
      } catch (_) {}
      const tog = document.getElementById('autoRecordToggle');
      if (tog) {
        tog.checked = autoRecordEnabled;
        tog.addEventListener('change', () => {
          autoRecordEnabled = !!tog.checked;
          try { localStorage.setItem('meet-auto-record', autoRecordEnabled ? '1' : '0'); } catch (_) {}
        });
      }
    }

    // Also on create form if present
    const createCard = document.querySelector('#homeView .create-card, #createBtn');
    if (document.getElementById('createBtn') && !document.getElementById('autoRecordCreate')) {
      const wrap = document.createElement('label');
      wrap.className = 'checkbox-label';
      wrap.style.display = 'block';
      wrap.style.margin = '0.5rem 0';
      wrap.innerHTML = '<input type="checkbox" id="autoRecordCreate"> Auto-record this meeting';
      const btn = document.getElementById('createBtn');
      if (btn && btn.parentNode) btn.parentNode.insertBefore(wrap, btn);
      const c = document.getElementById('autoRecordCreate');
      if (c) {
        try { c.checked = localStorage.getItem('meet-auto-record') === '1'; } catch (_) {}
        c.addEventListener('change', () => {
          autoRecordEnabled = !!c.checked;
          try { localStorage.setItem('meet-auto-record', autoRecordEnabled ? '1' : '0'); } catch (_) {}
          const t2 = document.getElementById('autoRecordToggle');
          if (t2) t2.checked = autoRecordEnabled;
        });
      }
    }

    window.__meetMaybeAutoRecord = function () {
      try {
        autoRecordEnabled = localStorage.getItem('meet-auto-record') === '1' ||
          !!(document.getElementById('autoRecordCreate') && document.getElementById('autoRecordCreate').checked);
      } catch (_) {}
      if (!autoRecordEnabled || !isHostNow()) return;
      if (recordingState && (recordingState.status === 'recording' || recordingState.status === 'paused')) return;
      setTimeout(() => {
        safeSend({
          type: 'start-recording',
          audio: true,
          video: true,
          screenShare: true,
          chat: true,
        });
        // Client capture starts on recording-capture event
      }, 1200);
    };

    // On leave: stop recording + download
    window.__meetFlushRecordingOnLeave = function () {
      saveLiveNotesSilent();
      try {
        const ed = document.getElementById('liveNotesEditor');
        const notes = (ed && ed.value) || localStorage.getItem(notesStorageKey()) || '';
        const summary = localStorage.getItem(summaryStorageKey()) || '';
        if (notes.trim() || summary.trim()) {
          let body = notes.trim();
          if (summary.trim()) body += (body ? '\n\n' : '') + '----------\n' + summary.trim();
          const blob = new Blob([body], { type: 'text/plain;charset=utf-8' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'meet-notes-' + ((currentMeeting && currentMeeting.code) || 'session') + '.txt';
          document.body.appendChild(a);
          a.click();
          a.remove();
        }
      } catch (e) { console.warn('notes export', e); }

      try {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
          stopClientCaptureAndDownload();
        } else if (recordedChunks.length) {
          downloadRecordingChunks('video/webm');
        }
        if (recordingState && (recordingState.status === 'recording' || recordingState.status === 'paused')) {
          safeSend({ type: 'stop-recording' });
        }
      } catch (e) {
        console.warn('flush recording', e);
      }
    };

    // WS extra handlers — attach to live socket
    const extraHandlers = {
      'private-chat': function (msg) {
        if (typeof window.__meetIngestPrivate === 'function') window.__meetIngestPrivate(msg);
      },
      'private-chat-history': function (msg) {
        if (typeof window.__meetIngestPrivateHistory === 'function') {
          window.__meetIngestPrivateHistory(msg.messages || []);
        }
      },
      'group-state': function (msg) {
        if (msg.group && typeof window.__meetIngestGroupState === 'function') {
          window.__meetIngestGroupState(msg.group);
        }
      },
      'group-members': function (msg) {
        if (msg.groupId && Array.isArray(msg.members) && typeof window.__meetIngestGroupState === 'function') {
          var ch = typeof chatChannels !== 'undefined' ? chatChannels[msg.groupId] : null;
          window.__meetIngestGroupState({
            id: msg.groupId,
            title: ch ? ch.title : 'Group',
            members: msg.members,
          });
        }
      },
      'group-chat': function (msg) {
        if (typeof window.__meetIngestGroupChat === 'function') window.__meetIngestGroupChat(msg);
      },
      'group-chat-history': function (msg) {
        if (!msg.groupId || !Array.isArray(msg.messages)) return;
        msg.messages.forEach(function (m) {
          if (typeof window.__meetIngestGroupChat === 'function') {
            window.__meetIngestGroupChat({ message: Object.assign({ groupId: msg.groupId }, m) });
          }
        });
      },
      'group-removed': function (msg) {
        if (!msg.groupId) return;
        try {
          if (typeof chatChannels !== 'undefined' && chatChannels[msg.groupId]) {
            delete chatChannels[msg.groupId];
            if (activeChannelId === msg.groupId && typeof showChatInbox === 'function') showChatInbox();
          }
        } catch (_) {}
      },
      'recording-capture': function (msg) {
        if (!isHostNow()) return;
        if (msg.action === 'start') startClientCapture(msg.options || {});
        if (msg.action === 'pause') pauseClientCapture();
        if (msg.action === 'resume') resumeClientCapture();
        if (msg.action === 'stop') {
          try {
            if (mediaRecorder && mediaRecorder.state !== 'inactive') {
              // already stopping via stopAndSave; avoid double
            }
          } catch (_) {}
        }
      },
      'wb-stroke': function (msg) { if (msg.stroke) drawStroke(msg.stroke); },
      'wb-clear': function () {
        if (ctx2d && canvas) ctx2d.clearRect(0, 0, canvas.width, canvas.height);
      },
      'wb-sync': function (msg) {
        if (ctx2d && canvas) ctx2d.clearRect(0, 0, canvas.width, canvas.height);
        (msg.strokes || []).forEach(drawStroke);
      },
      'breakout-state': function (msg) {
        const list = document.getElementById('breakoutList');
        if (!list) return;
        list.innerHTML = '';
        ((msg.breakouts && msg.breakouts.rooms) || []).forEach((r) => {
          const li = document.createElement('li');
          li.textContent = r.name + ' (' + ((r.participantIds && r.participantIds.length) || 0) + ' people)';
          list.appendChild(li);
        });
      },
      'breakout-assign': function (msg) {
        if (typeof showToast === 'function') showToast('Assigned to ' + ((msg.room && msg.room.name) || 'breakout'));
      },
      'breakout-return': function () {
        if (typeof showToast === 'function') showToast('Return to main meeting');
      },
    };

    // Patch WebSocket onmessage when connectWS runs
    let tries = 0;
    const iv = setInterval(() => {
      tries++;
      try {
        if (typeof ws !== 'undefined' && ws && !ws.__p2handlers) {
          ws.__p2handlers = true;
          const prev = ws.onmessage;
          ws.onmessage = function (ev) {
            if (typeof prev === 'function') prev.call(this, ev);
            try {
              const msg = JSON.parse(ev.data);
              const h = extraHandlers[msg.type];
              if (h) h(msg);
            } catch (_) {}
          };
        }
      } catch (_) {}
      if (tries > 100) clearInterval(iv);
    }, 300);

    // Also re-patch after each connect: hook sendWS side is hard; observe currentMeeting
    const origLeave = leaveMeeting;
    // leaveMeeting is async function in scope — wrap via reassignment if possible
    // We call flush from patched leaveMeeting below
  })();





  // ========== Slim rail UI controller (7-slot) ==========
  (function meetRailUI() {
    const drawer = document.getElementById('meetSideDrawer');
    const rail = document.getElementById('meetIconRail');
    if (!rail) return;
    let openPanel = null;
    const dmStore = {}; // targetId -> { name, messages: [], unread }

    function isHostLike() {
      try {
        return myRole === 'host' || myRole === 'cohost' || !!(currentMeeting && currentMeeting.isHost);
      } catch (_) { return false; }
    }


    var chatChannels = {
      everyone: { id: 'everyone', title: 'Group chat', pinned: true, kind: 'group', messages: [], unread: 0, lastText: '', lastAt: 0, members: [] }
    };
    var activeChannelId = null;
    Object.defineProperty(window, '__meetActiveChannelId', {
      get: function () { return activeChannelId; },
      set: function (v) { activeChannelId = v; },
      configurable: true
    });

    function applySelfChatColorSafe() {
      try { if (typeof applySelfChatColor === 'function') applySelfChatColor(); } catch (_) {}
    }

    function formatChatTime(ts) {
      if (!ts) return '';
      try {
        var d = new Date(typeof ts === 'number' ? ts : Date.parse(ts));
        if (isNaN(d.getTime())) return '';
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      } catch (_) { return ''; }
    }

    function msgKey(m) {
      if (!m) return '';
      if (m.id) return String(m.id);
      return [m.fromId || m.participantId || '', m.at || '', m.text || m.body || ''].join('|');
    }

    function channelHasMsg(ch, m) {
      if (!ch || !ch.messages) return false;
      var k = msgKey(m);
      if (!k) return false;
      for (var i = 0; i < ch.messages.length; i++) {
        if (msgKey(ch.messages[i]) === k) return true;
      }
      return false;
    }

    function renderBubbleMessage(m, opts) {
      opts = opts || {};
      var selfId = currentMeeting && currentMeeting.participantId;
      var selfUserId = currentUser && currentUser.id;
      var isMe = false;
      if (typeof m.isMe === 'boolean') isMe = m.isMe;
      else if (m.fromId && selfId && m.fromId === selfId) isMe = true;
      else if (m.participantId && selfId && m.participantId === selfId) isMe = true;
      else if (m.fromUserId && selfUserId && m.fromUserId === selfUserId) isMe = true;

      var row = document.createElement('div');
      row.className = 'chat-msg-row' + (isMe ? ' is-me' : '');
      row.setAttribute('data-msg-key', msgKey(m));
      applySelfChatColorSafe();
      if (isMe) row.style.setProperty('--chat-self-color', (typeof selfChatColor === 'function' ? selfChatColor() : '#4f8cff'));

      var who = isMe ? 'You' : (m.fromName || m.name || 'User');
      var body = m.text || m.body || '';
      if (typeof linkifyAndMentions === 'function' && m.mentions) {
        body = linkifyAndMentions(body, m.mentions);
      } else {
        body = (typeof escapeHtml === 'function' ? escapeHtml(body) : body);
      }
      var meta = formatChatTime(m.at || m.created_at);
      row.innerHTML =
        '<span class="chat-who">' + (typeof escapeHtml === 'function' ? escapeHtml(who) : who) + '</span>' +
        (body ? '<div class="chat-msg-body">' + body + '</div>' : '') +
        (meta ? '<div class="chat-msg-meta">' + meta + '</div>' : '');
      return row;
    }

    function appendBubbleToBox(box, m, opts) {
      if (!box || !m) return null;
      var k = msgKey(m);
      if (k && box.querySelector('[data-msg-key="' + k.replace(/"/g, '') + '"]')) return null;
      var row = renderBubbleMessage(m, opts);
      box.appendChild(row);
      box.scrollTop = box.scrollHeight;
      return row;
    }

    function rerenderActiveChannel() {
      var ch = activeChannelId && chatChannels[activeChannelId];
      var box = document.getElementById('chatMessages');
      if (!ch || !box) return;
      var scrollBottom = Math.abs(box.scrollHeight - box.scrollTop - box.clientHeight) < 40;
      box.innerHTML = '';
      if (ch.peerIsGuest) {
        var banner = document.createElement('div');
        banner.className = 'chat-msg-row guest-label-row';
        banner.textContent = 'This chat includes a guest — history is kept for your account';
        box.appendChild(banner);
      }
      (ch.messages || []).forEach(function (m) {
        appendBubbleToBox(box, m, { peerIsGuest: ch.peerIsGuest });
      });
      if (scrollBottom) box.scrollTop = box.scrollHeight;
    }

    function setThreadTitle(title) {
      var el = document.getElementById('chatThreadTitle');
      if (el) el.textContent = title || 'Chat';
    }

    function setMembersBtnVisible(show) {
      var btn = document.getElementById('chatThreadMembersBtn');
      if (btn) btn.classList.toggle('hidden', !show);
      var panel = document.getElementById('chatMembersPanel');
      if (!show && panel) panel.classList.add('hidden');
    }

    function renderMembersPanel(ch) {
      var list = document.getElementById('chatMembersList');
      var addRow = document.getElementById('chatMembersAddRow');
      if (!list) return;
      list.innerHTML = '';
      var members = (ch && ch.memberDetails) || [];
      if (!members.length && ch && Array.isArray(ch.members)) {
        members = ch.members.map(function (id) {
          var p = (participants || []).find(function (x) { return (x.id || x.participantId) === id; });
          return { id: id, name: p ? (p.name || id) : id, role: p ? p.role : 'participant' };
        });
      }
      var canManage = isHostLike();
      members.forEach(function (m) {
        var li = document.createElement('li');
        var role = m.role || 'participant';
        li.innerHTML =
          '<span><strong>' + escapeHtml(m.name || m.id) + '</strong>' +
          '<span class="member-role">' + escapeHtml(role) + '</span></span>';
        if (canManage && ch && ch.kind === 'subgroup' && m.id !== (currentMeeting && currentMeeting.participantId)) {
          var rm = document.createElement('button');
          rm.type = 'button';
          rm.className = 'member-remove';
          rm.title = 'Remove';
          rm.innerHTML = '<i class="fa-solid fa-user-minus"></i>';
          rm.addEventListener('click', function () {
            if (typeof sendWS === 'function') sendWS({ type: 'group-remove-member', groupId: ch.id, targetId: m.id });
            ch.members = (ch.members || []).filter(function (id) { return id !== m.id; });
            ch.memberDetails = (ch.memberDetails || []).filter(function (x) { return x.id !== m.id; });
            renderMembersPanel(ch);
          });
          li.appendChild(rm);
        }
        list.appendChild(li);
      });
      if (addRow) {
        addRow.classList.toggle('hidden', !(canManage && ch && ch.kind === 'subgroup'));
        if (canManage && ch && ch.kind === 'subgroup') {
          var sel = document.getElementById('chatMembersAddSelect');
          if (sel) {
            var prev = sel.value;
            sel.innerHTML = '<option value="">Add participant…</option>';
            var existing = {};
            (ch.members || []).forEach(function (id) { existing[id] = true; });
            var selfId = currentMeeting && currentMeeting.participantId;
            (participants || []).forEach(function (p) {
              var id = p.id || p.participantId;
              if (!id || id === selfId || existing[id]) return;
              var opt = document.createElement('option');
              opt.value = id;
              opt.textContent = p.name || id;
              sel.appendChild(opt);
            });
            if (prev) sel.value = prev;
          }
        }
      }
    }

    /** Refresh live-dependent chat UI when roster changes (no page reload). */
    window.__meetRefreshChatLive = function () {
      try {
        var inbox = document.getElementById('chatInbox');
        if (inbox && !inbox.classList.contains('hidden')) renderChatInbox();
        var ch = activeChannelId && chatChannels[activeChannelId];
        var panel = document.getElementById('chatMembersPanel');
        if (ch && panel && !panel.classList.contains('hidden')) renderMembersPanel(ch);
        var ngp = document.getElementById('chatNewGroupPanel');
        if (ngp && !ngp.classList.contains('hidden')) {
          var list = document.getElementById('newGroupMemberList');
          if (list) {
            var checked = {};
            list.querySelectorAll('input:checked').forEach(function (i) {
              checked[i.getAttribute('data-pid')] = true;
            });
            list.innerHTML = '';
            var selfId = currentMeeting && currentMeeting.participantId;
            (participants || []).forEach(function (p) {
              var id = p.id || p.participantId;
              if (!id || id === selfId) return;
              var li = document.createElement('li');
              li.innerHTML = '<label><input type="checkbox" data-pid="' + id + '"' +
                (checked[id] ? ' checked' : '') + '> ' + escapeHtml(p.name || id) + '</label>';
              list.appendChild(li);
            });
          }
        }
      } catch (e) { console.warn('[chat live refresh]', e); }
    };

    function showChatInbox() {
      var inbox = document.getElementById('chatInbox');
      var thread = document.getElementById('chatThreadView');
      var ngp = document.getElementById('chatNewGroupPanel');
      var panel = document.getElementById('chatMembersPanel');
      if (inbox) inbox.classList.remove('hidden');
      if (thread) thread.classList.add('hidden');
      if (ngp) ngp.classList.add('hidden');
      if (panel) panel.classList.add('hidden');
      activeChannelId = null;
      renderChatInbox();
      var ng = document.getElementById('chatNewGroupBtn');
      if (ng) ng.classList.toggle('hidden', !isHostLike());
    }

    function renderChatInbox() {
      var list = document.getElementById('chatInboxList');
      if (!list) return;
      list.innerHTML = '';
      var items = Object.keys(chatChannels).map(function (k) { return chatChannels[k]; });
      items.sort(function (a, b) {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        return (b.lastAt || 0) - (a.lastAt || 0);
      });
      items.forEach(function (ch) {
        var li = document.createElement('li');
        if (ch.pinned) li.classList.add('pinned');
        var guestBadge = ch.peerIsGuest ? ' <span class="quiet-label">(guest)</span>' : '';
        li.innerHTML = '<div class="dm-name"><span>' + escapeHtml(ch.title) + guestBadge + '</span>' +
          (ch.unread ? '<span class="dm-unread">' + ch.unread + '</span>' : '') + '</div>' +
          '<div class="dm-excerpt">' + escapeHtml(String(ch.lastText || '').slice(0, 70)) + '</div>';
        li.addEventListener('click', function () { openChatChannel(ch.id); });
        list.appendChild(li);
      });
      var selfId = currentMeeting && currentMeeting.participantId;
      (participants || []).forEach(function (p) {
        var id = p.id || p.participantId;
        if (!id || id === selfId) return;
        var key = 'dm:' + id;
        if (chatChannels[key]) return;
        var li = document.createElement('li');
        var isGuest = !p.userId;
        li.innerHTML = '<div class="dm-name">' + escapeHtml(p.name || id) +
          (isGuest ? ' <span class="quiet-label">(guest)</span>' : '') +
          '</div><div class="dm-excerpt">Message…</div>';
        li.addEventListener('click', function () {
          chatChannels[key] = {
            id: key,
            title: p.name || id,
            peerId: id,
            peerUserId: p.userId || null,
            peerIsGuest: isGuest,
            kind: 'dm',
            messages: [],
            unread: 0,
            lastText: '',
            lastAt: 0
          };
          openChatChannel(key);
        });
        list.appendChild(li);
      });
    }

    async function loadDmHistoryForChannel(ch) {
      if (!ch || ch.kind !== 'dm' || !ch.peerUserId || !currentUser || !authToken) return;
      try {
        var data = await api('/api/dm/with-user?userId=' + encodeURIComponent(ch.peerUserId));
        if (!data || !Array.isArray(data.messages)) return;
        ch.threadId = data.threadId;
        data.messages.forEach(function (m) {
          var mapped = {
            id: m.id ? ('db_' + m.id) : undefined,
            fromName: m.fromName,
            fromUserId: m.fromUserId,
            text: m.text,
            at: m.at,
            isMe: m.isMe
          };
          if (!channelHasMsg(ch, mapped)) ch.messages.push(mapped);
        });
        ch.messages.sort(function (a, b) {
          return (Date.parse(a.at) || a.at || 0) - (Date.parse(b.at) || b.at || 0);
        });
        if (ch.messages.length) {
          var last = ch.messages[ch.messages.length - 1];
          ch.lastText = last.text || '';
          ch.lastAt = Date.parse(last.at) || last.at || Date.now();
        }
      } catch (e) {
        console.warn('[dm history]', e);
      }
    }

    async function openChatChannel(id) {
      var ch = chatChannels[id];
      if (!ch) return;
      var switching = activeChannelId !== id;
      activeChannelId = id;
      ch.unread = 0;
      var inbox = document.getElementById('chatInbox');
      var ngp = document.getElementById('chatNewGroupPanel');
      var view = document.getElementById('chatThreadView');
      var panel = document.getElementById('chatMembersPanel');
      if (inbox) inbox.classList.add('hidden');
      if (ngp) ngp.classList.add('hidden');
      if (view) view.classList.remove('hidden');
      if (panel) panel.classList.add('hidden');

      setThreadTitle(ch.title + (ch.peerIsGuest ? ' (guest)' : ''));
      setMembersBtnVisible(ch.kind === 'subgroup' || ch.kind === 'group');

      if (ch.kind === 'dm' && ch.peerUserId && currentUser) {
        await loadDmHistoryForChannel(ch);
      }

      // Always rebuild thread DOM when opening/switching to avoid blank states
      rerenderActiveChannel();
      updateChatBadge();
    }

    function updateChatBadge() {
      var total = 0;
      Object.keys(chatChannels).forEach(function (k) { total += chatChannels[k].unread || 0; });
      var badge = document.getElementById('railChatBadge');
      if (badge) {
        badge.textContent = total ? String(total) : '';
        badge.classList.toggle('hidden', !total);
      }
    }

    document.getElementById('chatThreadBack') && document.getElementById('chatThreadBack').addEventListener('click', showChatInbox);
    document.getElementById('chatThreadMembersBtn') && document.getElementById('chatThreadMembersBtn').addEventListener('click', function () {
      var ch = chatChannels[activeChannelId];
      if (!ch) return;
      var panel = document.getElementById('chatMembersPanel');
      if (!panel) return;
      var open = panel.classList.contains('hidden');
      if (open) {
        renderMembersPanel(ch);
        panel.classList.remove('hidden');
      } else {
        panel.classList.add('hidden');
      }
    });
    document.getElementById('chatMembersClose') && document.getElementById('chatMembersClose').addEventListener('click', function () {
      document.getElementById('chatMembersPanel')?.classList.add('hidden');
    });
    document.getElementById('chatMembersAddBtn') && document.getElementById('chatMembersAddBtn').addEventListener('click', function () {
      var ch = chatChannels[activeChannelId];
      if (!ch || ch.kind !== 'subgroup') return;
      var sel = document.getElementById('chatMembersAddSelect');
      var targetId = sel && sel.value;
      if (!targetId) return;
      if (typeof sendWS === 'function') sendWS({ type: 'group-add-member', groupId: ch.id, targetId: targetId });
      if (!ch.members) ch.members = [];
      if (ch.members.indexOf(targetId) < 0) ch.members.push(targetId);
      var p = (participants || []).find(function (x) { return (x.id || x.participantId) === targetId; });
      if (!ch.memberDetails) ch.memberDetails = [];
      ch.memberDetails.push({ id: targetId, name: p ? p.name : targetId, role: p ? p.role : 'participant' });
      renderMembersPanel(ch);
      if (sel) sel.value = '';
    });

    document.getElementById('chatNewGroupBtn') && document.getElementById('chatNewGroupBtn').addEventListener('click', function () {
      document.getElementById('chatInbox') && document.getElementById('chatInbox').classList.add('hidden');
      document.getElementById('chatThreadView') && document.getElementById('chatThreadView').classList.add('hidden');
      document.getElementById('chatNewGroupPanel') && document.getElementById('chatNewGroupPanel').classList.remove('hidden');
      var list = document.getElementById('newGroupMemberList');
      if (!list) return;
      list.innerHTML = '';
      var selfId = currentMeeting && currentMeeting.participantId;
      (participants || []).forEach(function (p) {
        var id = p.id || p.participantId;
        if (!id || id === selfId) return;
        var li = document.createElement('li');
        li.innerHTML = '<label><input type="checkbox" data-pid="' + id + '"> ' + escapeHtml(p.name || id) + '</label>';
        list.appendChild(li);
      });
    });
    document.getElementById('chatNewGroupBack') && document.getElementById('chatNewGroupBack').addEventListener('click', showChatInbox);
    document.getElementById('newGroupCreateBtn') && document.getElementById('newGroupCreateBtn').addEventListener('click', function () {
      var name = ((document.getElementById('newGroupName') && document.getElementById('newGroupName').value) || '').trim() || 'Group';
      var ids = [];
      document.querySelectorAll('#newGroupMemberList input:checked').forEach(function (i) { ids.push(i.getAttribute('data-pid')); });
      if (!ids.length) return;
      var selfId = currentMeeting && currentMeeting.participantId;
      if (selfId && ids.indexOf(selfId) < 0) ids.unshift(selfId);
      var gid = 'grp:' + Date.now();
      chatChannels[gid] = {
        id: gid,
        title: name,
        members: ids,
        memberDetails: ids.map(function (id) {
          var p = (participants || []).find(function (x) { return (x.id || x.participantId) === id; });
          return { id: id, name: p ? p.name : id, role: p ? p.role : 'participant' };
        }),
        kind: 'subgroup',
        messages: [],
        unread: 0,
        lastText: '',
        lastAt: Date.now()
      };
      if (typeof sendWS === 'function') sendWS({ type: 'group-create', groupId: gid, title: name, members: ids });
      openChatChannel(gid);
    });

    var chatFormEl = document.getElementById('chatForm');
    if (chatFormEl && !chatFormEl.__inboxBound) {
      chatFormEl.__inboxBound = true;
      chatFormEl.addEventListener('submit', function (e) {
        if (!activeChannelId || activeChannelId === 'everyone') return;
        e.preventDefault();
        e.stopPropagation();
        var input = document.getElementById('chatInput');
        var text = (input && input.value || '').trim();
        if (!text) return;
        var ch = chatChannels[activeChannelId];
        if (!ch) return;
        var selfName = 'Me';
        try {
          var me = (participants || []).find(function (x) { return x.id === (currentMeeting && currentMeeting.participantId); });
          if (me) selfName = me.name || 'Me';
        } catch (_) {}
        var localId = 'local_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
        if (ch.peerId && typeof sendWS === 'function') {
          var payload = { type: 'private-chat', targetId: ch.peerId, text: text };
          if (ch.peerUserId) payload.targetUserId = ch.peerUserId;
          if (ch.title) payload.targetName = ch.title;
          sendWS(payload);
        } else if (ch.kind === 'subgroup' && typeof sendWS === 'function') {
          sendWS({ type: 'group-chat', groupId: ch.id, text: text, members: ch.members });
        }
        // Optimistic UI with local id — server echo will dedupe by text+near-time if needed
        var msg = {
          id: localId,
          fromName: selfName,
          fromId: currentMeeting && currentMeeting.participantId,
          fromUserId: currentUser && currentUser.id,
          text: text,
          at: Date.now(),
          isMe: true,
          _optimistic: true
        };
        if (!channelHasMsg(ch, msg)) {
          ch.messages.push(msg);
          var box = document.getElementById('chatMessages');
          if (box) appendBubbleToBox(box, msg);
        }
        ch.lastText = text;
        ch.lastAt = Date.now();
        if (input) input.value = '';
      }, true);
    }

    window.__meetNotePublicChat = function (text, fromName, participantId) {
      var ch = chatChannels.everyone;
      var m = {
        id: 'pub_' + (participantId || '') + '_' + Date.now() + '_' + String(text || '').slice(0, 24),
        fromName: fromName || '',
        participantId: participantId,
        text: text || '',
        at: Date.now()
      };
      // soft dedupe: same sender+text within 2s
      var softDup = (ch.messages || []).some(function (x) {
        return x.participantId === participantId && x.text === (text || '') && Math.abs((x.at || 0) - m.at) < 2000;
      });
      if (softDup || channelHasMsg(ch, m)) return;
      ch.lastText = text || '';
      ch.lastAt = Date.now();
      ch.messages.push(m);
      if (activeChannelId !== 'everyone') ch.unread = (ch.unread || 0) + 1;
      updateChatBadge();
      var inbox = document.getElementById('chatInbox');
      if (inbox && !inbox.classList.contains('hidden')) renderChatInbox();
      // DOM for "everyone" is owned by appendChatMessage when that channel is open;
      // only bubble-append here if appendChatMessage was skipped (active non-everyone already returned early)
      if (activeChannelId === 'everyone') {
        // appendChatMessage also writes when everyone is active — skip extra bubble
      }
    };

    window.__meetOpenDm = function (id, name, userId) {
      if (!id) return;
      var key = 'dm:' + id;
      if (!chatChannels[key]) {
        chatChannels[key] = {
          id: key,
          title: name || id,
          peerId: id,
          peerUserId: userId || null,
          peerIsGuest: !userId,
          kind: 'dm',
          messages: [],
          unread: 0,
          lastText: '',
          lastAt: 0
        };
      } else {
        if (name) chatChannels[key].title = name;
        if (userId) {
          chatChannels[key].peerUserId = userId;
          chatChannels[key].peerIsGuest = false;
        }
      }
      // Open chat panel then the exact DM thread
      try {
        if (typeof togglePanel === 'function') {
          if (typeof openPanel !== 'undefined' && openPanel !== 'chat') togglePanel('chat');
          else if (typeof openPanel === 'undefined') togglePanel('chat');
        }
        var chatTab = document.querySelector('.side-tab[data-tab="chat"], .rail-btn[data-panel="chat"]');
        if (chatTab && typeof chatTab.click === 'function') {
          // ensure chat surface visible on mobile/desktop
        }
        if (typeof window.__meetTogglePanel === 'function') {
          try { window.__meetTogglePanel('chat'); } catch (_) {}
        }
      } catch (_) {}
      openChatChannel(key);
    };

    window.__meetIngestPrivate = function (msg) {
      var m = msg.message || msg;
      if (!m) return;
      var selfId = currentMeeting && currentMeeting.participantId;
      var selfUserId = currentUser && currentUser.id;

      // Resolve peer — prefer live participant ids; fall back to user ids from DB history
      var otherId = null;
      var otherName = null;
      var otherUserId = null;

      if (m.fromId === selfId) {
        otherId = m.toId;
        otherName = m.toName;
        otherUserId = m.toUserId;
      } else if (m.toId === selfId) {
        otherId = m.fromId;
        otherName = m.fromName;
        otherUserId = m.fromUserId;
      } else if (m.fromUserId && selfUserId && m.fromUserId === selfUserId) {
        otherId = m.toId;
        otherName = m.toName || m._peerName;
        otherUserId = m.toUserId || m._peerUserId;
      } else if (m.toUserId && selfUserId && m.toUserId === selfUserId) {
        otherId = m.fromId;
        otherName = m.fromName;
        otherUserId = m.fromUserId;
      } else if (m._peerUserId || m._peerName) {
        otherUserId = m._peerUserId;
        otherName = m._peerName;
        otherId = m.fromId === selfId ? m.toId : m.fromId;
      }

      if (!otherId && otherUserId) {
        // Find live participant by userId
        var peer = (participants || []).find(function (p) { return p.userId === otherUserId; });
        if (peer) otherId = peer.id || peer.participantId;
        else otherId = 'user:' + otherUserId;
      }
      if (!otherId) return;

      var key = 'dm:' + otherId;
      // Also merge into channel keyed by user if we previously opened via user
      if (!chatChannels[key] && otherUserId) {
        var alt = Object.keys(chatChannels).find(function (k) {
          return chatChannels[k].kind === 'dm' && chatChannels[k].peerUserId === otherUserId;
        });
        if (alt) key = alt;
      }

      if (!chatChannels[key]) {
        chatChannels[key] = {
          id: key,
          title: otherName || otherId,
          peerId: String(otherId).indexOf('user:') === 0 ? null : otherId,
          peerUserId: otherUserId || null,
          peerIsGuest: !otherUserId,
          kind: 'dm',
          messages: [],
          unread: 0,
          lastText: '',
          lastAt: 0
        };
      }
      // Deduplicate optimistic local messages: same text from me within 15s
      if (m.id && channelHasMsg(chatChannels[key], m)) return;
      if (m.fromId === selfId || (m.fromUserId && selfUserId && m.fromUserId === selfUserId)) {
        var dup = (chatChannels[key].messages || []).some(function (x) {
          return x._optimistic && x.text === m.text && Math.abs((x.at || 0) - (m.at || Date.now())) < 15000;
        });
        if (dup) {
          // Upgrade optimistic entry with server id
          for (var i = 0; i < chatChannels[key].messages.length; i++) {
            var x = chatChannels[key].messages[i];
            if (x._optimistic && x.text === m.text) {
              x.id = m.id || x.id;
              x._optimistic = false;
              break;
            }
          }
          return;
        }
      }

      if (!channelHasMsg(chatChannels[key], m)) {
        chatChannels[key].messages.push(m);
      }
      chatChannels[key].lastText = m.text || '';
      chatChannels[key].lastAt = m.at || Date.now();
      if (otherName) chatChannels[key].title = otherName;
      if (otherUserId) {
        chatChannels[key].peerUserId = otherUserId;
        chatChannels[key].peerIsGuest = false;
      }
      if (otherId && String(otherId).indexOf('user:') !== 0) {
        chatChannels[key].peerId = otherId;
      }

      if (activeChannelId !== key) {
        chatChannels[key].unread = (chatChannels[key].unread || 0) + 1;
      } else {
        var box = document.getElementById('chatMessages');
        if (box) appendBubbleToBox(box, m);
      }
      updateChatBadge();
      var inbox = document.getElementById('chatInbox');
      if (inbox && !inbox.classList.contains('hidden')) renderChatInbox();
    };

    window.__meetIngestPrivateHistory = function (messages) {
      if (!Array.isArray(messages)) return;
      messages.forEach(function (m) {
        window.__meetIngestPrivate({ message: m });
      });
      Object.keys(chatChannels).forEach(function (k) {
        if (String(k).indexOf('dm:') === 0) chatChannels[k].unread = 0;
      });
      updateChatBadge();
      if (activeChannelId && String(activeChannelId).indexOf('dm:') === 0) {
        rerenderActiveChannel();
      }
    };

    window.__meetIngestGroupState = function (group) {
      if (!group || !group.id) return;
      var gid = group.id;
      if (!chatChannels[gid]) {
        chatChannels[gid] = {
          id: gid,
          title: group.title || 'Group',
          kind: 'subgroup',
          members: (group.members || []).map(function (m) { return m.id || m; }),
          memberDetails: group.members || [],
          messages: [],
          unread: 0,
          lastText: '',
          lastAt: 0
        };
      } else {
        if (group.title) chatChannels[gid].title = group.title;
        chatChannels[gid].members = (group.members || []).map(function (m) { return m.id || m; });
        chatChannels[gid].memberDetails = group.members || chatChannels[gid].memberDetails;
      }
      if (activeChannelId === gid) {
        setThreadTitle(chatChannels[gid].title);
        renderMembersPanel(chatChannels[gid]);
      }
      var inbox = document.getElementById('chatInbox');
      if (inbox && !inbox.classList.contains('hidden')) renderChatInbox();
    };

    window.__meetIngestGroupChat = function (msg) {
      var m = msg.message || msg;
      if (!m || !m.groupId) return;
      var gid = m.groupId;
      if (!chatChannels[gid]) {
        chatChannels[gid] = {
          id: gid,
          title: 'Group',
          kind: 'subgroup',
          members: [],
          messages: [],
          unread: 0,
          lastText: '',
          lastAt: 0
        };
      }
      // Dedup optimistic
      if (m.id && channelHasMsg(chatChannels[gid], m)) return;
      var selfId = currentMeeting && currentMeeting.participantId;
      if (m.fromId === selfId) {
        var dup = (chatChannels[gid].messages || []).some(function (x) {
          return x._optimistic && x.text === m.text && Math.abs((x.at || 0) - (m.at || Date.now())) < 15000;
        });
        if (dup) {
          for (var i = 0; i < chatChannels[gid].messages.length; i++) {
            var x = chatChannels[gid].messages[i];
            if (x._optimistic && x.text === m.text) {
              x.id = m.id || x.id;
              x._optimistic = false;
              break;
            }
          }
          return;
        }
      }
      if (!channelHasMsg(chatChannels[gid], m)) chatChannels[gid].messages.push(m);
      chatChannels[gid].lastText = m.text || '';
      chatChannels[gid].lastAt = m.at || Date.now();
      if (activeChannelId !== gid) chatChannels[gid].unread = (chatChannels[gid].unread || 0) + 1;
      else {
        var box = document.getElementById('chatMessages');
        if (box) appendBubbleToBox(box, m);
      }
      updateChatBadge();
      var inbox = document.getElementById('chatInbox');
      if (inbox && !inbox.classList.contains('hidden')) renderChatInbox();
    };

    // Lightweight keep-alive: if active thread DOM was wiped, rebuild from channel state
    setInterval(function () {
      try {
        if (!activeChannelId) return;
        var box = document.getElementById('chatMessages');
        var ch = chatChannels[activeChannelId];
        if (!box || !ch) return;
        var view = document.getElementById('chatThreadView');
        if (view && view.classList.contains('hidden')) return;
        if ((ch.messages || []).length > 0 && box.children.length === 0) {
          rerenderActiveChannel();
        }
      } catch (_) {}
    }, 2000);

    var stageChatTop = document.getElementById('stageChatBtnTop');
    if (stageChatTop) stageChatTop.addEventListener('click', function () { togglePanel('chat'); });
    var stageRec = document.getElementById('stageRecordBtn');
    if (stageRec) stageRec.addEventListener('click', function () {
      if (recordingState && (recordingState.status === 'recording' || recordingState.status === 'paused')) return;
      var m = document.getElementById('recordModal');
      if (m) m.classList.remove('hidden');
    });


    function showTab(name) {
      document.querySelectorAll('.side-tab-panel').forEach(function (p) {
        var match = p.getAttribute('data-tab') === name || p.id === name + 'Tab';
        if (match) {
          p.classList.remove('hidden');
          p.classList.add('active');
          p.style.display = 'flex';
        } else {
          p.classList.add('hidden');
          p.classList.remove('active');
          p.style.display = 'none';
        }
      });
      function bindClick(id, fn) {
        var el = document.getElementById(id);
        if (el) el.onclick = fn;
      }
      if (name === 'security') {
        var mount = document.getElementById('securityPanelMount');
        var src = document.getElementById('dynPaneSecurity');
        if (mount && src && !mount.dataset.filled) {
          mount.innerHTML = src.innerHTML;
          mount.dataset.filled = '1';
        }
      }
      if (name === 'more') {
        var mount2 = document.getElementById('morePanelMount');
        var src2 = document.getElementById('dynPaneMore') || document.getElementById('phase2MoreInject');
        if (mount2 && src2 && !mount2.dataset.filled) {
          mount2.innerHTML = src2.innerHTML;
          mount2.dataset.filled = '1';
        }
      }
      if (name === 'media') {
        try { refreshMicDevices(); } catch (_) {}
        bindClick('mediaMicToggle', function () { if (typeof toggleMic === 'function') toggleMic(); });
        bindClick('mediaShareBtn', function () { var s = document.getElementById('shareBtn'); if (s) s.click(); });
        bindClick('mediaRecordBtn', function () { var m = document.getElementById('recordModal'); if (m) m.classList.remove('hidden'); });
      }
      if (name === 'room') {
        try { refreshRoomRaised(); } catch (_) {}
        bindClick('roomCopyLinkBtn', function () {
          var box = document.getElementById('roomLinkBox');
          var inp = document.getElementById('roomLinkInput');
          var link = location.origin + '/?join=' + encodeURIComponent((currentMeeting && currentMeeting.code) || '');
          if (inp) inp.value = link;
          if (box) box.classList.remove('hidden');
          try { navigator.clipboard.writeText(link); } catch (_) {}
        });
        bindClick('roomHandBtn', function () {
          var h = document.getElementById('handBtn') || document.getElementById('raiseHandBtn');
          if (h) h.click();
        });
        bindClick('roomMuteAllBtn', function () { muteAll(); });
        document.querySelectorAll('#roomTab .rail-open-panel').forEach(function (b) {
          b.onclick = function () {
            var g = b.getAttribute('data-goto');
            if (g) { openPanel = null; togglePanel(g); }
          };
        });
      }
      if (name === 'account') {
        bindClick('accThemeBtn', function () { var e = document.getElementById('themeToggle'); if (e) e.click(); });
        bindClick('accHistoryBtn', function () { var e = document.getElementById('historyBtn'); if (e) e.click(); });
        bindClick('accAuthBtn', function () {
          var a = document.getElementById('loginBtn') || document.getElementById('logoutBtn');
          if (a) a.click();
        });
        bindClick('accLeaveBtn', function () {
          if (typeof leaveMeeting === 'function') leaveMeeting();
          else { var e = document.getElementById('leaveBtn'); if (e) e.click(); }
        });
        bindClick('accEndBtn', function () { var e = document.getElementById('endMeetBtn'); if (e) e.click(); });
      }
      if (name === 'chat') {
        if (typeof showChatInbox === 'function') showChatInbox();
      }
      if (name === 'notifications') {
        try { if (typeof renderNotifications === 'function') renderNotifications(); } catch (_) {}
      }
      if (['people', 'notifications', 'notes', 'timeline'].indexOf(name) >= 0) {
        var legacy = document.querySelector('.side-tab[data-tab="' + name + '"]');
        if (legacy) { try { legacy.click(); } catch (_) {} }
      }
    }

    function togglePanel(name) {
      if (!drawer) {
        console.warn('[meet] meetSideDrawer missing');
        return;
      }
      if (openPanel === name) {
        drawer.classList.add('hidden');
        drawer.style.display = 'none';
        openPanel = null;
        rail.querySelectorAll('.rail-btn.active').forEach(function (b) { b.classList.remove('active'); });
        return;
      }
      openPanel = name;
      drawer.classList.remove('hidden');
      drawer.style.display = 'flex';
      drawer.style.width = '300px';
      drawer.style.minWidth = '240px';
      drawer.style.visibility = 'visible';
      drawer.style.opacity = '1';
      rail.querySelectorAll('.rail-btn.active').forEach(function (b) { b.classList.remove('active'); });
      var activeBtn = rail.querySelector('.rail-btn[data-panel="' + name + '"]');
      if (activeBtn) activeBtn.classList.add('active');
      showTab(name);
      // Re-assert drawer after showTab (legacy tab clicks can fight us)
      drawer.classList.remove('hidden');
      drawer.style.display = 'flex';
      console.log('[meet] opened panel', name, 'drawerHidden', drawer.classList.contains('hidden'));
    }
    window.__meetTogglePanel = togglePanel;

    rail.querySelectorAll('.rail-btn.rail-panel').forEach((btn) => {
      btn.addEventListener('click', () => togglePanel(btn.getAttribute('data-panel')));
    });

    // Account / media / room buttons
    document.getElementById('accThemeBtn')?.addEventListener('click', () => document.getElementById('themeToggle')?.click());
    document.getElementById('accHistoryBtn')?.addEventListener('click', () => document.getElementById('historyBtn')?.click());
    document.getElementById('accAuthBtn')?.addEventListener('click', () => {
      document.getElementById('loginBtn')?.click() || document.getElementById('logoutBtn')?.click();
    });
    document.getElementById('accLeaveBtn')?.addEventListener('click', () => {
      if (typeof leaveMeeting === 'function') leaveMeeting();
      else document.getElementById('leaveBtn')?.click();
    });
    document.getElementById('accEndBtn')?.addEventListener('click', () => document.getElementById('endMeetBtn')?.click());
    document.getElementById('mediaMicToggle')?.addEventListener('click', () => {
      if (typeof toggleMic === 'function') toggleMic();
    });
    document.getElementById('mediaShareBtn')?.addEventListener('click', () => document.getElementById('shareBtn')?.click());
    document.getElementById('mediaRecordBtn')?.addEventListener('click', () => {
      document.getElementById('recordModal')?.classList.remove('hidden');
    });
    document.getElementById('roomCopyLinkBtn')?.addEventListener('click', () => {
      const box = document.getElementById('roomLinkBox');
      const inp = document.getElementById('roomLinkInput');
      const link = location.origin + '/?join=' + encodeURIComponent((currentMeeting && currentMeeting.code) || '');
      if (inp) inp.value = link;
      if (box) box.classList.remove('hidden');
      try { navigator.clipboard.writeText(link); if (typeof showToast === 'function') showToast('Link copied'); } catch (_) {}
    });
    document.getElementById('roomLinkCopy')?.addEventListener('click', () => {
      const inp = document.getElementById('roomLinkInput');
      if (inp) { try { navigator.clipboard.writeText(inp.value); if (typeof showToast === 'function') showToast('Copied'); } catch (_) {} }
    });
    document.getElementById('roomHandBtn')?.addEventListener('click', () => {
      document.getElementById('handBtn')?.click() || document.getElementById('raiseHandBtn')?.click();
      refreshRoomRaised();
    });
    document.getElementById('roomMuteAllBtn')?.addEventListener('click', muteAll);
    document.getElementById('peopleMuteAllBtn')?.addEventListener('click', muteAll);
    document.querySelectorAll('.rail-open-panel').forEach((b) => {
      b.addEventListener('click', () => {
        const g = b.getAttribute('data-goto');
        if (g) { openPanel = null; togglePanel(g); }
      });
    });

    function muteAll() {
      if (!isHostLike()) return;
      if (typeof sendWS === 'function') sendWS({ type: 'mute-all' });
      if (typeof showToast === 'function') showToast('Mute all sent');
    }

    async function refreshMicDevices() {
      const sel = document.getElementById('micDeviceSelect');
      if (!sel || !navigator.mediaDevices?.enumerateDevices) return;
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const mics = devices.filter((d) => d.kind === 'audioinput');
        const cur = sel.value;
        sel.innerHTML = '';
        mics.forEach((d) => {
          const o = document.createElement('option');
          o.value = d.deviceId;
          o.textContent = d.label || 'Microphone';
          sel.appendChild(o);
        });
        if (cur) sel.value = cur;
      } catch (_) {}
    }
    document.getElementById('micDeviceSelect')?.addEventListener('change', async (e) => {
      const id = e.target.value;
      try {
        if (room?.localParticipant && id) {
          // LiveKit switch device if API available
          if (typeof room.switchActiveDevice === 'function') {
            await room.switchActiveDevice('audioinput', id);
          }
        }
      } catch (err) { console.warn(err); }
    });

    function refreshRoomRaised() {
      const list = document.getElementById('roomRaisedList');
      if (!list) return;
      list.innerHTML = '';
      (participants || []).filter((p) => p.handRaised).forEach((p) => {
        const li = document.createElement('li');
        li.textContent = p.name || p.id;
        list.appendChild(li);
      });
    }

    // Chat modes group / dm
    function setChatMode(mode) {
      window.__railChatMode = mode;
      document.getElementById('chatSubGroup')?.classList.toggle('active', mode === 'group');
      document.getElementById('chatSubDm')?.classList.toggle('active', mode === 'dm');
      const groupBox = document.getElementById('sideChat');
      const dmHome = document.getElementById('dmHome');
      const dmThread = document.getElementById('dmThread');
      const form = document.getElementById('chatForm');
      if (mode === 'group') {
        if (groupBox) groupBox.classList.remove('hidden');
        // show group messages area
        document.getElementById('chatMessages')?.classList.remove('hidden');
        if (form) form.classList.remove('hidden');
        if (dmHome) dmHome.classList.add('hidden');
        if (dmThread) dmThread.classList.add('hidden');
      } else {
        document.getElementById('chatMessages')?.classList.add('hidden');
        if (form) form.classList.add('hidden');
        if (dmHome) dmHome.classList.remove('hidden');
        if (dmThread) dmThread.classList.add('hidden');
        renderDmHome();
      }
    }
    document.getElementById('chatSubGroup')?.addEventListener('click', () => setChatMode('group'));
    document.getElementById('chatSubDm')?.addEventListener('click', () => setChatMode('dm'));

    function renderDmHome() {
      const conv = document.getElementById('dmConversationList');
      const people = document.getElementById('dmPeopleList');
      if (!conv || !people) return;
      conv.innerHTML = '';
      people.innerHTML = '';
      const threads = Object.keys(dmStore).map((id) => ({ id, ...dmStore[id] }))
        .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
      threads.forEach((th) => {
        const li = document.createElement('li');
        const last = (th.messages && th.messages[th.messages.length - 1]) || {};
        li.innerHTML = '<div class="dm-name"><span>' + escapeHtml(th.name || th.id) + '</span>' +
          (th.unread ? '<span class="dm-unread">' + th.unread + '</span>' : '') + '</div>' +
          '<div class="dm-excerpt">' + escapeHtml(String(last.text || '').slice(0, 60)) + '</div>';
        li.addEventListener('click', () => openDmThread(th.id, th.name));
        conv.appendChild(li);
      });
      const selfId = currentMeeting && currentMeeting.participantId;
      (participants || []).forEach((p) => {
        const id = p.id || p.participantId;
        if (!id || id === selfId) return;
        if (dmStore[id]) return; // already in conversations
        const li = document.createElement('li');
        li.innerHTML = '<div class="dm-name">' + escapeHtml(p.name || id) + '</div>';
        li.addEventListener('click', () => openDmThread(id, p.name));
        people.appendChild(li);
      });
    }

    function openDmThread(id, name) {
      if (!dmStore[id]) dmStore[id] = { name: name || id, messages: [], unread: 0, lastAt: Date.now() };
      dmStore[id].unread = 0;
      dmStore[id].name = name || dmStore[id].name;
      window.__dmTargetId = id;
      document.getElementById('dmHome')?.classList.add('hidden');
      const thread = document.getElementById('dmThread');
      if (thread) thread.classList.remove('hidden');
      const box = document.getElementById('dmThreadMessages');
      if (box) {
        box.innerHTML = '';
        (dmStore[id].messages || []).forEach((m) => {
          const el = document.createElement('div');
          el.className = 'chat-msg';
          el.innerHTML = '<strong>' + escapeHtml(m.fromName || '') + ':</strong> ' + escapeHtml(m.text || '');
          box.appendChild(el);
        });
        box.scrollTop = box.scrollHeight;
      }
      // ensure chat panel open
      if (openPanel !== 'chat') togglePanel('chat');
      setChatMode('dm');
      document.getElementById('dmHome')?.classList.add('hidden');
      document.getElementById('dmThread')?.classList.remove('hidden');
    }
    window.__meetOpenDm = function (id, name) {
      if (openPanel !== 'chat') togglePanel('chat');
      setChatMode('dm');
      openDmThread(id, name);
    };
    document.getElementById('dmBackBtn')?.addEventListener('click', () => {
      document.getElementById('dmThread')?.classList.add('hidden');
      document.getElementById('dmHome')?.classList.remove('hidden');
      window.__dmTargetId = null;
      renderDmHome();
    });
    document.getElementById('dmForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = document.getElementById('dmInput');
      const text = (input && input.value || '').trim();
      const targetId = window.__dmTargetId;
      if (!text || !targetId) return;
      if (typeof sendWS === 'function') sendWS({ type: 'private-chat', targetId, text });
      // optimistic
      const selfName = (participants || []).find((p) => p.id === currentMeeting?.participantId)?.name || 'You';
      const msg = { fromId: currentMeeting?.participantId, fromName: selfName, text, at: Date.now() };
      if (!dmStore[targetId]) dmStore[targetId] = { name: '', messages: [], unread: 0 };
      dmStore[targetId].messages.push(msg);
      dmStore[targetId].lastAt = Date.now();
      if (input) input.value = '';
      openDmThread(targetId, dmStore[targetId].name);
    });

    // Stage footer
    let hideTimer = null;
    const stage = document.getElementById('bigView') || document.querySelector('.big-view') || document.getElementById('col2');
    const footer = document.getElementById('stageHoverChrome');
    function showFooter() {
      if (!footer) return;
      footer.classList.remove('hidden');
      footer.classList.add('visible');
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => footer.classList.remove('visible'), 2200);
    }
    if (stage) {
      stage.addEventListener('mousemove', showFooter);
      stage.addEventListener('mouseleave', () => {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => footer?.classList.remove('visible'), 400);
      });
    }
    let lastRxClick = 0;
    document.getElementById('stageReactRow')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.emoji-btn');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      if (btn.id === 'stageHandBtn') {
        document.getElementById('handBtn')?.click() || document.getElementById('raiseHandBtn')?.click();
        return;
      }
      if (btn.id === 'stageMicBtn') {
        if (typeof toggleMic === 'function') toggleMic();
        return;
      }
      if (btn.id === 'stageFsBtn') {
        document.getElementById('fullscreenBtn')?.click();
        return;
      }
      const emoji = btn.getAttribute('data-emoji');
      if (!emoji) return;
      const now = Date.now();
      if (now - lastRxClick < 350) return;
      lastRxClick = now;
      if (typeof sendWS === 'function') {
        sendWS({
          type: 'reaction',
          emoji,
          fromName: (participants || []).find((p) => p.id === currentMeeting?.participantId)?.name || currentMeeting?.name || 'Me',
        });
      }
    });

    // Circles only for active shares
    function initials(name) {
      const s = String(name || '?').trim();
      const parts = s.split(/\s+/);
      if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
      return s.slice(0, 2).toUpperCase();
    }
    function refreshStageCards() {
      const cluster = document.getElementById('stageCardsCluster');
      if (!cluster) return;
      cluster.innerHTML = '';
      const sharers = (participants || []).filter((p) => p.sharing);
      // also DOM live cards
      document.querySelectorAll('#screenCards .screen-card.live, #screenCards [data-sharing="1"]').forEach((c) => {
        const name = c.getAttribute('data-name') || c.textContent;
        if (name && !sharers.find((s) => s.name === name)) sharers.push({ name, sharing: true, el: c });
      });
      sharers.forEach((it, idx) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'stage-card-circle live' + (idx > 2 ? ' stage-card-extra' : '');
        b.textContent = initials(it.name);
        b.title = it.name || '';
        b.addEventListener('click', () => { try { it.el?.click(); } catch (_) {} });
        cluster.appendChild(b);
      });
      // idle background vs share
      const big = document.getElementById('bigView') || document.querySelector('.big-view');
      if (big) big.classList.toggle('has-active-share', sharers.length > 0);
    }
    setInterval(refreshStageCards, 1500);

    // Talking wavelength via LiveKit audio levels when available
    setInterval(() => {
      try {
        if (!room) return;
        const parts = room.remoteParticipants ? [...room.remoteParticipants.values()] : [];
        if (room.localParticipant) parts.push(room.localParticipant);
        parts.forEach((lp) => {
          const id = lp.identity || lp.sid;
          let speaking = false;
          try {
            if (typeof lp.isSpeaking === 'boolean') speaking = lp.isSpeaking;
            else if (lp.audioLevel != null) speaking = lp.audioLevel > 0.05;
          } catch (_) {}
          // match participant list by name/identity
          document.querySelectorAll('[data-wave-for]').forEach((w) => {
            const pid = w.getAttribute('data-wave-for');
            const p = (participants || []).find((x) => x.id === pid);
            if (!p) return;
            const match = p.id === id || p.name === lp.name || (lp.identity && String(lp.identity).includes(p.id));
            if (match) w.classList.toggle('hidden', !speaking);
          });
        });
      } catch (_) {}
    }, 200);

    // Legacy dmStore bridge — prefer the premium channel inbox (__meetIngestPrivate
    // is defined earlier in the chatChannels block; only fill gaps for old UI).
    if (typeof window.__meetIngestPrivate !== 'function') {
      window.__meetIngestPrivate = function (msg) {
        const m = msg.message || msg;
        if (!m) return;
        const selfId = currentMeeting && currentMeeting.participantId;
        const otherId = m.fromId === selfId ? m.toId : m.fromId;
        const otherName = m.fromId === selfId ? m.toName : m.fromName;
        if (!otherId) return;
        if (!dmStore[otherId]) dmStore[otherId] = { name: otherName || otherId, messages: [], unread: 0 };
        dmStore[otherId].messages.push(m);
        dmStore[otherId].lastAt = m.at || Date.now();
        dmStore[otherId].name = otherName || dmStore[otherId].name;
        if (window.__dmTargetId !== otherId) dmStore[otherId].unread = (dmStore[otherId].unread || 0) + 1;
        else if (typeof openDmThread === 'function') openDmThread(otherId, dmStore[otherId].name);
        const badge = document.getElementById('railChatBadge');
        if (badge) {
          const total = Object.values(dmStore).reduce((s, th) => s + (th.unread || 0), 0);
          badge.textContent = total ? String(total) : '';
          badge.classList.toggle('hidden', !total);
        }
        if (window.__railChatMode === 'dm' && window.__dmTargetId !== otherId && typeof renderDmHome === 'function') renderDmHome();
      };
    }

    // Notifications badge on people? use rail - sync notif into list when events happen
    // Bridge: patch addNotification to also update a rail badge if we add notifications slot under room
    const _add = window.__meetAddNotification;
    // ensure join/hand notifs still work - open people/notifications via room
    setInterval(() => {
      try {
        const end = document.getElementById('accEndBtn');
        const muteAll = document.getElementById('roomMuteAllBtn');
        const muteAll2 = document.getElementById('peopleMuteAllBtn');
        const show = isHostLike();
        if (end) end.classList.toggle('hidden', !show);
        if (muteAll) muteAll.classList.toggle('hidden', !show);
        if (muteAll2) muteAll2.classList.toggle('hidden', !show);
        const n = Array.isArray(participants) ? participants.length : 0;
        const b = document.getElementById('railPeopleBadge');
        if (b) b.textContent = String(n || '');
      } catch (_) {}
    }, 1200);

    // Artifact modes
    try {
      const path = location.pathname;
      const params = new URLSearchParams(location.search);
      if (path.match(/^\/m\/[^/]+\/[^/]+/)) document.body.classList.add('artifact-readonly');
      if (params.get('restart') === '1') document.body.classList.add('artifact-restarted');
    } catch (_) {}

    // Strengthen chat: single form submit path, prevent double
    const chatForm = document.getElementById('chatForm');
    if (chatForm && !chatForm.__railBound) {
      chatForm.__railBound = true;
      chatForm.addEventListener('submit', (e) => {
        // if DM mode somehow, ignore group send
        if (window.__railChatMode === 'dm') {
          e.preventDefault();
          e.stopPropagation();
        }
      }, true);
    }

    // Recording mini
    setInterval(() => {
      const mini = document.getElementById('recMiniControls');
      if (!mini) return;
      const active = recordingState && (recordingState.status === 'recording' || recordingState.status === 'paused');
      if (mini) mini.classList.remove('hidden');
      const pauseBtn = document.getElementById('recPauseBtn');
      const stopWrap = mini && mini.querySelector('.rec-mini-hover');
      const recDot = document.getElementById('stageRecordBtn');
      if (pauseBtn) {
        pauseBtn.classList.toggle('hidden', !active);
        if (active && recordingState) {
          pauseBtn.innerHTML = recordingState.status === 'paused'
            ? '<i class="fa-solid fa-play"></i>'
            : '<i class="fa-solid fa-pause"></i>';
        }
      }
      if (recDot) recDot.classList.toggle('hidden', !!active);
    }, 500);
  })();

  // private-chat delivered via extraHandlers only (no duplicate onmessage hook)





  document.getElementById('peopleNotifBtn')?.addEventListener('click', () => {
    if (typeof window.__meetTogglePanel === 'function') window.__meetTogglePanel('notifications');
    else {
      document.querySelector('.side-tab[data-tab="notifications"]')?.click();
      document.getElementById('meetSideDrawer')?.classList.remove('hidden');
    }
  });

})();
