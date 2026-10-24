# Design Doc — App Login/Logout/Profile & Castline-Style UI

**Status:** Draft (awaiting review before finalizing)
**Scope:** `youtube-video-scheduler` — `public/` frontend, `src/routes`, `src/middleware`, `src/services/auth.js`, `src/db.js` (schema), `src/server.js`, `config.js`, `Dockerfile`/`docker-compose.yml`, env.
**Owner:** author of this repo

---

## 1. Problem

Two needs came in together:

2. **Castline UI parity** — `castline-ui/` is a React + TanStack + Tailwind-v4 + shadcn-style "studio desk" app. The team wants our scheduler to look and behave similarly (dark canvas surfaces, amber `signal` accent, sage "online" indicator, fixed sidebar + sticky header, rounded cards, status pills, `Outfit` + `Fraunces` typography).
3. **Google SSO login** — add Google as an *app-login* identity (in addition to email/password): sign in with Google → identify the app user from the id_token → session cookie. This reuses the Google OAuth wiring already used for channel connect, so no new provider credentials are needed.
4. **Login / Logout / Profile** — the app should have its own account layer (email/password **and** Google) so the scheduler UI is gated, independent of (but complementary to) the existing Google/YouTube OAuth channel-connect flow.

## 2. Goals

- Ship a **login/logout/profile** feature with a real, gated session — not just decorative links.
- Match the **Castline aesthetic** without introducing a React/Tailwind build pipeline (our frontend stays a single static HTML + vanilla JS file served by Express).
- Keep the **PostgreSQL-in-Docker / SQLite-on-host** dual-driver architecture.
- **No native modules in the Docker image** (avoid the `better-sqlite3` linux/arm64 segfault that was hit earlier).
- Keep the scheduler **worker untouched** — it talks to the DB directly, so uploads keep running regardless of app login.
- Make every timestamp the user sees/editing **browser-local**, not UTC-shifted.

## 3. Non-goals (v1)

- Single-Sign-On with Google for the *app* login (future: reuse the YouTube OAuth as the app identity). For now it is a separate email/password account.
- RBAC / roles / teams / invite links.
- Password reset / email verification.
- Server-side-rendered routing — the UI is hash-route single-page.

3. **No native modules in the Docker image** (avoid the `better-sqlite3` linux/arm64 segfault that was hit earlier).

## 4. Architecture

```
                browser
                  |
                  |  cookie: scheduler_auth (httpOnly, SameSite=Lax, base64 JWT)
                  v
  Express API (src/server.js)                    Background worker (src/worker.js)
  ├─ GET  /            → redirect /login if no session
  ├─ static public/   → index.html | login.html | assets
  ├─ GET  /login      → serves login.html
  ├─ GET  /api/auth/google    ─┐ (Google SSO login)
  │  GET  /auth/google/callback ─┘ (exchanges code, verifies id_token, upserts
  │             a users row by google_sub, sets cookie, → "/")
  ├─ POST /api/auth/register        ─┐  requireAuth ─┐
  │  POST /api/auth/login          │                │
  │  POST /api/auth/logout         │                │
  │  GET  /api/auth/profile        ├─ gated ──┐    │  POST /api/auth/channels/:id/deactivate
  │  PATCH/api/auth/profile        │           │    │
  ├─ GET  /api/auth/connect       │  open      │    │  (channels/deact are gated)
  ├─ GET  /auth/callback          │  (YouTube scope) │
  │                               │                    │
  │  POST /api/videos   ──────────┘  requireAuth (jobsRouter)──┘
  │  GET  /api/videos/:id
  │  PATCH /api/videos/:id     (edit pending job metadata)
  │  DELETE/api/videos/:id
  │
  └─ GET  /api/health          (always open — used by compose healthcheck)
                  |
                  v
        users (pg | sqlite)        jobs / channels / uploads
```

Two app-login methods (both land in the same `users` table and issue the same
session cookie):

- **Email/password** — `POST /api/auth/register` / `POST /api/auth/login` (bcryptjs).
- **Google SSO** — `GET /api/auth/google` → Google consent (openid, email, profile) → `GET /auth/google/callback` → verify the Google `id_token` → upsert `users` by `google_sub` → sign the same JWT → set cookie → redirect `/`. Reusing the existing Google OAuth client; the SSO flow requests `openid email profile` *in addition to* the YouTube scopes only when channel connect is needed.

### Component map (new / changed files)

| File | Change |
|------|--------|
| `src/services/auth.js` (new) | `bcryptjs` hashing (cost 10), `jsonwebtoken` sign/verify, `currentUser(req)` (cookie parse), `issueAuthCookie`/`clearAuthCookie`, `safeUser`, `seedDefaultUser`, `googleCallback(code)` (id_token verify + upsert). |
| `src/middleware/auth.js` (new) | `requireAuth` express middleware (401 JSON on miss). |
| `src/routes/session.js` (new) | `/register`, `/login`, `/logout`, `/profile` GET, `/profile` PATCH; `GET /google` (redirect) + `GET /google/callback`. |
| `src/db.js` | add `users(...)` table to `schema`; add `queries.{insertUser, findUserByEmail, findUserById, updateUser, userCount}` — all `@name` params + `RETURNING`. |
| `src/server.js` | mount `sessionRouter` at `/api/auth`; gate `jobsRouter` + channels/deactivate behind `requireAuth`; add `GET /login` (serve `login.html`); `GET /` redirects to `/login` when unauthed; call `seedDefaultUser` after `initDb`. |
| `src/routes/auth.js` | apply `requireAuth` to `GET /channels` and `POST /channels/:id/deactivate` (keep `/connect` + `/callback` public). |
| `public/index.html` | rewrite in Castline palette/fonts/layout; header shows user (profile/logout) + connected channel dot; add **Profile (Settings)** section; `api()` fetch wrapper that bounces to `/login` on 401; filename-fallback on title; browser-local `datetime-local`. |
| `public/login.html` (new) | Castline-styled sign-in/register page with a **"Sign in with Google"** button alongside the email form. |
| `src/config.js` | add `config.auth.{require, jwtSecret, jwtExpires, cookieName, cookieMaxAge, cookieSecure, seedEmail, seedPassword}`, `parseBool`. |
| `Dockerfile` / `docker-compose.yml` | pin `jsonwebtoken` + `bcryptjs` (pure-JS); pass `JWT_SECRET` (via `.env`); `REQUIRE_AUTH` defaults on. |
| `.env` / `.env.example` | `REQUIRE_AUTH`, `LOGIN_EMAIL`, `LOGIN_PASSWORD`, `JWT_SECRET`. |
| `README.md` | Auth section + API table. |
| `tests/scheduler.test.js` | unchanged (tests exercise DB/scheduler directly; auth is HTTP-only). **Still 3/3.** |

## 5. Data model

```sql
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,        -- uuid
  email         TEXT NOT NULL UNIQUE,
  name          TEXT,
  password_hash TEXT,                    -- NULL for Google-only accounts
  google_sub    TEXT UNIQUE,             -- Google "sub" claim (NULL for email/password)
  avatar        TEXT,                    -- optional https url
  created_at    BIGINT NOT NULL,         -- epoch seconds
  updated_at    BIGINT NOT NULL          -- epoch seconds
);
```

- A `users` row can be **email/password** (`google_sub` NULL, `password_hash` set), **Google** (`google_sub` set, `password_hash` NULL), or both (`google_sub` set **and** a password added later).
- The `channels` table (OAuth) is untouched. Profiles are stored independently of YouTube channels.

## 6. Security

- **Password storage:** `bcryptjs`, cost 10. (Pure-JS to avoid native build in Docker/arm64.)
- **Session:** a JWT signed with `JWT_SECRET` (HS256) — dev placeholder by default, **must be overridden in prod** — stored in an httpOnly `SameSite=Lax` cookie (`scheduler_auth`); `Secure` flag via `AUTH_COOKIE_SECURE` (off on local HTTP; on behind TLS).
- **No password ever returned** by any endpoint (`safeUser` strips `password_hash`).
- **Gate surface:** `/api/videos`, `/api/auth/channels`, `/api/auth/channels/:id/deactivate`, `/api/auth/profile` require auth; `/api/health`, `/api/auth/{register,login,logout,google}`, `/auth/google/callback`, `/api/auth/connect`, `/auth/callback`, `/login`, `/`(static html) are public; `/` redirects unauthed users to `/login`.
- **Default admin seed:** created on first start only if the `users` table is empty — `admin@scheduler.local` / `scheduler` (overridable via `LOGIN_EMAIL`/`LOGIN_PASSWORD`). Server logs a loud warning. **Operator must change these before sharing.** Opt out with `REQUIRE_AUTH=0` (no seeding, no gating — e.g. behind an external reverse-proxy auth).
- **Google SSO:** `GET /api/auth/google` redirects to Google with `openid email profile` (+ YouTube scopes only when channel connect is needed); the callback verifies the Google **id_token** (signature + `aud` == `GOOGLE_CLIENT_ID` + expiry) using the same `google.auth.OAuth2` client already used for channel connect — no shared secret stored. The Google `sub` is upserted into `users.google_sub`; the `email`/`name`/`avatar` come from the id_token claims (trusted, not attacker-controlled).
- **OAuth client_secret** stays in `secrets.json` (never in the image), unchanged.

## 7. API (auth subset)

| Method | Path | Body | Auth | Returns |
|--------|------|------|------|---------|
| POST | `/api/auth/register` | `{name,email,password}` | ✗ | `201` user; sets cookie |
| POST | `/api/auth/login` | `{email,password}` | ✗ | `200` user + `channels` |
| GET  | `/api/auth/google` | — | ✗ | 302 → Google consent (openid/email/profile) |
| GET  | `/auth/google/callback` | `?code=` | ✗ | verifies id_token, upserts user by `google_sub`, sets cookie, 302 → `/` |
| POST | `/api/auth/logout` | — | optional | `200 {ok:true}`; clears cookie |
| GET  | `/api/auth/profile` | — | ✓ | current user |
| PATCH| `/api/auth/profile` | `{name?, avatar?}` | ✓ | updated user |
| GET  | `/login` | — | ✗ | `login.html` |
| GET  | `/` | — | (cookie?) | `index.html` or 302 → `/login` |

Validation: `password >= 6`, `email` normalized to lowercase, duplicate email (or duplicate `google_sub`) → `409`, bad creds → `401` with a generic message (no user enumeration). Google callback: verify `aud === GOOGLE_CLIENT_ID`, `exp`, and `email_verified === true`; reject otherwise.

## 8. Frontend (Castline parity)

- **Palette** (CSS custom props, verbatim from `castline-ui/src/styles.css`): canvas `#100e0c`, surface `#1b1814`, surface-2 `#262119`, fg `#f4efe6`, muted `#c2b6a8`, faint `#8f8478`, line `#3a332b`, signal (amber) `#e6a23c` (+ ink `#1a1206`), sage `#8eae82`, coral `#e07a68`. Radius md/lg. `Outfit`/`Fraunces` from Google Fonts.
- **Layout:** horizontal **top tab bar** (`Castline / Studio desk` brand at left | tabs Desk/Schedule/Queue/Channels/Settings centered | "New upload" amber button + channel dot at right) + sticky header. No fixed sidebar (content spans the full width).
- **Header channel:** green sage dot + `✓ <channel>` when a channel is connected, else amber dot + "Connect Channel".
- **/login:** centered surface card, Fraunces heading, `field` inputs, amber primary button, login/register toggle, inline error pill, **and a "Sign in with Google" button** (calls `GET /api/auth/google`).
- **Desk card:** `/api/health` table (status pill, db driver, mode, channels, uptime).
- **Queue card:** jobs table with tone-mapped status pills (pending→amber, done→green, failed/exhausted→coral, deleted→faint), edit button for `pending` jobs, details link.
- **Profile (Settings) card:** display name editor + email (read-only) + Logout.
- **Time correctness:** `datetime-local` built from the stored epoch via `toLocalDateTime()` (local components, **not** UTC `toISOString`); on save the browser sends an **absolute UTC ISO** so the (UTC) container stores the right epoch. Human-readable times use `toLocaleString()` (browser-local).

## 9. Config reference (new env)

| Var | Default | Note |
|-----|---------|------|
| `REQUIRE_AUTH` | `true` | Gate `/api/videos` + channels. `0` = open. |
| `LOGIN_EMAIL` | `admin@scheduler.local` | Seeded admin on empty DB. |
| `LOGIN_PASSWORD` | `scheduler` | Seeded admin password — **change me**. |
| `JWT_SECRET` | `dev-change-me-in-prod` | Sign key — **change in prod**. |
| `AUTH_COOKIE_NAME` | `scheduler_auth` | Cookie name. |
| `AUTH_COOKIE_SECURE` | `false` | Set `1` behind TLS. |
| `JWT_EXPIRES_IN` | `7d` | Token TTL. |

Existing vars (`PORT`, `DB_DRIVER`, `DRY_RUN`, Google OAuth, quota/backoff) are unchanged.

## 10. Deployment

- `docker compose up --build -d` — api, worker, postgres on `:3001`; DB=pg; `secrets.json` mounted at `/run/secrets/google_creds`. Auth env flows from `.env` via compose `env_file`.
- Host fallback (`scripts/start.sh`): if Docker is down, runs `node src/server.js` + `node src/worker.js` on SQLite + dry-run; auth still works (default admin seeded).
- `npm test` (host SQLite): unaffected — **3/3**.
- `npm start` / `npm stop` convenience scripts.

## 11. Validation plan (awaiting review / status)

> **Implementation state:** the **email/password login + logout + profile** and the **Castline-style UI** are already built (see §4 component map) and validated green as noted below. The **Google SSO login** (`GET /api/auth/google` + `/auth/google/callback`) is specified here for review and is **not yet implemented** — it is blocked on `authCallback`/id_token handling in `services/auth.js` + `routes/session.js` until the design is approved.

- Host tests: `npm test` → 3/3 (scheduler dry-run; backoff; rotation).
- Auth flow (curl + cookie jar): unauthed `/`→302→`/login`; register→201; login→200+cookie; `/api/profile` 200; `/api/videos` 200 with cookie / 401 without; profile PATCH 200; logout→cookie cleared; post-logout `/api/videos`→401.
- Seeded default admin (`admin@scheduler.local`/`scheduler`) present in PG after boot.
- `/login` → 200; authed `/` renders profile/logout/edit/connect/channel-toggle/nav/fonts/palette tokens.
- `node --check` on the inlined app script: OK.
- Worker stays healthy across rebuild (unaffected by auth gating).
- Real upload still live at `https://youtu.be/49QOlpTC0j4`.

## 12. Rollback

- Set `REQUIRE_AUTH=0` (or unset → defaults to `true`... so explicitly `0`) and rebuild api: gating is disabled, `/` serves `index.html` directly again, and auth endpoints remain but are simply unused. The `users` table is additive (no schema rollback needed). `git revert` of this change set restores the original single-page UI + open API.
- Removing the `users` table is non-destructive to `channels`/`jobs`/`uploads`.

## 13. Open questions for review

1. **Google SSO:** now in design §4/§6/§7 (id_token verify, upsert by `google_sub`). Confirm the chosen scopes (`openid email profile`) and whether Google login should *also* request the YouTube scopes up-front (to combine "log in" + "connect channel" in one click) or stay minimal. Approve and I'll implement `routes/session.js` Google routes + `services/auth.js` `googleCallback`.
2. **Gating default:** Keep `REQUIRE_AUTH=true` by default (scheduler needs login), or ship open-by-default and let ops opt in?
3. **Default admin seed:** Ship `admin@scheduler.local` / `scheduler` (convenient, weak), or require an explicit `LOGIN_EMAIL`/`LOGIN_PASSWORD` env pair before the app will even start/login?
4. **Password reset / email verification:** out of scope now, but do you want a placeholder roadmap?
5. **Profile fields beyond `name`:** avatar url, timezone preference, default channel? (Currently only editable `name`.)

---

*Awaiting review before finalizing. Respond with any changes and I'll adjust the implementation to match before we ship.*
