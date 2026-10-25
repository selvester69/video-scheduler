# YouTube Video Scheduler

Schedule videos to automatically upload to one (or many) YouTube channels on a
future date/time — with a **title**, **description**, **hashtags**, **tags**,
and **privacy** — while a rate-limit-aware worker avoids YouTube quotas.

This is `video-scheduler`: the repo is intentionally about scheduling, not about
running your own video CDN.

## How it avoids rate limiting

YouTube's Data API v3 is governed by **daily quota** (default 10,000 units;
`videos.insert` ≈ 1,600 units) **and** per-second/per-minute **rate limits**.
Blindly blasting uploads triggers HTTP 429 / 403-`quotaExceeded` / 5xx errors.
This project handles all of that:

1. **Daily quota budgeting per channel** — we never let a channel spend past
   `DEFAULT_DAILY_QUOTA * QUOTA_BURN_FRACTION` (0.85 by default, leaving headroom),
   and the budget resets every 24 h.
2. **Multi-account rotation** — a job scheduled with **no specific channel** (or
   after an auth failure) is auto-routed to the channel with the **most remaining
   quota**. Connect 3 channels → ~3× your upload ceiling.
3. **Concurrency caps** — `MAX_CONCURRENT_UPLOADS` (global) and
   `PER_CHANNEL_MAX_CONCURRENT` (per channel) cap bursts that trip rate limits.
4. **Exponential backoff + jitter** on `429` / `403 quotaExceeded` / `5xx`,
   honoring any `Retry-After` header; capped at `BACKOFF_MAX`.
5. **Self-healing auth** — if a channel's token is revoked (HTTP 401), the channel
   is deactivated and the job is re-queued to another channel instead of stalling.
6. **Retries → `exhausted`** — after `MAX_RETRIES` failed attempts a job is marked
   `exhausted` (visible in the UI) instead of looping forever.

> Real-world tip: even with rotation, 1,600 units/upload caps a single channel at
> ~6 uploads/day. For bulk scheduling, connect multiple channels AND file a
> **quota increase** with Google (see "Quota" below).

## Architecture

```
                 ┌──────────────────┐
   browser ----> │   API (server)   │  POST /api/videos  (YouTube + Instagram + Facebook batch jobs)
                 └────────┬─────────┘
                          │ writes rows to
                 ┌────────▼─────────┐        ┌─────────────────┐
   OAuth2 -----> │   SQLite (db)    │◄────── │  channels, jobs |
   Google        └────────┬─────────┘        └─────────────────┘
                          │ claims due jobs
                 ┌────────▼─────────┐
                 │  Worker          │  node src/worker.js
                 │  (own process)   │  ▸ dispatches by platform
                 │  ▸ YouTube API   │  ▸ Instagram Graph API
                 │                 │  ▸ Facebook Graph API
                 └────────┬─────────┘  ▸ backs off on 429/5xx
                          │
                 ┌────────▼─────────┐
                 │  YouTube API v3  │   your channel via OAuth
                 └──────────────────┘
```

The API and worker are **separate processes** (and separate Docker services).
The worker polls the DB every `WORKER_TICK_MS`, so you can scale it
(`docker compose up --scale worker=3`) and each instance safely competes for
jobs via an atomic `UPDATE ... WHERE status='pending' RETURNING *` claim.

## Stack

- **Node.js 20** (uses built-in `fetch` / `node:test`)
- **Express** API + tiny static frontend (Castline-styled)
- **jsonwebtoken + bcryptjs** (both pure-JS — no native build, safe in the Docker arm64 image) — email/password login + profile
- **better-sqlite3** — single-file DB, WAL mode, no external server required
- **googleapis** — OAuth2 + `youtube.v3.videos.insert` resumable upload
- **multer** — streams uploads to disk (5 GB-friendly, low RAM)

## Authentication (login / logout / profile)

The app has its own email/password login (independent of the YouTube OAuth flow).
Sessions are httpOnly, SameSite cookies signed with `JWT_SECRET`; passwords are
hashed with bcrypt. A `users` table is created on first run.

| Method | Path | Description |
|--------|------|-------------|
| POST   | `/api/auth/register` | `{name,email,password}` → creates account + logs in (sets cookie) |
| POST   | `/api/auth/login`    | `{email,password}` → validates, sets auth cookie |
| POST   | `/api/auth/logout`   | clears the cookie |
| GET    | `/api/auth/profile`  | the current user (401 if not authed) |
| PATCH  | `/api/auth/profile`  | update `name` (and `avatar` url) |
| GET    | `/api/auth/google`         | redirect to Google consent (openid/email/profile) to sign in |
| GET    | `/api/auth/google/callback` | Google redirects here with `?code=`; verifies id_token, upserts `users`, sets cookie, redirects `/` |

- **Google SSO login:** `GET /api/auth/google` redirects to Google; the callback at
  `/api/auth/google/callback` exchanges the code, verifies the returned `id_token`
  (checks `email_verified`, `aud === GOOGLE_CLIENT_ID`, expiry), upserts a `users`
  row keyed by `google_sub` (linking to an existing account on matching email), and
  issues the **same** `scheduler_auth` JWT cookie as email/password login — so after
  Google sign-in the user lands on the app at `/`. Register the redirect URI
  `http://localhost:3001/api/auth/google/callback` (in prod `https://<host>/api/auth/google/callback`)
  in **Google Cloud → APIs & Services → Credentials → OAuth client → Authorized
  redirect URIs**. You can connect a YouTube channel afterwards via
  `/api/auth/connect`; Google SSO itself needs only the `openid,email,profile` scopes.

- A default admin is seeded into an **empty** DB on first start:
  `admin@scheduler.local` / `scheduler` (from `LOGIN_EMAIL` / `LOGIN_PASSWORD`).
  **Change it before sharing the app.**
- `REQUIRE_AUTH=true` (default) gates `/api/videos` and `/api/auth/channels`
  behind login; visiting `/` while signed out redirects to `/login`. Set
  `REQUIRE_AUTH=0` to use the scheduler without app login (e.g. behind a
  reverse-proxy that handles auth).
- `/api/health`, `/api/auth/connect`, and `/auth/callback` stay public.

## Quick start (dry-run, no Google account needed)

Dry-run mode lets you validate the whole scheduling + backoff + rotation flow
without real credentials: the worker logs the upload steps instead of calling
the network.

```bash
git clone <this repo> && cd video-scheduler
npm install

# 1) Start the API + worker (dry-run)
DRY_RUN=true PORT=3001 npm run dev        # API
DRY_RUN=true npm run dev:worker             # worker

# Or one command with docker:
DRY_RUN=true docker compose up --build

# Or use the bundled helpers:
npm start   # boots api + worker + postgres (docker if up, else local node+sqlite)
npm stop    # tears down whatever's running

# Or call the root-level helpers directly:
./start.sh
./stop.sh

# 2) (Optional) seed a fake channel so scheduling has a target
npm run seed -- uc-local "Local Channel"

# 3) Schedule a video (from another terminal)
curl -X POST http://localhost:3001/api/videos \
  -F "video=@/path/to/clip.mp4" \
  -F "title=Hello YouTube" \
  -F "description=Scheduled with hashtags below" \
  -F "hashtags=#demo #scheduler #testing" \
  -F "privacy=public"
```

Poll `GET http://localhost:3001/api/videos` — you'll see the job flip
`pending → done`.

## Real OAuth setup (to actually upload to your channel)

1. Go to **Google Cloud Console → APIs & Services → Library** and enable
   **YouTube Data API v3**.
2. **APIs & Services → OAuth consent screen** → configure the
   `youtube.upload` and `youtube.readonly` scopes.
3. **Credentials → Create OAuth Client ID → "Web application"**:
   - Add **two** **Authorized redirect URIs** (Google requires an exact match for
     each): `http://localhost:3001/auth/callback` (YouTube channel connect) and
     `http://localhost:3001/api/auth/google/callback` (app login via Google SSO).
     In production use `https://your-domain.com/...`.
   - Copy the **Client ID** and **Client secret**.
4. Provide the credentials to the app. You can use **either** method (env wins):

   **Option A — `.env`** (best for local dev / Docker env-file):
   ```bash
   cp .env.example .env
   # paste your client id/secret into GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
   # set GOOGLE_CALLBACK_URL to your redirect URI
   ```

   **Option B — `secrets.json`** (best for Docker, keeps secrets out of the image
   and out of `.env`): write the OAuth client file you downloaded from the
   console to the project root as `secrets.json` (this shape is already
   supported — env vars always override it):
   ```json
   { "web": { "client_id": "...", "client_secret": "...", "project_id": "..." } }
   ```
   With `docker compose`, `secrets.json` is **bind-mounted read-only** into the
   `api` and `worker` containers (never baked into the image).

5. Run the API, then open <http://localhost:3001/api/auth/connect>. After you
   grant access, Google redirects to your callback; the channel is persisted
   automatically. Repeat to connect **multiple channels** (rotation).

   > **Docker default:** containers use **PostgreSQL** (`DB_DRIVER=pg`,
   > `DATABASE_URL=postgres://postgres:postgres@postgres:5432/scheduler` set in
   > `docker-compose.yml`) — no native module in the container, so no
   > better-sqlite3 segfault. Local dev without Docker defaults to SQLite.
6. Start the worker: `npm run worker` (or `docker compose up`).

> The OAuth callback is `GET /auth/callback` (public, not `/api`-prefixed)
> because Google requires an **exact** URI match with what you registered.

## Facebook Pages video publishing

Facebook publishing sends standard videos to Pages that the signed-in Meta user
manages. It does not publish Facebook Reels. Meta must be able to fetch each
staged video from the app, so `APP_PUBLIC_URL` must be a publicly reachable
HTTPS origin (localhost alone will not work).

1. Create a Meta app, add Facebook Login, and configure its OAuth redirect URI
   to exactly match `FACEBOOK_CALLBACK_URL` (default:
   `http://localhost:3001/api/facebook/callback`). For local development, use
   an HTTPS tunnel if Meta does not accept a local callback.
2. Set `FACEBOOK_APP_ID` and `FACEBOOK_APP_SECRET` in `.env`. The app requests
   `pages_show_list`, `pages_read_engagement`, and `pages_manage_posts`. The
   Meta user must grant access to the Page and have permission to create Page
   content. For users outside the app's developer/tester roles, configure the
   Meta app's review and access requirements for those permissions.
3. Set `APP_PUBLIC_URL` to the HTTPS origin served by this API. A stable
   `MEDIA_SIGNING_SECRET` is recommended in production; if unset, the app uses
   the configured Instagram or Facebook app secret to sign staged-media URLs.
4. Start the API and worker, then connect Facebook from **Channels**. The app
   stores the returned Page access tokens locally, lists the Pages, and lets
   you disconnect or reauthorize them. The token itself is never returned by
   the status API.
5. In Bulk Upload, select **Facebook video** and one or more Facebook Pages.
   Each selected file is queued separately per Page and published using the
   worker. Only MP4, MOV, and M4V files are accepted for Facebook.

Facebook API routes:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/facebook/status` | Facebook app setup and Page status (requires app login) |
| GET | `/api/facebook/connect` | Begin Facebook OAuth |
| GET | `/api/facebook/callback` | OAuth callback (register this exact URI in Meta) |
| GET | `/api/facebook/pages` | List connected Pages (requires app login) |
| POST | `/api/facebook/pages/:id/disconnect` | Deactivate a connected Page |


## Scheduling API

| Method | Path | Description |
|--------|------|-------------|
| GET    | `/api/health` | Liveness probe |
| GET    | `/api/auth/connect` | Redirect to Google OAuth |
| GET    | `/auth/callback` | OAuth callback (registered in GCP) |
| GET    | `/api/auth/channels` | List connected channels + quota |
| POST   | `/api/auth/channels/:id/deactivate` | Disable a channel |
| POST   | `/api/videos` | Schedule upload(s) (multipart; one job per file) |
| GET    | `/api/videos` | List all jobs |
| GET    | `/api/videos/:id` | Get a job |
| DELETE | `/api/videos/:id` | Soft-delete a scheduled (`pending`) job |
| PATCH  | `/api/videos/:id` | Edit a `pending` job's title/description/hashtags/tags/category/privacy/channelId/priority/scheduleAt (the video file itself is not changed — re-schedule a new upload to replace it) |
| GET    | `/api/instagram/status` | Instagram configuration and connected-account status (requires app login) |
| GET    | `/api/instagram/connect` | Begin Instagram Business Login |
| GET    | `/api/instagram/callback` | Instagram OAuth callback (register this exact URI in Meta) |
| POST   | `/api/instagram/accounts/:id/disconnect` | Deactivate an Instagram account |
| GET    | `/api/facebook/status` | Facebook app configuration and connected Pages (requires app login) |
| GET    | `/api/facebook/connect` | Begin Facebook OAuth |
| GET    | `/api/facebook/callback` | Facebook OAuth callback (register this exact URI in Meta) |
| GET    | `/api/facebook/pages` | List connected Facebook Pages (requires app login) |
| POST   | `/api/facebook/pages/:id/disconnect` | Deactivate a Facebook Page |

`POST /api/videos` accepts **multiple files**: the field `video` is repeatable, and
one job is created per file (each `pending`; the worker dispatches due ones next
tick, concurrently up to `MAX_CONCURRENT_UPLOADS`). Metadata can be sent two ways:

**Preferred — a single `metadata` JSON field** (used by the web UI):
```json
{ "titles": ["My Reel", "", "Third"], "description": "...", "hashtags": "#fun",
  "tags": "fun,2024", "category": "22", "privacy": "public",
  "channelId": "chan-x", "priority": 0, "scheduleAt": "2030-12-31T23:59:00.000Z" }
```
`titles` is an ordered array, one entry per file; a blank entry falls back to the
file's own name. The same blob is sent for a single upload.

For mixed-platform batches, provide an `items` array (same order and length as
the uploaded `video` fields). Each item accepts `platform` (`youtube`,
`instagram`, or `facebook`), `format` (`video`, `short`, or `reel`), `title`
(caption for Instagram), `channelId` (YouTube), `instagramAccountId` (Instagram),
`facebookPageId` (Facebook), and
`scheduleAt` (an ISO timestamp for that individual file). Each item can have a
different schedule; if omitted, that upload is queued immediately. Example:
```json
{ "items": [
    { "platform": "youtube", "format": "short", "title": "A Short",
      "scheduleAt": "2030-12-31T23:59:00.000Z" },
    { "platform": "instagram", "format": "reel", "title": "A Reel caption",
      "instagramAccountId": "instagram-account-id",
      "scheduleAt": "2031-01-01T10:00:00.000Z" }
  ], "description": "Shared YouTube description", "privacy": "private" }
```

**Legacy — flat form/text fields** (one file): `description`, `hashtags`, `tags`,
`category`, `privacy`, `channelId`, `priority`, `scheduleAt`, and either `title`
(single file) or `title[]` (repeated, ordered per-file).

Response (always batch-shaped): `{ created:[{id,title,scheduledAt}], count, message }`.

`POST /api/videos` fields (legacy/flat form):

| field | required | description |
|-------|----------|-------------|
| `video` | ✅ | the video file (multipart; repeatable for multiple uploads) |
| `title` / `title[]` | ✅ | video title (single) / per-file titles (multiple); blank → file name |
| `metadata` | | JSON blob (preferred); when present, `titles[]` + shared fields live here |
| `description` | | video description |
| `hashtags` | | `#funny #vlog` — appended to the description (YouTube renders hashtags above the title) |
| `tags` | | comma-separated tags |
| `privacy` | | `public` / `unlisted` / `private` (default `private`) |
| `category` | | YouTube category id (default `22` = People & Blogs) |
| `channelId` | | a connected channel id, or leave blank for auto-rotation |
| `scheduleAt` | | ISO timestamp; omit/`now` = upload ASAP |

### Bulk publishing to YouTube and Instagram

The **Bulk upload** tab creates one queued job per selected file. Each file can
target a YouTube video, a YouTube Short, or an Instagram Reel; all jobs share a
schedule time. A YouTube Short uses the normal YouTube upload API—YouTube
determines Shorts classification from the media's length and aspect ratio.
Instagram publishing is a real integration and requires an Instagram
professional account, a configured Meta app, and public HTTPS access to each
staged video.

Set `INSTAGRAM_APP_ID` and `INSTAGRAM_APP_SECRET` from the Meta developer app.
Set `INSTAGRAM_CALLBACK_URL` to the exact redirect URI registered in the
Instagram Login settings (default: `http://localhost:3001/api/instagram/callback`).
The app requests `instagram_business_basic` and
`instagram_business_content_publish`; enable the Instagram API with Instagram
Login product and grant those permissions to the app. Development-mode apps
can only authorize Instagram app-role/tester accounts; public access may require
Meta App Review and the appropriate access level.

For publishing, set `APP_PUBLIC_URL` to the public HTTPS origin serving the
application, for example `https://scheduler.example.com`. Instagram fetches
the staged file from that origin using a signed `/media/<file>` URL that expires
after 24 hours; direct file paths are denied. Localhost, private networks, and
non-HTTPS URLs cannot be used. In Docker, keep the API and worker on the shared
`storage` volume (already configured by `docker-compose.yml`).
Instagram jobs do not spend YouTube quota. Their publish/container-status calls
are made only when the worker processes a due Reel; the UI does not poll either
platform for publishing status.

## Quota (the real constraint)

YouTube Data API v3 quotas are **per OAuth client (your GCP project)**, not per
channel token — *but the daily quota pool is shared by everything the project
does*. The practical levers:

| Lever | Effect |
|-------|--------|
| **Multiple channels per project** | each channel still shares the project's 10k units/day by default |
| **Multiple GCP projects** (one OAuth client per project, multiple channels) | each project gets its own 10k/day → real quota multiplication |
| **Google quota increase** | request via Cloud Console support; state "video upload" and expected volume |
| **`madeForKids: false` + `status.failSafe`** | avoids extra review cost |

**Rule of thumb for volume:** 1,600 units/upload → ~6 uploads/day on the free
quota. Need 100/day? Either rotate across 16+ projects, or request a quota
raise to ~160,000 units/day.

## Bulk folder rotation (Phase 1 + Phase 2; see `docs/Feature_Bulk_Folder_Import_Scheduling.md`)

Watch a local/mounted folder and automatically publish one video per post across
selected channels, each on its own schedule. **Phase 1** (data model +
directory scanner + manual rescan + CRUD) and **Phase 2 core** — the assignment
planner (72h-horizon slotting → real `jobs`), sha256-dedup media-store copy +
`media_assets` reuse, caption templates, the chokidar folder watcher + polling
safety net + unreachable-folder status, the periodic `cleanOrphanedMedia()`
cleanup job, planner auto-tick on the worker, and the **Rotation tab** editor
UI — are all implemented and live. Verified green: `npm test` (50/50) and a live
Postgres run (clean DB: 0 rotation jobs/artifacts).

| Method | Path | Description |
|--------|------|-------------|
| GET    | `/api/folders` | List watched folders + item counts + `status` |
| POST   | `/api/folders` | Add a folder (`{ path, scanInterval? }`) — validates it's an absolute directory, then scans |
| DELETE | `/api/folders/:id` | Remove a folder (stops future watches) |
| POST   | `/api/folders/:id/rescan` | Re-scan: imports new files, dedupes by sha256, refreshes existing |
| GET    | `/api/folders/:id/items` | List detected files (`filename`, `sizeBytes`, `sha256`, `status`) |
| GET    | `/api/folders/:id/rules` | List a folder's rotation rules (for the editor) |
| POST   | `/api/folders/:id/rules` | Create a per-channel rotation rule |
| PATCH  | `/api/rules/:id` | Update frequency/time/pool mode/template/active |
| DELETE | `/api/rules/:id` | Stop a rule (keeps scheduled jobs; cascades assignments) |
| GET    | `/api/rules/:id/assignments` | Planned/scheduled assignments for a rule |
| GET    | `/api/rules/:id/slots?from=&count=` | Preview upcoming slots (open / assigned) |
| POST   | `/api/rotation/plan` | Run one planning tick now — assigns next unfilled slots, creates jobs within 72h |
| POST   | `/api/rotation/cleanup` | Run the orphan-cleanup pass now (`{ removed, bytes, errors }`)

**Rule fields:** `channelId` (must be a connected channel), `frequency`
(`daily` | `every_n_days` | `weekdays`), `intervalN` (for `every_n_days`),
`weekdays` (CSV `0-6`, Mon-Sun, for `weekdays`), `timeOfDay` (`HH:mm`),
`timezone` (default `UTC`), `startDate` (ISO date or epoch seconds),
`poolMode` (`shared` | `dedicated`, default `shared`), `captionTemplate`
(`{filename}`, `{index}`, `{date}`).

**How the planner works:** `POST /api/rotation/plan` walks every active rule,
computes its next *unfilled* schedule slot (timezone + DST-aware via Node's
built-in `Intl` — no timezone dependency), assigns the next eligible item, and —
only for slots within the rolling **72h horizon** — copies the file once into
`config.storageRoot` (a `media_assets` row keyed by sha256, so shared pools reuse
one copy) and inserts a `jobs` row with `source='rotation'` that the existing
worker uploads unchanged. Slots beyond the horizon get a `planned` assignment
(no job) and are promoted as the horizon moves forward. Runs are **idempotent**
and callable manually (`POST /api/rotation/plan`) or on a timer.

**Cost & lifecycle notes.** In **shared** pool mode the same file publishes to
multiple channels — each publish is a separate, quota-burning YouTube upload
(no cross-upload dedup credit); **dedicated** mode publishes each video once.
`media_assets` (in `storageRoot`, copied at schedule time) is reference-counted
by `jobs.media_asset_id` so shared copies are retained until all referencing jobs
finish; a Phase 2 `cleanOrphanedMedia()` pass removes rows no `jobs` reference.
The background worker runs the planner + cleanup ticks and the folder watchers
automatically. The **Rotation tab** in the web UI is the editor: watch folders
(add / rescan / unreachable status + item list with sha256), create/edit/delete
schedule rules (frequency, interval/weekdays, time-of-day, timezone, start date,
pool mode, caption template, active), and preview upcoming slots. `source='rotation'`
jobs are tagged in the Queue; the Desk shows a `Rotation` stat and the Queue tab a
live pending-rotation badge. The one remaining gap is a dedicated in-queue row-level
scheduler control panel (per-slot publish/cancel); the underlying `GET /api/rules/:id/slots`
endpoint already powers it.

## DB Explorer (admin, read-only)

A **Database Explorer** tab in the UI lets a signed-in admin run arbitrary
**read-only** SQL against the configured database (Postgres in Docker, SQLite
on the host).

- `POST /api/explorer/query` `{ sql }` → `{ columns, rows, rowCount, truncated }`
  (requires the auth session; same cookie as the rest of the app).
- **Safety:** the route enforces **SELECT-only** — the first keyword must be
  `SELECT`/`WITH`/`SHOW`/`EXPLAIN`/`VALUES`/`PRAGMA`; a single trailing `;` is
  stripped, but `;` elsewhere (stacked statements) and `INSERT/UPDATE/DELETE/DROP/ALTER/CREATE/…`
  are rejected with `400` *before* they reach the driver. Results are capped at
  1000 rows (`truncated: true` when more exist).
- **UI:** `/#` explorer tab → SQL textarea (seeded with
  `SELECT id,email,name FROM users …`) + Run + a scrollable results table;
  re-runs automatically when you switch to the tab.

This is why the "user id is `selvester69`" issue was a red herring in code: the
app never hardcodes an account — it returns whichever `users` row matches the
credential you sign in with. You can now verify the real identity directly:

```
POST /api/explorer/query  {"sql":"SELECT id, email, name FROM users ORDER BY created_at DESC"}
```

> ⚠️ The Explorer is gated by `REQUIRE_AUTH=true` (the default). Do **not** expose
> port 3001 in production without a reverse proxy / network firewall — SQL access
> is root-equivalent for reads.

## Scaling & hardening (production checklist)

- [ ] Run the **worker** separately and `--scale worker=N` behind the API.
- [ ] Swap SQLite for **Postgres** (the `db.js` query surface is small).
- [ ] Offload staged video files to **S3** (swap `storageRoot` for an S3-backed
      store; streams `videos.insert` directly from S3).
- [ ] Add a proper **queue** (e.g. a `worker_beat` table, or BullMQ/Redis) for
      millions of scheduled jobs.
- [ ] Add **webhook/job notifications** (Discord/Slack/email) on `done`/`failed`.
- [ ] Add a **retry-dead-letter** to alert on `exhausted` jobs.
- [ ] **Category/review**: if your content is for kids, set `madeForKids`.
- [ ] **Rate-limit visibility**: add a `/api/metrics` endpoint exposing
      `quota_used` per channel and the active-concurrency snapshot.
