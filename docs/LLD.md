# Low-Level Design

## 1. Repository map

| Path | Role |
|---|---|
| `src/server.js` | Express initialization, static serving, route mounts, signed media endpoint, DB startup. |
| `src/worker.js` | Worker lifecycle and recurring planner, watcher, cleanup, and scheduler loops. |
| `src/config.js` | Environment and optional Google secret-file configuration. |
| `src/db.js` | Cross-driver DB adapter, schema, startup migrations, prepared query catalog. |
| `src/routes/` | HTTP endpoints for session/auth, YouTube channels, jobs, Instagram, folder rotation, explorer. |
| `src/middleware/` | Auth guard and multipart staging upload middleware. |
| `src/services/` | Authentication, OAuth, scheduling, provider integrations, scanning, timezone math, rotation planning, errors, signed media URLs. |
| `public/` | Static dashboard and login/registration page. |
| `tests/` | Node test-runner unit/integration suites for scheduler, auth, routes, rotation, and timezone behavior. |
| `scripts/` | Start/stop helpers, seed, and DB reset. |

## 2. HTTP route map

Authentication requirements below reflect the route mount and route middleware in source. `REQUIRE_AUTH=false` changes only the `/api/videos` mount and seed behavior; many endpoints still apply `requireAuth` themselves.

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET | `/` | Redirect to login when auth is required and no valid JWT cookie exists; otherwise serve UI. | Conditional |
| GET | `/login`, `/register` | Serve login/registration HTML. | Public |
| GET | `/api/health` | Process/database health summary. | Public |
| POST | `/api/auth/register` | Create email/password account and issue cookie. | Public |
| POST | `/api/auth/login` | Verify credentials and issue cookie. | Public |
| POST | `/api/auth/logout` | Clear auth cookie. | Public |
| GET | `/api/auth/profile` | Read current account profile. | Required |
| PATCH | `/api/auth/profile` | Update name/email/avatar and renew cookie. | Required |
| GET | `/api/auth/google`, `/api/auth/google/callback` | App-level Google SSO. | Public OAuth flow |
| GET | `/api/auth/connect` | Start YouTube channel OAuth. | Route does not explicitly require app auth |
| GET | `/api/auth/channels/:id/reauth` | Reauthorize a selected YouTube channel through Google OAuth; callback verifies the selected account matches the channel. | Required |
| GET | `/auth/callback` | YouTube channel OAuth callback with state check. | Public OAuth callback |
| GET | `/api/auth/channels` | List YouTube channel metadata, including access-token expiry. | Required |
| POST | `/api/auth/channels/:id/deactivate` | Deactivate a YouTube channel. | Required |
| POST | `/api/videos` | Multipart batch create jobs (field `video`; optional JSON `metadata`). | Conditional at mount |
| GET | `/api/videos` | List jobs with provider result fields. | Conditional at mount |
| GET | `/api/videos/:id` | Read one job. | Conditional at mount |
| PATCH | `/api/videos/:id` | Update metadata for pending job. | Conditional at mount |
| DELETE | `/api/videos/:id` | Mark pending job deleted. | Conditional at mount |
| GET | `/api/instagram/connect` | Begin Instagram Login. | Required |
| GET | `/api/instagram/callback` | Instagram OAuth callback/state validation. | OAuth callback |
| GET | `/api/instagram/accounts`, `/api/instagram/status` | List/status for Instagram accounts. | Required |
| POST | `/api/instagram/accounts/:id/disconnect` | Deactivate Instagram account. | Required |
| GET | `/api/folders` | List registered folders. | Required |
| POST | `/api/folders` | Register absolute folder and scan it. | Required |
| DELETE | `/api/folders/:id` | Delete folder and cascading source metadata/rules. Already-created jobs remain. | Required |
| POST | `/api/folders/:id/rescan` | Scan folder now. | Required |
| GET | `/api/folders/:id/items` | List indexed source items. | Required |
| GET/POST | `/api/folders/:id/rules` | List/create rules. | Required |
| PATCH/DELETE | `/api/rules/:id` | Update/delete a rotation rule. | Required |
| GET | `/api/rules/:id/assignments` | List rule assignments. | Required |
| GET | `/api/rules/:id/slots` | Preview upcoming slots. | Required |
| POST | `/api/rotation/plan` | Trigger planner pass. | Required |
| POST | `/api/rotation/cleanup` | Trigger orphan-media cleanup. | Required |
| GET | `/api/explorer/tables`, `/api/explorer/table/:name` | Browse table inventory and capped rows. | Required |
| POST | `/api/explorer/query` | Execute bounded read-only SQL. | Required |
| GET | `/media/:filename` | Serve media to provider if a valid signed URL is supplied. | Signature required |

The worker also runs planner and cleanup functions internally, without making HTTP requests.

## 3. Job lifecycle and scheduling

### Job creation

`POST /api/videos` uses Multer disk storage. The `video` field can repeat up to `MAX_UPLOAD_FILES`; each file has a configurable size limit and a video MIME/extension check. Files are given random UUID names with the original extension and stored below `STORAGE_ROOT`.

Metadata supports a JSON `metadata` part (web UI; can include ordered `items`) and legacy flat form fields. One job is inserted per file. Supported platform/format pairs are YouTube `video` or `short`, and Instagram `reel`. A YouTube job can select a channel or leave it unset for worker rotation. An Instagram job must specify an active Instagram account. Bulk upload can auto-schedule selected files in list order from a local start time with a configurable minute interval; each generated time remains individually editable before submission.

### Worker dispatch

1. `runTick()` refreshes expired daily channel budgets.
2. It reads pending jobs whose `scheduled_at` and `next_retry_at` are due, ordered by priority, schedule, and creation time.
3. For each job, it enforces global concurrency and resolves an eligible YouTube channel or Instagram account. YouTube channel selection checks active status, optional pinned channel, estimated quota budget, and per-channel concurrency.
4. A conditional update claims the row by setting status to `uploading` only while it is still `pending`.
5. Provider execution is tracked in process-local in-flight sets/maps; completion frees the slot.

### States

Common observed values: `pending`, `uploading`, `done`, `failed`, `exhausted`, and `deleted`. The database also defines a legacy `queued` value in one cancellation predicate. `processing` appears in some UI filter/status presentation but is not the active claim status in the worker implementation. Rotation assignments use `planned`, `scheduled`, `published`, `failed`, and `skipped` as lifecycle labels; job completion is recorded on the job row.

### Failure policy

- Auth errors: deactivate the failing provider connection. YouTube jobs can be requeued without a pinned channel while retry capacity remains; Instagram jobs are marked failed.
- Fatal provider/input errors: mark failed.
- Rate-limit and transient errors: exponential backoff with jitter and provider `Retry-After` where available; mark exhausted at the configured retry limit.
- Dry-run YouTube uploads simulate success and can simulate a configurable initial series of rate-limit failures.

## 4. Rotation internals

### Scan and deduplication

`scanFolder(folderId)` reads direct child files only, filters a fixed video-extension allowlist, computes streaming SHA-256 hashes, and inserts `source_items`. Hash is globally unique, so byte-identical files in different folders are not indexed twice. A repeated file in the same folder refreshes its path/size. Unreachable folders record `status='unreachable'` and scan time.

### Slot generation

`timezone.js` uses `Intl.DateTimeFormat` with an IANA timezone to map wall-clock date/time to epoch seconds while accounting for the offset at the candidate instant. Frequencies are daily, every N days, or selected weekdays (Monday=0 through Sunday=6). Start date is a lower bound. The planner considers up to eight candidate slots per rule in one pass and schedules only within its 72-hour horizon.

### Assignment and media copy

- Dedicated mode chooses a `new` item that has no assignment for any rule.
- Shared mode chooses a `new` or `used` item not yet assigned to this rule.
- A `media_assets` record is keyed by SHA-256. The source file is copied once into `STORAGE_ROOT`; shared-pool jobs can refer to that copy.
- The job uses `source='rotation'`, `media_asset_id`, a rendered caption/title, private privacy, and the selected YouTube channel.
- Cleanup deletes media metadata and its canonical file only when no job references the media asset.

## 5. Database model

All IDs are text UUIDs. Timestamps are epoch seconds in `BIGINT` columns unless otherwise noted.

| Table | Purpose and key relationships |
|---|---|
| `users` | Sign-in identity, password hash or Google subject, display name/avatar. No ownership relationships to jobs/channels. |
| `channels` | YouTube channel ID/name, OAuth tokens, quota counters/reset, activity. |
| `instagram_accounts` | Instagram identity, token/expiry, active state. |
| `jobs` | Unified scheduled work; provider/format, metadata, schedule, retry state, source, optional media asset. Optional YouTube channel; optional Instagram account ID. |
| `uploads` | Successful YouTube result, channel, video ID/URL, etag, quota cost; references job. |
| `instagram_uploads` | Successful Reel result and permalink; unique job reference. |
| `source_folders` | Watched absolute folder path, activity, scan interval/status. |
| `source_items` | Folder file metadata, hash, detected state; hash unique application-wide. |
| `rotation_rules` | Per-folder and per-channel recurrence, timezone, pool mode, caption template. |
| `rotation_assignments` | Rule/item slot, status, optional generated job; unique `(rule_id,item_id)`. |
| `media_assets` | Canonical staged file keyed by unique hash, referenced by rotation jobs. |

The schema and startup migrations are in `src/db.js`. SQLite enables foreign keys and WAL. PostgreSQL uses a connection pool; int8 values are parsed to JavaScript numbers.

## 6. Authentication and provider security

- Session JWTs are signed with `JWT_SECRET`, transported in an HTTP-only, same-site cookie, and expire according to `JWT_EXPIRES_IN`.
- Passwords use bcryptjs with a cost factor of 10.
- Google app login matches/creates users by Google subject or email; OAuth state is held in an HTTP-only cookie for five minutes.
- YouTube connect and Instagram login each use OAuth state cookies and callbacks. YouTube channel metadata exposes access-token expiry; the UI flags expired access tokens and offers channel-specific reauthentication. Google access tokens may also refresh automatically from a valid stored refresh token.
- `/media/:filename` requires a valid HMAC-SHA256 signature and expiry no more than 24 hours ahead; comparison is timing-safe.
- Explorer query route allows a narrow set of read-like leading keywords, rejects interior semicolons, and caps output at 1000 rows; table browsing caps rows at 100.
- Security limitations and production configuration cautions are recorded in `ADR.md`.

## 7. Configuration reference

Defaults are defined in `src/config.js`.

| Variable | Default | Used for |
|---|---|---|
| `PORT` | `3000` | Express listener and default callback URL interpolation. |
| `DB_DRIVER` | `sqlite` | `sqlite` or `pg` database adapter. |
| `DB_PATH` | `./data/scheduler.db` | SQLite database path. |
| `DATABASE_URL` | empty | PostgreSQL connection string. |
| `STORAGE_ROOT` | `./storage` | Staged upload and rotation media root. |
| `DRY_RUN` | `false` | Simulate YouTube publishing. |
| `REQUIRE_AUTH` | `true` | Root/video route gating and default account seeding. |
| `JWT_SECRET` | development placeholder | JWT signature secret; replace for deployment. |
| `JWT_EXPIRES_IN` | `7d` | JWT expiration. |
| `AUTH_COOKIE_NAME` | `scheduler_auth` | Session cookie name. |
| `AUTH_COOKIE_SECURE` | `false` | Add Secure flag to session cookie. |
| `LOGIN_EMAIL` | `admin@scheduler.local` | First-run seeded email. |
| `LOGIN_PASSWORD` | `scheduler` | First-run seeded password. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | empty | Google OAuth credentials; env values override optional credentials JSON. |
| `GOOGLE_CALLBACK_URL` | localhost callback | YouTube channel OAuth callback. |
| `GOOGLE_SSO_CALLBACK_URL` | localhost SSO callback | Google app-login callback. |
| `YOUTUBE_SCOPES` | upload + readonly scopes | YouTube OAuth scopes. |
| `GOOGLE_SSO_SCOPES` | `openid,email,profile` | App SSO scopes. |
| `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` | empty | Instagram Login and signed media URL HMAC key. |
| `INSTAGRAM_CALLBACK_URL` | localhost callback | Instagram OAuth callback. |
| `APP_PUBLIC_URL` | empty | Public HTTPS origin for provider media fetches. |
| `WORKER_TICK_MS` | `2000` | Queue poll cadence. |
| `MAX_CONCURRENT_UPLOADS` | `2` | Global in-flight publishing cap. |
| `PER_CHANNEL_MAX_CONCURRENT` | `1` | Per-provider identity in-flight cap. |
| `PLAN_INTERVAL_MS` | `300000` | Rotation planner and cleanup cadence. |
| `WATCHER_SETTLE_MS` | `2000` | Debounce window for filesystem changes. |
| `DEFAULT_DAILY_QUOTA` | `10000` | YouTube daily quota estimate. |
| `UPLOAD_QUOTA_COST` | `1600` | Estimated quota units per YouTube upload. |
| `QUOTA_BURN_FRACTION` | `0.85` | Stop dispatching before estimated daily quota is exhausted. |
| `BACKOFF_BASE`, `BACKOFF_MAX`, `MAX_RETRIES` | `15`, `3600`, `8` | Retry policy controls. |
| `MAX_UPLOAD_FILES`, `UPLOAD_MAX_FILE_SIZE` | `20`, `5 GiB` | Multipart limits. |

## 8. Test coverage map

`npm test` uses Node's built-in test runner across `tests/*.test.js`.

| Test file | Covered area |
|---|---|
| `tests/auth.test.js` | OAuth state validation, auth primitives, login/register/profile/logout. |
| `tests/user-identity.test.js` | User identity and email changes. |
| `tests/explorer.test.js` | Read-only query guardrails and table browsing. |
| `tests/folders.test.js` | Folder/rule API, rotation planner, slot assignment, media reuse/cleanup, watcher status. |
| `tests/timezone.test.js` | Time validation, DST-aware offsets, recurrence, and caption rendering. |
| `tests/scheduler.test.js` | Due-job execution, quota-aware channel selection, concurrency and retries. |

Some test suites start an HTTP listener and therefore require an environment that permits local socket binding.

## 9. Source of truth

Implementation details should be checked against `src/config.js`, `src/db.js`, route modules, service modules, and tests. The root README remains the operator quick-start and deployment guide. Update this document set when runtime behavior or schema changes.
