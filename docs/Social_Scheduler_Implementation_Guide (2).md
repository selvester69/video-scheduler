# Local Social Media Scheduler: End-to-End Implementation Guide

Version: 1.0
Scope: MVP (Phase 1) with notes for Phase 2
Audience: Developer(s) building the app from scratch

---

## 1. Purpose and Scope

This document describes how to build a self-hosted, Buffer-like social media scheduler that runs on `localhost`. It covers:

- Architecture and technology decisions
- Project setup and folder structure
- Database schema
- Backend API, OAuth, and platform publishing adapters
- Scheduling engine and background worker
- Frontend (composer, queue, calendar, media library)
- Security, error handling, testing, packaging, and acceptance

Out of scope for MVP: team collaboration, billing, hosted (cloud) deployment, and AI caption generation.

---

## 2. System Overview

### 2.1 High-Level Architecture

```
+----------------------+         +-----------------------+
|   Browser (React)    | <-----> |   API Server (Fastify)|
|   localhost:5173     |  HTTP   |   localhost:3000      |
+----------------------+         +-----------+-----------+
                                             |
                    +------------------------+------------------------+
                    |                        |                        |
             +------v------+          +------v------+          +------v------+
             |  SQLite DB  |          | Redis (queue)|         | Local media |
             |  (Prisma)   |          | BullMQ jobs  |         | ./data/media|
             +------^------+          +------^------+          +-------------+
                    |                        |
                    |                 +------+------+
                    +---------------->|   Worker    |----> Platform APIs
                                      |  (Node.js)  |      (X, LinkedIn,
                                      +-------------+       Meta, Mastodon)
```

Components:

1. **Web UI**: React SPA. Composer, calendar, queue, channels, media library, settings.
2. **API server**: REST API. Auth-less for local use (see Section 14 for optional local password), handles CRUD, OAuth callbacks, and media upload.
3. **Worker**: separate Node process. Consumes scheduled jobs from Redis and publishes posts.
4. **Redis**: holds BullMQ queues and delayed jobs. Survives restarts when persistence is enabled.
5. **SQLite**: source of truth for posts, channels, and results.
6. **Local filesystem**: uploaded media stored under `./data/media`.

### 2.2 Why These Choices

| Concern | Choice | Reason |
|---|---|---|
| Language | TypeScript everywhere | One language across UI, API, and worker; type safety for API contracts |
| API framework | Fastify | Fast, schema validation built in, good plugin model |
| ORM | Prisma | Typed client, migrations, works with SQLite now and PostgreSQL later |
| DB | SQLite (default), PostgreSQL optional | Zero setup for local use |
| Queue | BullMQ on Redis | Delayed jobs, retries, backoff, and persistence |
| Frontend | React + Vite + Tailwind | Fast dev loop, simple styling |
| Calendar | FullCalendar (React) | Mature drag-and-drop calendar |
| Packaging | Docker Compose | One command to run API, worker, web, and Redis |

---

## 3. Prerequisites

### 3.1 Tools on the Developer Machine

- Node.js 20 LTS or later
- pnpm 9 or later (`npm i -g pnpm`)
- Docker Desktop (for Redis and full-stack run)
- Git
- A code editor (VS Code recommended)
- ngrok or Cloudflare Tunnel (optional, only if a platform rejects `http://localhost` callbacks)

### 3.2 Platform Developer Accounts

Create developer apps and note the client IDs and secrets. Each platform changes its rules often, so verify current requirements in the official docs before starting.

| Platform | Where to register | Needed for MVP |
|---|---|---|
| Meta (Facebook Pages) | developers.facebook.com | Facebook Login, `pages_manage_posts`, `pages_read_engagement`, `pages_show_list` |
| Instagram | Via same Meta app | Instagram Business or Creator account linked to a Facebook Page; `instagram_content_publish` permission |

**YouTube is planned for a later phase** (not in this MVP). It will be added as a new adapter once Facebook and Instagram are stable; the Channel/Post/worker model already supports adding a platform without other changes.

MVP uses a single Meta app registration — one OAuth flow covers both Facebook and Instagram, since Instagram publishing requires a Business account linked to a Facebook Page.

---

## 4. Repository Structure

```
social-scheduler/
├── apps/
│   ├── api/                      # Fastify API server
│   │   ├── src/
│   │   │   ├── server.ts         # App bootstrap
│   │   │   ├── config.ts         # Env loading and validation
│   │   │   ├── plugins/          # Prisma, Redis, CORS, multipart, error handler
│   │   │   ├── routes/
│   │   │   │   ├── channels.ts
│   │   │   │   ├── oauth.ts
│   │   │   │   ├── posts.ts
│   │   │   │   ├── media.ts
│   │   │   │   ├── queue.ts
│   │   │   │   └── health.ts
│   │   │   ├── services/
│   │   │   │   ├── postService.ts
│   │   │   │   ├── scheduleService.ts
│   │   │   │   ├── channelService.ts
│   │   │   │   └── mediaService.ts
│   │   │   ├── schemas/          # Zod schemas for request/response
│   │   │   └── lib/
│   │   │       ├── crypto.ts     # AES-256-GCM token encryption
│   │   │       ├── errors.ts
│   │   │       └── logger.ts
│   │   └── test/
│   ├── worker/                   # Background publisher
│   │   ├── src/
│   │   │   ├── index.ts          # Worker bootstrap
│   │   │   ├── publisher.ts      # Job handler
│   │   │   ├── tokenRefresh.ts   # Refresh expiring tokens
│   │   │   └── adapters/
│   │   │       ├── types.ts      # Adapter interface
│   │   │       ├── x.ts
│   │   │       ├── linkedin.ts
│   │   │       ├── facebook.ts
│   │   │       ├── instagram.ts
│   │   │       └── mastodon.ts
│   └── web/                      # React frontend
│       ├── src/
│       │   ├── main.tsx
│       │   ├── api/client.ts     # Typed fetch wrapper
│       │   ├── pages/
│       │   │   ├── Calendar.tsx
│       │   │   ├── Composer.tsx
│       │   │   ├── Queue.tsx
│       │   │   ├── Channels.tsx
│       │   │   └── Media.tsx
│       │   ├── components/
│       │   └── hooks/
├── packages/
│   └── shared/                   # Shared types, zod schemas, platform limits
│       └── src/
│           ├── types.ts
│           ├── schemas.ts
│           └── platformLimits.ts
├── prisma/
│   ├── schema.prisma
│   └── migrations/
├── data/                         # Created at runtime (gitignored)
│   ├── media/
│   └── backups/
├── docker-compose.yml
├── Dockerfile.api
├── Dockerfile.worker
├── Dockerfile.web
├── .env.example
├── package.json                  # pnpm workspace root
├── pnpm-workspace.yaml
└── README.md
```

---

## 5. Environment Configuration

### 5.1 `.env.example`

```bash
# General
NODE_ENV=development
APP_BASE_URL=http://localhost:5173
API_PORT=3000
LOG_LEVEL=info

# Database
DATABASE_URL="file:./data/app.db"

# Redis
REDIS_URL=redis://localhost:6379

# Security
# 32-byte key, base64 encoded. Generate with: openssl rand -base64 32
TOKEN_ENCRYPTION_KEY=replace_me

# Media
MEDIA_DIR=./data/media
MEDIA_MAX_MB=100

# OAuth callbacks (must exactly match what is registered on each platform)
OAUTH_REDIRECT_BASE=http://localhost:3000/api/oauth/callback

# Platform credentials (Meta covers both Facebook and Instagram)
META_APP_ID=
META_APP_SECRET=

# Required only for Instagram publishing (public URL for media during publish)
TUNNEL_PROVIDER=cloudflare   # cloudflare | ngrok | none
NGROK_AUTH_TOKEN=

# YouTube: planned for a later phase, not used yet
# YOUTUBE_CLIENT_ID=
# YOUTUBE_CLIENT_SECRET=

# Worker
WORKER_CONCURRENCY=2
PUBLISH_MAX_ATTEMPTS=5
TOKEN_REFRESH_LEAD_MINUTES=30
```

### 5.2 Config Validation

On startup, `config.ts` must parse env with Zod:

- `TOKEN_ENCRYPTION_KEY` must decode to exactly 32 bytes; otherwise exit with a clear error.
- `DATABASE_URL` and `REDIS_URL` are required.
- Platform credentials are optional. A platform is "enabled" only when both its ID and secret are set. The UI must hide disabled platforms.

---

## 6. Data Model

### 6.1 Prisma Schema

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}

model Channel {
  id              String   @id @default(cuid())
  platform        String   // x | linkedin | facebook | instagram | mastodon
  platformUserId  String   // ID on the platform
  displayName     String
  handle          String?
  avatarUrl       String?
  accessTokenEnc  String   // encrypted: iv:tag:ciphertext
  refreshTokenEnc String?
  tokenExpiresAt  DateTime?
  scopes          String?
  meta            String?  // JSON: e.g. page access token for Facebook, instance URL for Mastodon
  status          String   @default("active") // active | needs_reauth | disabled
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  posts           PostChannel[]
  slots           QueueSlot[]

  @@unique([platform, platformUserId])
}

model Post {
  id           String   @id @default(cuid())
  body         String
  status       String   @default("draft") // draft | scheduled | publishing | published | partial | failed | canceled
  scheduledAt  DateTime?  // stored in UTC
  timezone     String   @default("UTC")   // user's timezone at time of scheduling
  publishedAt  DateTime?
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  version      Int      @default(1)       // optimistic locking
  media        PostMedia[]
  channels     PostChannel[]
}

model PostChannel {
  id          String   @id @default(cuid())
  postId      String
  channelId   String
  status      String   @default("pending") // pending | queued | publishing | published | failed | canceled
  body        String?  // per-channel override; null means use Post.body
  externalId  String?  // platform post ID after success
  externalUrl String?
  attempts    Int      @default(0)
  lastError   String?
  jobId       String?  // BullMQ job id for cancel/retry
  publishedAt DateTime?
  post        Post     @relation(fields: [postId], references: [id], onDelete: Cascade)
  channel     Channel  @relation(fields: [channelId], references: [id], onDelete: Cascade)

  @@unique([postId, channelId])
}

model Media {
  id         String   @id @default(cuid())
  filename   String
  mimeType   String
  sizeBytes  Int
  width      Int?
  height     Int?
  storagePath String  // relative to MEDIA_DIR
  sha256     String   @unique  // dedupe identical uploads
  createdAt  DateTime @default(now())
  posts      PostMedia[]
}

model PostMedia {
  postId   String
  mediaId  String
  position Int      @default(0)
  post     Post   @relation(fields: [postId], references: [id], onDelete: Cascade)
  media    Media  @relation(fields: [mediaId], references: [id], onDelete: Cascade)

  @@id([postId, mediaId])
}

model QueueSlot {
  id        String  @id @default(cuid())
  channelId String
  dayOfWeek Int     // 0 = Sunday ... 6 = Saturday
  time      String  // "HH:mm" in channel's timezone
  timezone  String  @default("UTC")
  active    Boolean @default(true)
  channel   Channel @relation(fields: [channelId], references: [id], onDelete: Cascade)
}

model AuditLog {
  id        String   @id @default(cuid())
  action    String   // e.g. post.created, post.published, channel.connected
  entityId  String?
  detail    String?  // JSON
  createdAt DateTime @default(now())
}
```

### 6.2 Status State Machines

**Post status**

```
draft ──schedule──> scheduled ──worker picks up──> publishing
  ^                     |                              |
  |                  cancel                  all channels ok -> published
  |                     v                    some ok, some fail -> partial
  └──────edit────── canceled                 all failed -> failed
```

**PostChannel status**

```
pending -> queued -> publishing -> published
                         |
                         └──> failed (attempts < max) -> queued (retry)
                                   └──> failed (final)
canceled can be entered from pending or queued only.
```

Rules:
- A post can be edited only in `draft` or `scheduled` (edits to `scheduled` must re-queue jobs).
- A post in `publishing` or `published` is read-only.
- `partial` and `failed` posts can be retried per channel.

---

## 7. Shared Package

### 7.1 Platform Limits (`packages/shared/src/platformLimits.ts`)

| Platform | Max characters | Images per post | Video | Notes |
|---|---|---|---|---|
| Facebook Page | 63206 | 10 | Yes | |
| Instagram | 2200 | 10 (carousel) | Reels/feed video | Image or video required; text-only not allowed |
| YouTube (planned) | 5000 (description) | — | Required | Add when the adapter is built |

The shared package exports a function `validateForPlatform(body, media, platform)` that returns a list of errors and warnings. Used by both UI (live preview) and API (validation on save and publish).

### 7.2 Shared Types

Export from `types.ts`:
- `PostStatus`, `PostChannelStatus`, `Platform` union types
- `CreatePostInput`, `UpdatePostInput`, `ChannelDto`, `PostDto`, `MediaDto`, `QueueSlotDto`
- `ApiError` shape: `{ error: { code: string; message: string; details?: unknown } }`

---

## 8. Backend API

### 8.1 Conventions

- Base path: `/api`
- JSON in and out. Dates in ISO 8601 UTC.
- Validation with Zod on every request body and query.
- Error response: `{ error: { code, message, details? } }`
- Status codes: 200 OK, 201 Created, 204 No Content, 400 validation, 404 not found, 409 conflict (e.g. edit while publishing), 422 platform rule violated, 500 server error.

### 8.2 Endpoints

**Health**

- `GET /api/health`: returns `{ status: "ok", db: "ok", redis: "ok", worker: "ok|unknown" }`

**Channels**

- `GET /api/channels`: list connected channels (tokens never returned)
- `GET /api/platforms`: list platforms with `enabled` flag based on config
- `DELETE /api/channels/:id`: disconnect channel; cancels its queued jobs; marks related PostChannels as `canceled`
- `GET /api/channels/:id/slots`: list queue slots
- `PUT /api/channels/:id/slots`: replace all slots. Body: `[{ dayOfWeek, time, active }]`

**OAuth**

- `GET /api/oauth/:platform/start`: builds authorization URL with `state` and PKCE verifier (where required). Stores state in DB table or signed cookie with 10 minute expiry. Returns `{ url }`.
- `GET /api/oauth/callback?code&state`: validates `state`, exchanges code for tokens, fetches profile, encrypts tokens, upserts Channel, redirects to `APP_BASE_URL/channels?connected=<platform>`.

**Posts**

- `GET /api/posts?status=&from=&to=&channelId=&page=&limit=`: list with pagination
- `POST /api/posts`: create draft or schedule immediately. Body:
  ```json
  {
    "body": "Hello world",
    "mediaIds": ["m_123"],
    "channelIds": ["c_1", "c_2"],
    "perChannelBody": { "c_2": "Shorter text for this channel" },
    "scheduledAt": "2026-10-20T09:30:00Z",
    "timezone": "Asia/Kolkata",
    "status": "scheduled"
  }
  ```
  Rules: `scheduledAt` must be at least 60 seconds in the future. `status` may be `draft` or `scheduled`. If `scheduled`, `scheduledAt` is required.
- `GET /api/posts/:id`
- `PATCH /api/posts/:id`: update body, media, channels, time. Returns 409 if status is `publishing` or `published`.
- `POST /api/posts/:id/schedule`: body `{ scheduledAt, timezone }`. Validates, creates BullMQ delayed jobs.
- `POST /api/posts/:id/cancel`: cancels pending and queued channels; removes jobs.
- `POST /api/posts/:id/retry`: body `{ channelIds? }`. Retries failed channels immediately.
- `POST /api/posts/:id/publish-now`: enqueues immediate job for all channels.
- `DELETE /api/posts/:id`: only for `draft`, `canceled`, `failed`, or `partial` with no active jobs. Otherwise 409.
- `POST /api/posts/:id/duplicate`: copies as new draft.

**Media**

- `POST /api/media`: multipart upload. Validates MIME type (`image/jpeg`, `image/png`, `image/gif`, `image/webp`, `video/mp4`, `video/quicktime`). Enforces `MEDIA_MAX_MB`. Computes SHA-256 and returns existing record if duplicate.
- `GET /api/media?page=&limit=`
- `GET /api/media/:id/file`: streams file with correct `Content-Type`. Used by UI preview and by worker (worker reads from local path directly).
- `DELETE /api/media/:id`: refuses if attached to a non-terminal post.

**Queue and calendar**

- `GET /api/queue?from=&to=`: returns scheduled PostChannel items in range, with post preview and channel info. Powers calendar and queue list.
- `GET /api/calendar?from=&to=`: same data formatted for FullCalendar events.
- `POST /api/queue/next-slot`: body `{ channelIds }`. Returns the next free slot time for each channel based on QueueSlot rules, skipping times already taken.

**Audit**

- `GET /api/audit?limit=50`: recent audit entries (for debugging).

### 8.3 Example: Create and Schedule Flow

1. UI calls `GET /api/queue/next-slot` to suggest a time.
2. User confirms. UI calls `POST /api/posts` with `status: "scheduled"`.
3. API inside a DB transaction:
   a. Insert `Post` and `PostChannel` rows (status `queued`).
   b. Compute delay = `scheduledAt - now`.
   c. For each channel, add BullMQ job `publish-post-channel` with `{ postChannelId }`, `delay`, `jobId = postChannelId`, and retry options.
   d. Save `jobId` back on `PostChannel`.
   e. If enqueue fails for any channel, roll back the transaction and return 500.
4. Return `201` with the post DTO.

Using `jobId = postChannelId` makes enqueueing idempotent. A duplicate add is ignored by BullMQ.

---

## 9. OAuth Implementation

### 9.1 General Flow (Authorization Code with PKCE)

1. `GET /api/oauth/:platform/start`
   - Generate `state` (32 random bytes, base64url) and, if the platform requires it, `code_verifier` (43–128 chars) with `code_challenge = BASE64URL(SHA256(verifier))`.
   - Store `{ state, platform, codeVerifier, createdAt }` in an `OAuthState` table or in memory with a 10-minute TTL. (Recommended: DB table so restarts do not break in-flight auth.)
   - Redirect the browser to the platform authorization URL.
2. User approves on platform. Platform redirects to `OAUTH_REDIRECT_BASE/<platform>`.
   - Use one callback route per platform if the platform needs it (`/api/oauth/callback/x`), or one shared route that reads `state`.
3. Callback handler:
   - Look up `state`; reject if missing, expired, or already used. Delete it after use.
   - Exchange `code` for tokens at the platform token endpoint.
   - Call the platform "me" or profile endpoint to get `platformUserId`, `displayName`, `handle`, `avatarUrl`.
   - Encrypt access and refresh tokens (Section 14.2).
   - Upsert `Channel` by `(platform, platformUserId)`.
   - Write AuditLog `channel.connected`.
   - Redirect to UI.

### 9.2 Platform-Specific Notes

- **Facebook Pages**: Log in with Facebook to get a user token, then call `GET /me/accounts` to list Pages. Each Page returns its own Page access token, which does not expire the same way user tokens do (long-lived, but re-check periodically). Store the Page token in the encrypted `accessTokenEnc` field and the Page ID in `platformUserId`. The UI must let the user pick which Page(s) to connect.
- **Instagram**: Uses the same Meta login flow as Facebook — no separate OAuth needed. After a Page is connected, call `GET /{page-id}?fields=instagram_business_account` to find the linked Instagram Business/Creator account. Store the IG account ID as `platformUserId` on a second Channel row (platform = `instagram`), reusing the Page's access token for publishing. If no Instagram account is linked, skip creating that channel and tell the user to link one in their Facebook Page settings.
- **YouTube (planned, not built yet)**: will use Google OAuth 2.0 with `youtube.upload` scope and a resumable upload endpoint. Add as a new adapter file under `apps/worker/src/adapters/` when this phase starts; no other part of the system needs to change.

Note: Meta changes scopes and app review requirements often. Confirm current requirements in Meta's developer docs before coding, and expect to submit the app for App Review to get `pages_manage_posts` and `instagram_content_publish` approved for anything beyond your own test accounts.

---

## 10. Platform Publishing Adapters

### 10.1 Adapter Interface

```ts
// apps/worker/src/adapters/types.ts
export interface PublishInput {
  text: string;
  media: { path: string; mimeType: string; filename: string }[];
  channel: {
    platform: string;
    platformUserId: string;
    accessToken: string;   // decrypted in memory only
    meta: Record<string, unknown>;
  };
}

export interface PublishResult {
  externalId: string;
  externalUrl?: string;
}

export class PlatformError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
    public readonly code?: string
  ) { super(message); }
}

export interface PlatformAdapter {
  platform: string;
  validate(input: PublishInput): string[];           // returns error messages
  publish(input: PublishInput): Promise<PublishResult>;
  refreshToken?(channel: ChannelRow): Promise<{ accessTokenEnc: string; refreshTokenEnc?: string; expiresAt?: Date }>;
}
```

Rules:
- Adapters never write to the database. They return results or throw `PlatformError`.
- `retryable = true` for network errors, HTTP 429, and 5xx. `retryable = false` for 400 validation, 401 after refresh failed, 403 permission denied, and content rejected.

### 10.2 Per-Platform Publish Logic

**Facebook Page**
- Text only: `POST https://graph.facebook.com/v{version}/{page-id}/feed` with `message` and Page token.
- With images: upload each photo with `published=false`, then `POST /{page-id}/feed` with `attached_media`.
- Video: `POST /{page-id}/videos`.
- Result `id` is `externalId`. URL: `https://facebook.com/{post-id}`.

**Instagram**
- Requires media. Text-only posts are rejected at validation (enforced in `validateForPlatform`).
- Step 1: `POST /{ig-user-id}/media` with `image_url` (must be publicly reachable) or `video_url`, plus `caption`. Creates a container.
- **Important**: Instagram Graph API fetches media from a public URL, not an upload. A local-only app cannot serve this directly. Use a tunnel (ngrok or Cloudflare Tunnel) that temporarily exposes `/api/media/:id/file` during the publish call, then close it. This is the main known limitation for local mode — document it clearly in the README and Channels page.
- Step 2: poll container `status_code` every few seconds until `FINISHED` (typically a few seconds for images, longer for video/reels).
- Step 3: `POST /{ig-user-id}/media_publish` with `creation_id`.
- Result `id` is `externalId`. Build the URL as `https://instagram.com/p/<shortcode>` once available, or omit the URL if the shortcode isn't returned.

**YouTube (planned, not built yet)**
- Will use resumable upload (`POST` init + chunked `PUT`) against `https://www.googleapis.com/upload/youtube/v3/videos`.
- Not implemented in this MVP; adapter stub only, registry entry disabled until built.

### 10.3 Idempotency

Every publish call must send a stable idempotency key where the platform supports it. If the platform does not support it, the worker must first check whether a post with the same local reference already exists (store a generated tag in the text only when the user allows it), or accept the small risk of duplicates on crash-during-publish and document it.

---

## 11. Scheduling Engine

### 11.1 Time Handling Rules

- Store every timestamp in UTC.
- Store the user's timezone on the post for display only.
- Convert to local time only in the UI.
- DST: when the user selects a local time, convert with the IANA timezone database (use `Temporal` polyfill or `luxon`). Reject times that fall in a DST gap.

### 11.2 Queue Slots

Slot-based scheduling (like Buffer's "Posting schedule"):

1. User defines weekly slots per channel, e.g. Mon 09:00, Wed 14:00, Fri 18:00.
2. `next-slot` endpoint:
   - Generate the next N occurrences of each active slot after `now + 5 min`.
   - Exclude times already occupied by a `scheduled` PostChannel for the same channel (within a 5 minute window).
   - Return the earliest free time.
3. The composer pre-fills this time; user may override.

### 11.3 Worker Scheduling Strategy

Use BullMQ delayed jobs (one job per PostChannel). Benefits: no polling, exact timing, persisted in Redis.

Safety net: a **sweeper** runs every 60 seconds in the worker:
- Find PostChannels with `status = queued` and `scheduledAt <= now - 2 min` that have no active job in BullMQ.
- Re-enqueue them with `jobId = postChannelId` (idempotent).
- This recovers from Redis data loss or crashes mid-enqueue.

Required: the sweeper must not pick PostChannels that are currently `publishing`.

---

## 12. Worker Implementation

### 12.1 Bootstrap

- Connect to Redis and Prisma.
- Create `Worker('publish-post-channel', handler, { connection, concurrency: WORKER_CONCURRENCY })`.
- Register `setInterval(sweeper, 60_000)`.
- Register `setInterval(tokenRefresher, 10 * 60_000)`.
- Handle SIGINT/SIGTERM: stop accepting jobs, wait up to 30 seconds for active jobs, then exit.

### 12.2 Job Handler Algorithm

```
handle(job):
  pc = load PostChannel by job.data.postChannelId (include post, channel, media)
  if pc is null -> return (already deleted)
  if pc.status in [published, canceled] -> return (no-op)

  // Claim the row to avoid double-publish
  claimed = UPDATE PostChannel SET status='publishing', attempts=attempts+1
            WHERE id=pc.id AND status IN ('queued','failed')
  if claimed.count == 0 -> return

  try:
    channel = decrypt tokens
    if channel.tokenExpiresAt < now + refreshLead -> refresh tokens (store new)
    text = pc.body ?? pc.post.body
    adapter = registry[channel.platform]
    errors = adapter.validate(...)
    if errors -> mark failed (non-retryable), throw UnrecoverableError
    result = await adapter.publish(...)
    UPDATE PostChannel SET status='published', externalId, externalUrl, publishedAt, lastError=null
    recomputePostStatus(pc.postId)
    audit 'post.published'
  catch err:
    if err is PlatformError and err.retryable and attempts < PUBLISH_MAX_ATTEMPTS:
       UPDATE PostChannel SET status='queued', lastError=msg
       throw err   // BullMQ retries with backoff
    if err is 401 and channel refresh failed:
       UPDATE Channel SET status='needs_reauth'
    UPDATE PostChannel SET status='failed', lastError=msg
    recomputePostStatus(pc.postId)
    audit 'post.failed'
    return (do not retry)
```

### 12.3 Retry Policy

- BullMQ job options: `attempts: 5`, `backoff: { type: 'exponential', delay: 60000 }` (1 min, 2 min, 4 min, 8 min).
- Respect `Retry-After` header on HTTP 429 by overriding the job delay.
- Non-retryable errors use `UnrecoverableError` from BullMQ to stop retries.

### 12.4 Recomputing Post Status

```
if all channels published -> post.status = published, publishedAt = now
else if any published and any failed -> partial
else if all failed -> failed
else if any publishing/queued -> publishing (or scheduled if not yet started)
```

### 12.5 Token Refresh Job

Every 10 minutes:
- Find channels where `tokenExpiresAt < now + TOKEN_REFRESH_LEAD_MINUTES` and refresh token exists.
- Call adapter `refreshToken`.
- On failure, set channel `status = needs_reauth` and notify via UI banner (no email in MVP).

---

## 13. Frontend Implementation

### 13.1 Pages and Routes

| Route | Page | Purpose |
|---|---|---|
| `/` | Dashboard | Counts: scheduled today, failed, published this week. Quick links. |
| `/compose` | Composer | Create or edit a post |
| `/calendar` | Calendar | Month/week view of scheduled PostChannels |
| `/queue` | Queue | List of upcoming scheduled items, with cancel and reschedule |
| `/published` | History | Published and failed posts with external links and error messages |
| `/media` | Media Library | Upload, preview, delete |
| `/channels` | Channels | Connect, disconnect, edit slots, reconnect |
| `/settings` | Settings | Timezone, default slots, max attempts display |

### 13.2 Composer

Components:
- **ChannelPicker**: checkboxes with avatar and platform icon. Disabled channels show "needs reconnect".
- **TextEditor**: textarea with character counter per selected channel. Shows the strictest limit in red when exceeded.
- **PerChannelOverride**: toggle to customize text per channel.
- **MediaPicker**: opens Media Library modal; shows thumbnails; drag to reorder (updates `position`).
- **SchedulePicker**: date, time, timezone. Button "Next free slot" calls `/api/queue/next-slot`.
- **PreviewPane**: shows approximate preview per platform (text plus first image). Not pixel-perfect.
- **Actions**: Save draft, Schedule, Publish now, Cancel.

Validation (client, mirrors server):
- Required: at least one channel, non-empty body or media.
- Per channel: text length, media count, media type support.
- Show warnings (non-blocking) and errors (blocking).

### 13.3 Calendar

- FullCalendar with `timeGridWeek`, `dayGridMonth`, and `listWeek` views.
- Events are PostChannel items colored by platform.
- Drag event to new time calls `POST /api/posts/:id/schedule` with new time. On failure, revert drag and show toast.
- Click event opens side drawer: preview, status, error, buttons (Edit, Cancel, Retry, Open external link).
- Only `scheduled` items are draggable. `published` items are shown read-only.

### 13.4 Queue Page

- Table: time, channel, platform, text excerpt, media count, status, actions.
- Sort and filter by channel and status.
- Bulk cancel.

### 13.5 Channels Page

- Cards for each connected channel: avatar, name, platform, status badge (active, needs reauth), last published time.
- "Connect" buttons for enabled platforms only. Clicking opens `GET /api/oauth/:platform/start` and follows the returned URL.
- Slot editor: 7-day grid, add/remove times per day, timezone select.
- "Disconnect" with confirmation.

### 13.6 State and Data Fetching

- Use TanStack Query for server state. Keys: `['posts', filters]`, `['queue', range]`, `['channels']`, `['media', page]`.
- Invalidate `['queue']` and `['posts']` after any mutation.
- Poll `GET /api/queue` every 30 seconds on the calendar page to reflect worker status changes. Optional: Server-Sent Events in Phase 2.

### 13.7 Design Guidelines

- Responsive: works at 375px and above. Sidebar collapses to bottom nav on mobile.
- Accessible: all controls keyboard reachable; color is never the only status signal (use text and icons).
- Empty states: each page explains the next action (e.g. "Connect a channel to start").
- Toasts for success and error; error toasts include the server message.

---

## 14. Security

### 14.1 Threat Model (Local Context)

Primary risks for a local tool: token leakage from the DB file, accidental exposure of the API on a LAN, CSRF from a malicious site hitting `localhost`, and malicious uploads.

### 14.2 Token Encryption

- Algorithm: AES-256-GCM.
- Key: `TOKEN_ENCRYPTION_KEY` (32 bytes).
- Format stored: `base64(iv) : base64(authTag) : base64(ciphertext)`, with a new random 12-byte IV per encryption.
- Decrypt only inside the worker or API call that needs it. Never log tokens. Never return tokens in API responses.

```ts
// apps/api/src/lib/crypto.ts (outline)
import crypto from 'node:crypto';
export function encrypt(plain: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join(':');
}
export function decrypt(payload: string, key: Buffer): string {
  const [iv, tag, data] = payload.split(':').map(s => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}
```

### 14.3 Network Binding

- API and worker bind to `127.0.0.1` by default. Config option `API_HOST` to change.
- Docker: publish ports as `127.0.0.1:3000:3000`, not `0.0.0.0`.

### 14.4 CSRF and Origin Checks

- Allow only requests with `Origin` equal to `APP_BASE_URL` for mutating methods (POST, PATCH, PUT, DELETE).
- Reject requests without a matching Origin or Referer.
- Use `SameSite=Strict` if cookies are used.

### 14.5 Optional Local Password

For users who run on a shared machine:
- `APP_PASSWORD` env var. If set, a simple login page issues a signed HTTP-only cookie (HMAC with a server secret). All `/api` routes except health and OAuth callbacks require the cookie.

### 14.6 Upload Safety

- Validate MIME type by reading magic bytes, not only the extension or the client header.
- Store files with random names; never use the user-supplied filename on disk.
- Enforce size limit before writing to disk (stream and count).
- Serve with `X-Content-Type-Options: nosniff`.

### 14.7 Secrets Handling

- `.env` is gitignored. Only `.env.example` is committed.
- Docs must warn not to paste tokens into issues or chat.

---

## 15. Logging, Monitoring, and Error Handling

### 15.1 Logging

- Use Pino (structured JSON). Pretty-print in development.
- Every request logs `reqId`, method, path, status, duration. Never log bodies containing tokens or full post text beyond the first 80 characters.
- Worker logs `postChannelId`, `platform`, `attempt`, `result`.

### 15.2 Error Handling

- Central Fastify error handler maps:
  - Zod errors to 400 with field details
  - Prisma not found to 404
  - Unique constraint to 409
  - `PlatformError` in API context (e.g. channel test) to 502 with message
  - Anything else to 500 with generic message; full stack in logs only
- Frontend shows the `error.message`; never a raw stack.

### 15.3 Health and Diagnostics

- `/api/health` reports DB, Redis, and worker heartbeat. Worker writes a heartbeat key to Redis every 30 seconds (`worker:heartbeat`, TTL 90 seconds).
- Settings page includes "Diagnostics" showing last 20 errors from AuditLog and worker heartbeat age.

### 15.4 Backups

- Scheduled task (node-cron in API, every day at 02:00): copy `app.db` to `data/backups/app-YYYYMMDD.db`. Keep last 14.
- Manual: `pnpm db:backup` script.

---

## 16. Local Development Setup (Step by Step)

1. Clone repository and install:
   ```bash
   git clone <repo> social-scheduler && cd social-scheduler
   pnpm install
   cp .env.example .env
   ```
2. Generate encryption key:
   ```bash
   openssl rand -base64 32
   ```
   Put the output in `TOKEN_ENCRYPTION_KEY`.
3. Start Redis:
   ```bash
   docker run -d --name ss-redis -p 127.0.0.1:6379:6379 redis:7-alpine
   ```
4. Create database and run migrations:
   ```bash
   pnpm --filter api prisma migrate dev --name init
   ```
5. Start all services in separate terminals:
   ```bash
   pnpm --filter api dev       # http://localhost:3000
   pnpm --filter worker dev
   pnpm --filter web dev       # http://localhost:5173
   ```
6. Open `http://localhost:5173`, go to Channels, connect Mastodon first (easiest to test).

### 16.1 Root Scripts (`package.json`)

```json
{
  "scripts": {
    "dev": "concurrently \"pnpm:dev:*\"",
    "dev:api": "pnpm --filter api dev",
    "dev:worker": "pnpm --filter worker dev",
    "dev:web": "pnpm --filter web dev",
    "db:migrate": "pnpm --filter api prisma migrate deploy",
    "db:studio": "pnpm --filter api prisma studio",
    "db:backup": "node scripts/backup.js",
    "test": "pnpm -r test",
    "lint": "pnpm -r lint",
    "build": "pnpm -r build"
  }
}
```

---

## 17. Docker Compose (Full Stack)

```yaml
services:
  redis:
    image: redis:7-alpine
    command: ["redis-server", "--appendonly", "yes"]
    volumes: ["redis-data:/data"]
    ports: ["127.0.0.1:6379:6379"]
    restart: unless-stopped

  api:
    build: { context: ., dockerfile: Dockerfile.api }
    env_file: .env
    environment:
      DATABASE_URL: file:/app/data/app.db
      REDIS_URL: redis://redis:6379
    volumes: ["./data:/app/data"]
    ports: ["127.0.0.1:3000:3000"]
    depends_on: [redis]
    restart: unless-stopped

  worker:
    build: { context: ., dockerfile: Dockerfile.worker }
    env_file: .env
    environment:
      DATABASE_URL: file:/app/data/app.db
      REDIS_URL: redis://redis:6379
    volumes: ["./data:/app/data"]
    depends_on: [redis, api]
    restart: unless-stopped

  web:
    build: { context: ., dockerfile: Dockerfile.web }
    ports: ["127.0.0.1:5173:80"]
    depends_on: [api]
    restart: unless-stopped

volumes:
  redis-data:
```

Notes:
- SQLite is shared by API and worker through the same volume. Enable WAL mode (`PRAGMA journal_mode=WAL;`) on startup to reduce lock contention.
- Run `prisma migrate deploy` in the API container entrypoint before starting the server.

Run command: `docker compose up -d --build`

---

## 18. Testing Strategy

### 18.1 Unit Tests (Vitest)

- `crypto.ts`: round-trip encrypt/decrypt; tampered ciphertext throws.
- `validateForPlatform`: length limits, media count, Instagram text-only rejection.
- Slot calculator: DST boundaries, skipping occupied times.
- Post status recomputation: all combinations of channel statuses.
- Retry classification: each HTTP status maps to retryable or not.

### 18.2 Integration Tests

- API with a test SQLite DB and a mocked Redis (ioredis-mock) or real Redis in Docker.
- Create post, schedule, cancel, verify jobs added and removed.
- OAuth callback with mocked token endpoint (msw or nock).
- Media upload rejects oversized and wrong-MIME files.

### 18.3 Adapter Tests

- Each adapter tested against recorded HTTP fixtures (nock). Include success, 429, 401, 500 cases.
- Optional live smoke test script (`pnpm smoke:mastodon`) that posts to a private test account when env flag set.

### 18.4 End-to-End Tests (Playwright)

Scenarios:
1. Upload image, compose text, pick channel, schedule for 2 minutes ahead, wait, verify status `published`.
2. Schedule post, drag in calendar to another time, verify job moved.
3. Force a platform error (mock adapter), verify `failed` status, retry, verify `published`.
4. Disconnect channel, verify its queued posts become `canceled`.

### 18.5 Manual Test Checklist

- [ ] Fresh install with `docker compose up` works
- [ ] Each enabled platform connects and shows avatar and name
- [ ] Reconnect flow works after token revoke
- [ ] Post with 4 images publishes on each platform that supports it
- [ ] Scheduling across DST change publishes at the correct local time
- [ ] Stop worker, schedule a post for 3 minutes ahead, start worker after the time, post still publishes (sweeper)
- [ ] Kill Redis mid-run, restart, pending posts are recovered by sweeper
- [ ] Backup file created
- [ ] Health page shows red when Redis is stopped

---

## 19. Implementation Plan (Phased Tasks)

Estimated effort assumes one full-time developer. Adjust for a team.

### Phase 0: Setup (1 day)
- Create monorepo with pnpm workspaces
- Configure TypeScript, ESLint, Prettier, Vitest
- Add Docker files and Redis container
- Write `.env.example` and config validation

### Phase 1: Data and API Core (3 days)
- Prisma schema and first migration
- Shared package (types, schemas, platform limits)
- Fastify server with error handler, health route, logger
- Channels CRUD (without OAuth yet), posts CRUD, media upload
- Unit tests for services and validation

### Phase 2: OAuth and Facebook/Instagram (3 days)
- Crypto module and tests
- Meta OAuth start and callback, state storage
- `GET /me/accounts` Page picker, Instagram auto-detection via linked Page
- Facebook Page adapter (text, images, video) with token encryption
- Instagram adapter, including tunnel setup for publish-time media URL
- Channel listing and disconnect

### Phase 3: Worker and Scheduling (3 days)
- BullMQ setup, job handler with claim logic
- Delayed job creation on schedule
- Retry policy, UnrecoverableError handling
- Sweeper and heartbeat
- Post status recomputation
- Integration tests

### Phase 4: Frontend Core (4 days)
- Vite + React + Tailwind setup, routing, API client
- Channels page and OAuth connect button
- Composer with channel picker, text, character counts, media picker
- Schedule picker and next-slot suggestion
- Queue and published history pages

### Phase 5: Calendar and Media Library (2 days)
- FullCalendar integration, drag reschedule, event drawer
- Media library grid, preview, delete with safety checks

### Phase 6: YouTube (later phase, not in this MVP)
- Google OAuth, resumable upload adapter, add to platform limits and registry
- No changes needed elsewhere — Channel/Post/worker model already supports it

### Phase 7: Hardening (3 days)
- Security checks (Origin validation, upload magic bytes, bind to localhost)
- Backups and diagnostics page
- Playwright E2E suite
- Error message review and empty states

### Phase 8: Packaging and Documentation (2 days)
- Dockerfiles, docker-compose, run instructions
- README with platform setup guides (screenshots optional)
- Troubleshooting guide (token expiry, redirect URI mismatch, tunnel setup)
- Release tag v1.0.0

Total: about 25–30 working days for MVP.

---

## 20. Definition of Done (MVP)

- [ ] Connect Facebook Page, with Instagram auto-detected if linked
- [ ] Create and schedule a post with text and image; it publishes within 60 seconds of the scheduled time
- [ ] Post status updates correctly: scheduled, publishing, published
- [ ] A forced failure shows `failed` with error text, and retry works
- [ ] Drag to reschedule in calendar works and updates the job
- [ ] Media upload enforces type and size limits
- [ ] Tokens are encrypted in DB (verify by inspecting `app.db`)
- [ ] `docker compose up -d` starts all services; app reachable at `http://localhost:5173`
- [ ] Backups run daily and retain 14 copies
- [ ] README lets a new developer set up in under 30 minutes (excluding platform app approval)
- [ ] All unit and integration tests pass; E2E happy path passes

---

## 21. Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Platform API access denied or paid-only (X, Instagram) | Missing platforms | Start with Mastodon and LinkedIn; mark others as optional |
| Instagram requires public media URLs | Cannot publish from pure localhost | Use Cloudflare Tunnel or ngrok, document limitation |
| Token expiry (LinkedIn ~60 days) | Failed publishes | Detect 401, set `needs_reauth`, show banner |
| Machine off at scheduled time | Missed posts | Clearly state in UI; sweeper publishes late posts on restart; optional "missed post" alert |
| API rate limits | Delayed or failed posts | Respect `Retry-After`; exponential backoff; per-channel concurrency of 1 |
| Duplicate posts after crash mid-publish | Embarrassing duplicates | Claim row before publish; idempotency keys where supported; document residual risk |
| Platform API changes | Breakage | Pin API versions in adapters; adapter tests with fixtures; monitor changelogs |
| Terms of service violations (automation) | Account bans | Use official APIs only; respect rate limits; no scraping or automated engagement |
| SQLite lock contention | Slow writes | WAL mode; short transactions; move to PostgreSQL if needed |

---

## 22. Phase 2 Roadmap (Post-MVP)

1. Analytics: pull likes, reach, and clicks via platform insights APIs; store daily snapshots.
2. Link shortener with UTM builder (local redirect service or external provider).
3. Caption and hashtag templates with variables.
4. AI caption suggestions via user-supplied API key; store key encrypted.
5. CSV bulk import (columns: body, channel, date, time, timezone, media filenames).
6. Multi-user: add User table, roles (admin, editor, approver), approval status `pending_approval`.
7. Server-Sent Events for live status updates in UI.
8. Electron or Tauri desktop wrapper for one-click launch.

---

## 23. Glossary

- **Channel**: a connected social account or page.
- **PostChannel**: one post targeted to one channel; the unit of publishing.
- **Slot**: a recurring weekly time when a channel should post.
- **Sweeper**: periodic worker task that recovers missed or orphaned jobs.
- **PKCE**: Proof Key for Code Exchange, an OAuth extension that protects the authorization code flow.
- **Idempotency key**: a unique value that lets a platform ignore duplicate requests.
- **Claim**: atomic database update that marks a row as being processed, preventing double work.

---

## 24. Handover Checklist

- [ ] Source code pushed to repository with tags
- [ ] `.env.example` complete and current
- [ ] Platform app setup guides written (one per platform)
- [ ] Architecture diagram and this document kept in `/docs`
- [ ] Known limitations listed in README
- [ ] Credentials stored in a password manager, not in the repo
- [ ] Demo recording of end-to-end flow
