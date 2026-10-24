# Architecture Decision Records

This file records the decisions that explain the current implementation. It describes the repository as it exists; it is not a wishlist or an implementation plan.

## ADR-001: Use a small Node.js and Express application

- **Status:** Accepted
- **Decision:** Use native JavaScript ES modules, Express, and a static browser UI in `public/`.
- **Context:** This application is a self-hosted scheduler with a compact operator interface and background publishing. The current UI is plain HTML, CSS, and browser JavaScript; there is no React build step.
- **Consequences:** The server can serve the interface directly. UI behavior is implemented in `public/index.html` and `public/login.html`; API and provider behavior remain server-side. Large UI changes currently live in the HTML files.

## ADR-002: Separate HTTP serving from background work

- **Status:** Accepted
- **Decision:** Run the Express API and queue worker as separate Node processes (`src/server.js` and `src/worker.js`).
- **Context:** Media uploads can take a long time, while schedule handling and UI requests should remain responsive.
- **Consequences:** Both processes initialize the same configured database and share the media storage volume. The worker claims due jobs, publishes them, and also runs folder watchers, rotation planning, and orphan-media cleanup. Multiple workers can be started, but deployment must use a database and claim semantics suitable for concurrent workers.

## ADR-003: Support SQLite locally and PostgreSQL in container deployments

- **Status:** Accepted
- **Decision:** Expose one async database interface backed by `better-sqlite3` or `pg`, selected with `DB_DRIVER`.
- **Context:** SQLite is simple for local use and tests; Docker defaults to PostgreSQL and avoids relying on SQLite's native module in the runtime image.
- **Consequences:** Queries are authored with `@name` parameters and translated for PostgreSQL by `src/db.js`. Schema changes are applied at startup through create-if-missing DDL and guarded additive migrations. SQLite uses WAL and enables foreign keys.

## ADR-004: Persist scheduled uploads as database jobs

- **Status:** Accepted
- **Decision:** Store manual and rotation-generated work in `jobs`; let the worker select due `pending` jobs and claim them with a conditional status update.
- **Context:** Jobs must survive process restarts and support editing, cancellation, retry, and upload history.
- **Consequences:** A future `scheduled_at` keeps a job pending until due. Claims use `UPDATE ... WHERE status='pending' RETURNING *`, so competing worker ticks do not both start the same pending job. There is no separate Redis queue.

## ADR-005: Use provider OAuth and persist connection records

- **Status:** Accepted
- **Decision:** Connect YouTube channels and Instagram accounts through their respective OAuth flows and persist credentials and connection metadata in the database.
- **Context:** Publishing must use official provider APIs and the operator may manage more than one account/channel.
- **Consequences:** OAuth state is checked against short-lived cookies. YouTube channels carry quota accounting; Instagram accounts use a separate table and publishing flow. Credentials are not returned by the account listing APIs. Token-at-rest encryption is not implemented in this repository and should be treated as a deployment security concern.

## ADR-006: Use signed, expiring URLs for Instagram media fetches

- **Status:** Accepted
- **Decision:** Expose staged media only through `/media/:filename` with a time-limited HMAC signature, for the external Instagram service to fetch during Reel publishing.
- **Context:** Instagram's publishing flow needs a publicly reachable HTTPS media URL; the app's storage directory must not be served as a public static directory.
- **Consequences:** `APP_PUBLIC_URL` must be a public HTTPS origin and the Instagram app secret signs the URL. The API validates filename shape, expiry, and signature before sending a file.

## ADR-007: Keep folder rotation in the existing job pipeline

- **Status:** Accepted
- **Decision:** Scan watched folders, hash and deduplicate source files, calculate timezone-aware slots, then create ordinary `jobs` rows for the existing worker.
- **Context:** Rotation should reuse upload execution, retry handling, and history rather than create a second publishing pipeline.
- **Consequences:** The planner stages a canonical copy in `STORAGE_ROOT`, references it through `media_assets`, and limits concrete jobs to a 72-hour horizon. Shared pool items can be used by distinct rules; dedicated pool items are assigned once. Chokidar events are debounced, with periodic scanning as a safety net.

## ADR-008: Gate the operator application with an HTTP-only JWT cookie

- **Status:** Accepted
- **Decision:** Email/password registration and login issue a signed JWT in an HTTP-only cookie; Google SSO is also implemented. `REQUIRE_AUTH` defaults to true.
- **Context:** Profile, channels, scheduling, folder management, and the database explorer are operator functions.
- **Consequences:** The browser redirects to `/login` after an API 401. The initial local account may be seeded from `LOGIN_EMAIL` and `LOGIN_PASSWORD` when the users table is empty. Set a strong `JWT_SECRET` and replace default credentials before deployment. `REQUIRE_AUTH=0` disables the main video-route gate and default-user seeding; route-level auth remains on some endpoints.

## ADR-009: Keep the admin UI dependency-light and themeable

- **Status:** Accepted
- **Decision:** Implement the interface as static HTML and browser JavaScript, using CSS variables for dashboard styling and light/dark themes.
- **Context:** The application is served directly by Express and does not currently use a frontend toolchain.
- **Consequences:** Theme selection is persisted in browser local storage. The app shell, schedule, queue, history, channels, rotation, media, settings, and explorer views are hash-selected sections in the single-page UI. Authentication uses a separate HTML page that shares the theme preference.

## ADR-010: Keep the database explorer read-only and authenticated

- **Status:** Accepted
- **Decision:** Expose table browsing and a bounded ad-hoc query endpoint only behind authentication, and accept only single read-query statements.
- **Context:** The UI is an operational/debugging aid and must not provide write access through arbitrary SQL.
- **Consequences:** The route rejects non-read keywords and stacked statements, caps results, and whitelists table names for table browsing. The database connection itself still has its normal application permissions, so the route's validation is a guardrail rather than a database-level read-only role.

## Known gaps and operating cautions

- App users are not associated with owned channels/jobs in the current schema; authentication is an application gate, not a multi-tenant authorization model.
- OAuth tokens are stored in database columns without application-level encryption.
- Cookie secure flags for some OAuth state flows are configured for local HTTP use; production HTTPS deployments should review cookie and proxy settings.
- Docker Compose uses simple example PostgreSQL credentials; replace them for any non-disposable deployment.
- The UI and API currently expose a broad set of admin operations to any authenticated user.
