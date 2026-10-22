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
   browser ----> │   API (server)   │  POST /api/videos  (multipart: video, title, hashtags…)
                 └────────┬─────────┘
                          │ writes rows to
                 ┌────────▼─────────┐        ┌─────────────────┐
   OAuth2 -----> │   SQLite (db)    │◄────── │  channels, jobs |
   Google        └────────┬─────────┘        └─────────────────┘
                          │ claims due jobs
                 ┌────────▼─────────┐
                 │  Worker          │  node src/worker.js
                 │  (own process)   │  ▸ picks channel (rotation + budget)
                 │  ▸ videos.insert │  ▸ respects concurrency caps
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
- **Express** API + tiny static frontend
- **better-sqlite3** — single-file DB, WAL mode, no external server required
- **googleapis** — OAuth2 + `youtube.v3.videos.insert` resumable upload
- **multer** — streams uploads to disk (5 GB-friendly, low RAM)

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
   - Add `http://localhost:3001/auth/callback` as an **Authorized redirect URI**
     (in prod use `https://your-domain.com/auth/callback`).
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


## Scheduling API

| Method | Path | Description |
|--------|------|-------------|
| GET    | `/api/health` | Liveness probe |
| GET    | `/api/auth/connect` | Redirect to Google OAuth |
| GET    | `/auth/callback` | OAuth callback (registered in GCP) |
| GET    | `/api/auth/channels` | List connected channels + quota |
| POST   | `/api/auth/channels/:id/deactivate` | Disable a channel |
| POST   | `/api/videos` | Schedule an upload (multipart) |
| GET    | `/api/videos` | List all jobs |
| GET    | `/api/videos/:id` | Get a job |
| DELETE | `/api/videos/:id` | Delete a scheduled (`pending`) job |
| PATCH  | `/api/videos/:id` | Edit a `pending` job's title/description/hashtags/tags/category/privacy/channelId/priority/scheduleAt (the video file itself is not changed — re-schedule a new upload to replace it) |

`POST /api/videos` fields:

| field | required | description |
|-------|----------|-------------|
| `video` | ✅ | the video file (multipart) |
| `title` | ✅ | video title |
| `description` | | video description |
| `hashtags` | | `#funny #vlog` — appended to the description (YouTube renders hashtags above the title) |
| `tags` | | comma-separated tags |
| `privacy` | | `public` / `unlisted` / `private` (default `private`) |
| `category` | | YouTube category id (default `22` = People & Blogs) |
| `channelId` | | a connected channel id, or leave blank for auto-rotation |
| `scheduleAt` | | ISO timestamp; omit/`now` = upload ASAP |

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
