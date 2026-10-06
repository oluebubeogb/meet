# Meet (Phase 1)

Collaborative meeting rooms with **screen share** and **audio**, powered by LiveKit.

**Phase 1 (v1.6.0):**
- PostgreSQL when `DATABASE_URL` is set (SQLite fallback otherwise)
- Artifacts: permanent `/m/{code}/{slug}` archives after meetings end
- State reset between meetings, recording UX improvements, UI quick wins

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Phase 1 prod | `postgresql://user:pass@host:5432/meet` |
| `DATA_DIR` | no | SQLite path / file storage (default `./data`) |
| `JWT_SECRET` | **yes in prod** | Session secret |
| `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | **yes** | LiveKit |

## Local

```bash
npm install
cp .env.example .env
# optional: set DATABASE_URL for Postgres 18
node server.js
```

## Coolify

1. Postgres 18 service → create DB `meet`
2. Meet Dockerfile resource
3. Env: `DATABASE_URL`, `JWT_SECRET`, LiveKit keys
4. Volume `/app/data` (files / SQLite fallback)
5. Domain + SSL, health `/health`

Migrate existing SQLite:

```bash
DATABASE_URL=... DATA_DIR=/app/data npm run migrate:sqlite-to-pg
```

See `../PHASE1_SPEC.md` and `../DEPLOY_GUIDE.md`.

# Meet

Collaborative meeting rooms with **screen share** and **audio calls**, powered by [LiveKit](https://livekit.io).

- **Sign up / log in** — local SQLite auth, or **Collab Accounts** SSO when `ACCOUNTS_URL` is configured
- **Meeting history** — past meetings you hosted or joined, with participant log
- Create a meeting → short code (`ABC—123`)
- Join with the code (guests allowed without login)
- Share screen + microphone via LiveKit SFU

---

## Architecture

| Component | Role |
|-----------|------|
| **Meet app** | HTTP API, static UI, presence WebSocket, LiveKit tokens, auth |
| **SQLite** | Users + meeting history (file under `DATA_DIR`) |
| **LiveKit server** | Real-time audio & screen-share (self-hosted or Cloud) |

Active meetings stay in memory for low latency. History and accounts are persisted in SQLite so they survive restarts.

---

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | no | Default `1880` |
| `DATA_DIR` | no | SQLite folder (default `./data` or `/app/data` in Docker) |
| `JWT_SECRET` | **yes in prod** | Secret for login tokens |
| `JWT_TTL` | no | Token lifetime (default `30d`) |
| `LIVEKIT_URL` | **yes** | e.g. `wss://livekit.example.com` |
| `LIVEKIT_API_KEY` | **yes** | LiveKit API key |
| `LIVEKIT_API_SECRET` | **yes** | LiveKit API secret |
| `ACCOUNTS_URL` | no | Collab Accounts base URL (e.g. `https://accounts.collab.name.ng`). Enables suite SSO. |
| `ACCOUNTS_JWT_SECRET` / `ACCOUNTS_SECRET_KEY` | no | Same `SECRET_KEY` as Accounts for local token verification |

When `ACCOUNTS_URL` is set, Meet login/signup proxies to Accounts and grants access under the **meet** product. Guests can still join without an account.

---

## Local development

```bash
npm install
cp .env.example .env
# edit .env — at least JWT_SECRET; LiveKit if testing media
node server.js
# http://localhost:1880
```

SQLite file is created at `./data/meet.db` (or `DATA_DIR`).

---

## Deploy on Coolify (GitHub)

Repo: `git@github.com:oluebubeogb/meet.git`

1. Push this project to GitHub.
2. Coolify → New Resource → Repository → **Dockerfile**.
3. Set env vars: `JWT_SECRET`, `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.
4. **Persistent storage**: mount a volume on `/app/data` so users and history survive redeploys.
5. Attach domain + SSL. Deploy.

Health check: `/health`.

### Coolify volume tip

In the service settings, add a persistent volume:

- Destination path: `/app/data`

Without this, the SQLite file is lost when the container is recreated.

---

## Self-hosted LiveKit

Same as before — run `livekit/livekit-server` + Redis on the VPS with UDP `50000–60000` open, TLS on your LiveKit domain, and matching API key/secret in the Meet env.

See previous deploy notes or https://docs.livekit.io/deploy/vm/

---

## Auth & history API

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `POST` | `/api/signup` | no | `{ username, email, password }` |
| `POST` | `/api/login` | no | `{ login, password }` (email or username) |
| `GET` | `/api/me` | Bearer | Current user |
| `GET` | `/api/history` | Bearer | Your meeting history |
| `GET` | `/api/history/:id` | Bearer | Meeting + participant log |

Guests can still create/join without an account. If logged in, the host/joiner is linked to the user and appears in history.

Passwords are hashed with bcrypt. Sessions use JWT stored in the browser (`localStorage`).

---

## Push to GitHub

```bash
git init
git add .
git commit -m "Meet: LiveKit media, SQLite auth + meeting history, Docker"
git branch -M main
git remote add origin git@github.com:oluebubeogb/meet.git
git push -u origin main
```

---

## Notes

- Active rooms are in-memory (gone on restart); **history** is in SQLite and persists.
- Max 20 participants per live room.
- Media needs HTTPS (or localhost) and a working LiveKit server.
- Change `JWT_SECRET` in production.
