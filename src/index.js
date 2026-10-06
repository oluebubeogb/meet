/**
 * Meet server — Phase 1 modular entry
 * Wires config, HTTP routes, WebSocket hub, and lifecycle cleanup.
 */
const http = require('http');
const db = require('../db');
const config = require('./config');
const { createRequestHandler } = require('./http/routes');
const { attachWebSocket } = require('./ws/hub');
const { cleanupInactiveMeetings } = require('./rooms/lifecycle');
const { isLiveKitConfigured } = require('./livekit/tokens');
const { features } = require('./lib/features');

function start() {
  // Phase 1: init DB (Postgres or SQLite) before accepting traffic
  db.ensureReady().catch((e) => {
    console.error('[FATAL] DB init failed:', e);
    process.exit(1);
  });

  const handleRequest = createRequestHandler();
  const server = http.createServer((req, res) => {
    Promise.resolve(handleRequest(req, res)).catch((err) => {
      console.error('[http]', req.method, req.url, err);
      if (!res.headersSent) {
        try {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message || 'Server error' }));
        } catch (_) {}
      }
    });
  });
  attachWebSocket(server);

  server.listen(config.PORT, '0.0.0.0', () => {
    console.log(`Meet is running at http://0.0.0.0:${config.PORT}`);
    console.log(db.USE_PG ? "[DB] PostgreSQL (DATABASE_URL)" : `[DB] SQLite at ${db.DB_PATH}`);
    console.log('[features]', JSON.stringify(features));
    if (!isLiveKitConfigured()) {
      console.warn(
        '[WARN] LiveKit env vars not fully set — screenshare/audio need LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET.'
      );
    } else {
      console.log(`[LiveKit] clients will connect to ${config.LIVEKIT_URL}`);
    }
    if (config.JWT_SECRET === 'change-me-in-production-meet-secret-key-32chars') {
      console.warn('[WARN] Using default JWT_SECRET — set JWT_SECRET in production.');
    }
    if (config.ACCOUNTS_URL) {
      console.log(`[Accounts] SSO enabled → ${config.ACCOUNTS_URL}`);
    } else {
      console.log('[Accounts] ACCOUNTS_URL not set — using local Meet auth only');
    }
    setInterval(cleanupInactiveMeetings, config.MEETING_CLEANUP_INTERVAL_MS);
    console.log(
      `[meeting] inactivity cleanup every ${config.MEETING_CLEANUP_INTERVAL_MS / 60000} min ` +
        `(kill after ${config.MEETING_INACTIVITY_MS / 3600000}h)`
    );
    console.log('[modular] Phase 1 server modules loaded from src/');
  });

  return server;
}

module.exports = { start };

if (require.main === module) {
  start();
}
