# Repository Guidelines

## Build and test

- Use Node.js 20 or newer.
- Install dependencies with `npm install`.
- Run the full test suite with `npm test`.
- Run one test file with `node --test tests/auth.test.js` (or another `tests/*.test.js` file).
- Filter tests by name with `node --test --test-name-pattern="profile email" tests/auth.test.js`.
- Run the API with `npm run dev` and the worker separately with `npm run dev:worker`; `npm start` uses `scripts/start.sh` to launch the available local or Docker setup.
- There are no configured build or lint scripts in the root `package.json`.

## Architecture

- `src/server.js` initializes the database, seeds the first account when auth is enabled, serves `public/`, and mounts the API routers. The browser UI is static HTML/CSS/JavaScript; its login page is `public/login.html`.
- `src/routes/` handles HTTP and validation. `src/services/` owns scheduling, uploads, OAuth, folder scanning/watching, rotation planning, and timezone/caption logic. Keep route handlers thin and put reusable behavior in the corresponding service.
- `src/worker.js` is a separate process. `src/services/scheduler.js` claims due database jobs and calls the YouTube upload service; the worker also runs rotation planning and folder watching. Its polling is against the app database, not YouTube. Do not add periodic YouTube API polling.
- `src/db.js` defines the shared schema, migrations, and query interface for SQLite and PostgreSQL. `src/services/rotation-planner.js` turns folder rules and eligible media into ordinary scheduled jobs, which the existing worker uploads.
- `tests/` uses Node's built-in test runner and temporary SQLite databases. Auth and route tests boot the real Express routers; scheduler tests use dry-run uploads.

## Repository conventions

- During active feature development, do not create or modify test cases unless the user explicitly asks for tests; focus on implementing the requested change.
- Database access is asynchronous at call sites for both drivers. Define reusable statements in `initDb()` in `src/db.js`, use named `@parameter` placeholders, and account for the PostgreSQL adapter's SQL translation when writing queries.
- Store application timestamps as Unix epoch seconds. Keep schema and queries portable between SQLite and PostgreSQL.
- Keep YouTube channel OAuth separate from app sign-in: channel connection uses `/api/auth/connect` and `/auth/callback`; app sessions use `/api/auth/*`. OAuth callbacks validate the single-use `state` cookie.
- Upload requests stage video files on disk through `stageUpload`; scheduled jobs reference those files until the worker uploads them. Rotation media is content-addressed and may be shared by multiple jobs, so preserve its reference-counted cleanup behavior.
- YouTube quota, concurrency, retry, and channel-rotation behavior belongs in the worker/services and is configured through environment variables in `src/config.js`. Avoid calling YouTube APIs just to refresh UI status; the UI can refresh the app's own API.
- Follow `README.md` for OAuth setup, environment configuration, and operational commands. The root `.env` is local configuration; do not copy credentials or account-specific values into tracked files.
