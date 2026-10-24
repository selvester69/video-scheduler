# Production Readiness Assessment

## Purpose

This document identifies changes that would move the current self-hosted scheduler toward production operation. Findings are based on the repository implementation at the time this document was written. The list is a prioritized engineering roadmap, not a claim that the controls are already present.

“Production grade” depends on whether this remains a single-operator installation or becomes a multi-user hosted service. The first roadmap below assumes a private, single-operator deployment on a trusted host. A separate section describes work required before offering it to multiple customers.

## Current strengths

- The API and publishing worker are separate processes.
- Scheduled jobs and rotation state are persisted in SQLite or PostgreSQL.
- Job claiming uses a conditional database update, and worker concurrency is configurable.
- Upload retries are bounded and use exponential backoff with jitter; provider retry-after is considered for classified rate limits.
- OAuth flows include state checks, and the Instagram media endpoint uses expiring HMAC-signed URLs.
- Uploaded media is staged on disk instead of loaded entirely into memory.
- Folder rotation uses content hashes, a scheduling horizon, DST-aware slot calculation, and shared media references.
- Tests cover core authentication flows, queue retries, timezone calculations, and rotation behaviors.

## Priority 0: Close security and data-loss risks before public deployment

### 1. Enforce authentication consistently

`src/server.js` conditionally gates `/api/videos`, but the YouTube channel connect route is mounted without `requireAuth`. The auth configuration does not uniformly protect all account and publishing-related operations. Audit every route and make authentication mandatory in production. Protect YouTube OAuth initiation and callbacks against unauthenticated account linking, and verify that callbacks are bound to the initiating user/session.

Also disable public account registration for a single-operator installation or provide an explicit invite/admin-controlled registration mode. Right now any visitor can register, while many operations are shared globally rather than scoped to the account that logged in.

### 2. Remove insecure production defaults and validate configuration at startup

`JWT_SECRET`, seeded credentials, `AUTH_COOKIE_SECURE`, and sample PostgreSQL credentials have unsafe defaults for deployment. Add a production-mode startup validator that fails closed unless:

- `JWT_SECRET` is set to a high-entropy value.
- seeded credentials are changed or seeding is disabled safely.
- `AUTH_COOKIE_SECURE=true` when served over HTTPS.
- PostgreSQL credentials are non-default and secrets are supplied outside the image/repository.
- configured OAuth callback URLs and public app origin are HTTPS and consistent.
- integer/range settings (port, file size, concurrency, retries, quota values) are valid.

Do not log the seeded password. Prefer a one-time bootstrap flow or operator-created initial account.

### 3. Protect cookies, cross-origin requests, and browser forms

`app.use(cors())` currently allows broad cross-origin access, and the session cookie is `SameSite=Lax` rather than a complete CSRF defense for state-changing requests. Configure exact allowed origins (or remove CORS if same-origin is the only supported mode), add Origin/Referer or CSRF token checks for mutations, and consistently set `Secure`, `HttpOnly`, and an intentional `SameSite` value behind TLS. Trust proxy headers only when the app is actually behind a trusted proxy.

### 4. Make queue execution recover safely after crashes

Jobs are claimed by setting `status='uploading'`, but there is no lease/heartbeat or startup recovery for jobs left in that state after a process or host crash. Add a claim lease (`claimed_at`, worker ID, lease expiry) and recover expired claims. Before automatic retries after uncertain provider outcomes, handle the possibility that the provider completed the upload but the app failed before recording success. Use provider idempotency where available, and otherwise add reconciliation/manual review for ambiguous outcomes to avoid duplicate publishing.

### 5. Add transactional integrity for job and rotation writes

Batch upload handling writes files and then inserts jobs in a loop. Partial DB failure can leave orphaned files or a partially-created batch. Rotation planning creates a media copy, job, and assignment in separate operations. Use database transactions for logically atomic rows, plus compensating cleanup for files copied/staged before transaction commit. Make planner concurrency safe across multiple worker processes (e.g. advisory/row locks or unique slot constraints) so simultaneous planner runs cannot double-assign the same slot/item.

### 6. Establish verified backups and restore procedures

Back up PostgreSQL and media storage together, with documented retention, encryption, off-host copies, and tested restore drills. A backup that restores database rows without referenced media is incomplete. For SQLite, use a consistent online backup method that respects WAL. Document recovery objectives and how to reconcile jobs after restoring a snapshot.

## Priority 1: Reliability, operations, and abuse resistance

### 7. Add request limits and upload lifecycle controls

- Add authentication/login/register rate limits and lockout/backoff controls.
- Set request body size limits explicitly and add API-level rate limits for expensive endpoints.
- Validate content using server-side file inspection where practical; MIME type and filename extension are supplied by the client and are not sufficient proof of media type.
- Limit aggregate request size and concurrent upload intake, not only per-file count and size.
- Enforce free disk-space thresholds and return actionable errors before exhausting storage.
- Define retention and cleanup for manually uploaded media, including terminal jobs and deleted jobs.
- Clean staged files if metadata validation or database insertion fails.
- Ensure reverse proxy and container limits allow large streaming uploads without buffering the whole body.

### 8. Add observability and operational endpoints

- Use structured logs with request ID, job ID, provider, attempt number, and worker ID; redact tokens, credentials, signed URL signatures, and sensitive payloads.
- Separate liveness from readiness. Readiness should verify DB connectivity and required storage access; liveness should not fail simply because a third-party provider is temporarily down.
- Export metrics for queue depth/age, job outcomes, retries, stale claims, per-provider latency/errors, quota estimates, disk use, planner outcomes, and worker capacity.
- Add alert guidance for stalled queues, repeated OAuth failures, exhausted jobs, low storage, DB pool saturation, and backup failures.
- Add graceful shutdown: stop claiming jobs, finish or safely release in-flight claims, close DB pools/watchers, and exit within the orchestrator timeout. Current worker shutdown schedules `process.exit` after a fixed delay without explicit claim release.

### 9. Strengthen PostgreSQL and migration operations

- Move schema changes from opportunistic startup DDL/try-catch migrations to versioned, ordered migrations with checksums and a deployment step.
- Ensure multi-worker and API startup cannot race migrations.
- Add PostgreSQL indexes for queue filters and observed query paths; review query plans with realistic queue volumes.
- Configure pool size, connection timeouts, statement timeouts, SSL requirements, and connection health checks.
- Test migrations from every supported prior schema, not only a clean database.
- Add constraints for status values, provider/format combinations, and relationships where portable across SQLite and PostgreSQL.

### 10. Harden HTTP and error handling

- Add security headers (including a considered Content Security Policy), disable unnecessary framework disclosure, and configure TLS at a documented reverse proxy or ingress.
- Add a final Express error handler and stable JSON error contract; avoid returning internal exception messages to clients.
- Validate request shapes with schemas and normalize all user input at API boundaries.
- Add timeouts and bounded retries for outbound provider calls, while preserving upload stream semantics.
- Use least-privilege PostgreSQL roles; the app DB user should not own the database or have unnecessary DDL permissions at runtime.
- Run containers read-only where possible, drop Linux capabilities, pin base images, and scan dependencies/images.

### 11. Test the real deployment modes

- Run the complete test suite in CI with local socket binding enabled; current route integration suites require opening a local listener.
- Add browser-level tests for login, account connection presentation, schedule form, theme persistence, uploads, responsive layout, and error states.
- Add PostgreSQL integration tests; SQLite passing does not prove dialect compatibility or cross-worker claim behavior.
- Add multi-worker tests for duplicate claims, concurrent planner ticks, retry after crash, and provider ambiguity.
- Mock provider HTTP interactions with deterministic fixtures and include contract checks for OAuth and upload adapters.
- Add migration, backup/restore, disk-full, slow-provider, and graceful-shutdown tests.
- Keep dry-run useful, but do not treat it as a substitute for provider sandbox/integration testing.

## Priority 2: Product and scale decisions

### 12. Decide whether the product is single-operator or multi-tenant

The current schema has no `user_id` ownership links from jobs, channels, Instagram accounts, folders, or rules. If this is to be a hosted multi-user service, add a tenant/user ownership model and enforce authorization on every read and write, including provider callbacks, uploads, explorer, media access, and background work. Add tenant isolation tests before onboarding multiple customers.

For a private single-operator install, remove or admin-gate open registration, use one managed administrator, restrict network access, and document that all authenticated users have broad access.

### 13. Remove or isolate the SQL Explorer in production

The explorer validates a limited set of leading read keywords, but it executes queries using the application database connection. A syntactically read-like statement can still be expensive, reveal secrets, or invoke driver-specific behavior. Prefer disabling this feature in production. If it is required, use a separate DB account with read-only permissions, statement timeout, query cancellation, stricter SQL parsing, and audit logging.

### 14. Improve deployment reproducibility

- Pin Node image versions by digest for release builds; keep base images and npm dependencies updated through automated security review.
- Add a CI pipeline for lint/static checks, tests, migration checks, image build, SBOM generation, and vulnerability scanning.
- Define explicit health checks for API and worker and remove dependency ordering that does not represent a health requirement.
- Separate development and production Compose/configuration; never ship example secrets as usable defaults.
- Document TLS termination, DNS, OAuth callback registration, provider app review requirements, persistent volume sizing, log retention, upgrades, rollback, and secret rotation.
- Build and test a release artifact once, then promote the same immutable image through environments.

## Suggested delivery sequence

| Stage | Deliverable | Exit condition |
|---|---|---|
| A. Private deployment baseline | Route auth audit, secure config validation, strict CORS/CSRF policy, secret replacement, explorer disabled or isolated. | Unauthenticated requests cannot view or mutate operator data; production refuses weak defaults. |
| B. Durable job processing | Claim leases/recovery, transactional writes, planner concurrency protection, ambiguous provider outcome handling. | Crash/restart and multi-worker tests show no silent stuck jobs or duplicate slot creation. |
| C. Recoverability | Database + media backup, restore runbook, retention policy. | A restore drill recovers both queue state and referenced media within stated objectives. |
| D. Operability | Structured logs, health/readiness, metrics/alerts, graceful shutdown, resource thresholds. | Operators can detect and diagnose a stalled queue, failed provider, or storage issue. |
| E. Release quality | CI, PostgreSQL/migration/browser tests, hardened images, dependency scanning. | Reproducible release passes automated checks and rollback procedure is documented. |
| F. Hosted multi-user (only if needed) | Tenant model, ownership enforcement, invite/registration design, tenant isolation. | Cross-tenant authorization tests pass across API, worker, files, and provider connections. |

## Production launch checklist

- [ ] Confirm single-operator versus hosted multi-tenant product scope.
- [ ] Audit and test authentication on every route, especially YouTube OAuth connect and callbacks.
- [ ] Add secure production startup validation and remove weak defaults.
- [ ] Restrict CORS and add CSRF defenses for state-changing cookie-authenticated requests.
- [ ] Set TLS, secure cookie behavior, trusted proxy configuration, and security headers.
- [ ] Implement claim leases, stale-job recovery, and provider outcome reconciliation.
- [ ] Make batch and rotation writes transactional and planner runs safe across workers.
- [ ] Define media retention and clean orphaned staged files.
- [ ] Implement and test coordinated DB/media backups and restore.
- [ ] Add request/upload limits, rate limits, disk monitoring, and safe error responses.
- [ ] Add structured logs, readiness/liveness, metrics, and alerts.
- [ ] Add versioned migrations and test upgrades from supported prior releases.
- [ ] Test PostgreSQL, multiple workers, browser flows, crash recovery, and restore in CI/staging.
- [ ] Disable or isolate the SQL Explorer with a read-only DB role and query timeout.
- [ ] Harden and scan release images; rotate all provider and application secrets.
- [ ] Document deployment, upgrades, rollback, incident response, and provider reauthorization.
