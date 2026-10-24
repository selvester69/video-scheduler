/**
 * SQLite + PostgreSQL data layer behind ONE async interface.
 *
 * Why two drivers?
 *   - SQLite (`better-sqlite3`): zero-config, single-file. Used for local dev
 *     + tests (where no Postgres is available). Native module is loaded
 *     LAZILY only when DB_DRIVER=sqlite, so the PG Docker image never touches it.
 *   - PostgreSQL (`pg`, pure JS): the production/Docker driver — no native
 *     compilation, so it sidesteps the better-sqlite3 linux/arm64 segfault in
 *     containers. Selected with DB_DRIVER=pg (+ DATABASE_URL).
 *
 * All queries use `@name` params + `RETURNING`. The pg adapter translates
 * `@name` → `$1, $2, …` and parses int8 → Number. Every statement is async
 * (returns a Promise) so call sites `await` uniformly.
 */
import { config } from "./config.js";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";

export const nowSec = () => Math.floor(Date.now() / 1000);

// Portable schema (epoch columns are BIGINT; SQLite treats BIGINT as INTEGER).
// Timestamps are always supplied by the app, so there's no dialect-specific
// DEFAULT (e.g. sqlite's strftime).
const schema = `
CREATE TABLE IF NOT EXISTS channels (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  google_client_id     TEXT,
  google_client_secret TEXT,
  access_token         TEXT,
  refresh_token        TEXT,
  token_expires_at     BIGINT,
  quota_reset_at       BIGINT NOT NULL,
  quota_used           INTEGER NOT NULL DEFAULT 0,
  last_used_at         BIGINT,
  active               INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT,
  password_hash TEXT,
  google_sub    TEXT UNIQUE,
  avatar        TEXT,
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL
);


CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  channel_id    TEXT REFERENCES channels(id),
  filename      TEXT NOT NULL,
  title         TEXT NOT NULL,
  description   TEXT,
  hashtags      TEXT NOT NULL DEFAULT '',
  tags          TEXT NOT NULL DEFAULT '',
  category      TEXT,
  privacy       TEXT NOT NULL DEFAULT 'private',
  platform      TEXT NOT NULL DEFAULT 'youtube',
  format        TEXT NOT NULL DEFAULT 'video',
  instagram_account_id TEXT,
  facebook_page_id TEXT,
  scheduled_at  BIGINT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  priority      INTEGER NOT NULL DEFAULT 0,
  retry_count   INTEGER NOT NULL DEFAULT 0,
  next_retry_at BIGINT,
  last_error    TEXT,
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS uploads (
  id            TEXT PRIMARY KEY,
  job_id        TEXT NOT NULL REFERENCES jobs(id),
  channel_id    TEXT NOT NULL REFERENCES channels(id),
  youtube_id    TEXT NOT NULL,
  youtube_url   TEXT NOT NULL,
  etag          TEXT,
  quota_cost    INTEGER NOT NULL,
  created_at    BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS instagram_accounts (
  id                TEXT PRIMARY KEY,
  username          TEXT NOT NULL,
  access_token      TEXT NOT NULL,
  token_expires_at  BIGINT NOT NULL,
  active            INTEGER NOT NULL DEFAULT 1,
  created_at        BIGINT NOT NULL,
  updated_at        BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS instagram_uploads (
  id                TEXT PRIMARY KEY,
  job_id            TEXT NOT NULL UNIQUE REFERENCES jobs(id),
  instagram_media_id TEXT NOT NULL,
  permalink         TEXT,
  created_at        BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS facebook_pages (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  access_token      TEXT NOT NULL,
  token_expires_at  BIGINT,
  active            INTEGER NOT NULL DEFAULT 1,
  created_at        BIGINT NOT NULL,
  updated_at        BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS facebook_uploads (
  id                TEXT PRIMARY KEY,
  job_id            TEXT NOT NULL UNIQUE REFERENCES jobs(id),
  facebook_video_id TEXT NOT NULL,
  permalink         TEXT,
  created_at        BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_pending
  ON jobs (status, scheduled_at, priority)
  WHERE status = 'pending';

/* ================= Folder-import / rotation feature ===============
 *
 * A SourceFolder points the scanner at a watched directory. Files discovered
 * there become SourceItems, deduplicated app-wide by sha256. RotationRules
 * bind a folder to a channel with an independent schedule. The Assignment
 * Planner (Phase 2) turns assignments into real jobs rows, which the
 * existing worker uploads unchanged — so the publish path is reused.
 *
 * media_assets tracks files copied into the app's own media store
 * (config.storageRoot). A job may reference one (jobs.media_asset_id) so a
 * single copy can be reused across multiple channels (shared pool) and cleaned
 * up once nothing references it (Phase 2 cleanup policy).
 */
CREATE TABLE IF NOT EXISTS source_folders (
  id            TEXT PRIMARY KEY,
  path          TEXT NOT NULL,                 -- absolute watched path
  active        INTEGER NOT NULL DEFAULT 1,
  scan_interval INTEGER NOT NULL DEFAULT 300,  -- seconds (polling safety net)
  status        TEXT NOT NULL DEFAULT 'reachable', -- reachable | unreachable (FR-ROT-07)
  last_scan_at  BIGINT,
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_items (
  id          TEXT PRIMARY KEY,
  folder_id   TEXT NOT NULL REFERENCES source_folders(id) ON DELETE CASCADE,
  filename    TEXT NOT NULL,
  file_path   TEXT NOT NULL,
  size_bytes  BIGINT NOT NULL,
  sha256      TEXT NOT NULL UNIQUE,            -- app-wide dedup key (FR-ROT-06)
  detected_at BIGINT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'new',     -- new | used | skipped | failed
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS rotation_rules (
  id               TEXT PRIMARY KEY,
  folder_id        TEXT NOT NULL REFERENCES source_folders(id) ON DELETE CASCADE,
  channel_id       TEXT NOT NULL REFERENCES channels(id),
  frequency        TEXT NOT NULL,              -- daily | every_n_days | weekdays
  interval_n       INTEGER,                    -- for every_n_days
  weekdays         TEXT,                       -- CSV of 0-6 (Mon-Sun) for weekdays
  time_of_day      TEXT NOT NULL,              -- "HH:mm"
  timezone         TEXT NOT NULL DEFAULT 'UTC',
  start_date       BIGINT NOT NULL,            -- epoch seconds (UTC day boundary)
  pool_mode        TEXT NOT NULL DEFAULT 'shared', -- shared | dedicated
  caption_template TEXT,                       -- {filename} {index} {date}
  active           INTEGER NOT NULL DEFAULT 1,
  created_at       BIGINT NOT NULL,
  updated_at       BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS rotation_assignments (
  id           TEXT PRIMARY KEY,
  rule_id      TEXT NOT NULL REFERENCES rotation_rules(id) ON DELETE CASCADE,
  item_id      TEXT NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
  scheduled_at BIGINT,                         -- NULL until promoted to a job
  job_id       TEXT REFERENCES jobs(id),       -- NULL until a job is created (horizon)
  status       TEXT NOT NULL DEFAULT 'planned',-- planned | scheduled | published | failed | skipped
  created_at   BIGINT NOT NULL,
  updated_at   BIGINT NOT NULL,
  UNIQUE(rule_id, item_id)
);

CREATE TABLE IF NOT EXISTS media_assets (
  id         TEXT PRIMARY KEY,
  sha256     TEXT NOT NULL UNIQUE,
  path       TEXT NOT NULL,                    -- relative to storageRoot (== jobs.filename)
  size_bytes BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_items_folder    ON source_items(folder_id);
CREATE INDEX IF NOT EXISTS idx_rules_folder    ON rotation_rules(folder_id);
CREATE INDEX IF NOT EXISTS idx_assign_rule     ON rotation_assignments(rule_id, status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_assign_item     ON rotation_assignments(item_id);
`;

let driver = null;

/* ---------------- SQLite driver (local dev / tests) ---------------- */
async function sqliteDriver() {
  const { default: Database } = await import("better-sqlite3");
  const dir = dirname(config.dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const db = new Database(config.dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");

  // Async-shim: forward all args so `.get()` (0 params) works too.
  const stmt = (s) => ({
    run: async (...a) => s.run(...a),
    get: async (...a) => s.get(...a),
    all: async (...a) => s.all(...a),
  });
  return {
    prepare: (sql) => stmt(db.prepare(sql)),
    exec: async (sql) => { db.exec(sql); },
    // Raw ad-hoc SQL, read-only by contract (the /api/explorer route enforces
    // SELECT-only BEFORE it reaches here). Returns { columns, rows, rowCount }.
    queryRaw: async (sql) => {
      const st = db.prepare(sql);
      const rows = st.all();
      const cols = (st.columns() || []).map((c) => c.name);
      return {
        columns: cols.length ? cols : (rows.length ? Object.keys(rows[0]) : []),
        rows,
        rowCount: rows.length,
      };
    },
    close: async () => db.close(),
    raw: db,
  };
}

/* ---------------- PostgreSQL driver (Docker / prod) ---------------- */
let _pgTypes;
async function pgDriver() {
  const { Pool, types } = await import("pg");
  if (!_pgTypes) {
    // pg returns int8 (bigint) as a string by default; coerce to Number so
    // epoch-second math works everywhere.
    types.setTypeParser(types.builtins.INT8, (val) => (val === null ? null : Number(val)));
    _pgTypes = types;
  }
  const pool = new Pool({ connectionString: config.databaseUrl });

  const compile = (sql, params) => {
    if (!params) return { text: sql, values: [] };
    let out = "";
    const values = [];
    const seen = new Map();
    let n = 0;
    for (let i = 0; i < sql.length; i++) {
      const ch = sql[i];
      if (ch === "-" && sql[i + 1] === "-") {
        while (i < sql.length && sql[i] !== "\n") out += sql[i++];
        continue;
      }
      if (ch === "'") {
        // Copy a string literal verbatim, honoring '' and \ escapes. We must
        // NOT advance past the char following the closing quote (the for-loop's
        // own i++ handles that), else the next character gets dropped.
        out += ch; i++;
        while (i < sql.length) {
          const c = sql[i];
          if (c === "\\" && sql[i + 1] !== undefined) { out += c + sql[i + 1]; i += 2; continue; }
          if (c === "'" && sql[i + 1] === "'") { out += "''"; i += 2; continue; }
          out += c;
          if (c === "'") break;
          i++;
        }
        // The for-loop's own i++ consumes the closing quote; do NOT advance here.
        continue;
      }
      if (ch === "@") {
        // Match a whole identifier in one shot (single-char regexes only check
        // one char, avoiding the classic 2-char-pattern-on-1-char bug).
        const m = /^@([A-Za-z_][A-Za-z0-9_]*)/.exec(sql.slice(i));
        if (!m) { out += ch; continue; }
        const name = m[1];
        if (!seen.has(name)) { n++; seen.set(name, n); values.push(params[name] ?? null); }
        out += `$${seen.get(name)}`;
        i += m[0].length - 1; // -1: the for-loop's i++ advances past the match
        continue;
      }
      out += ch;
    }
    return { text: out, values };
  };
  const runQuery = (sql, params) => pool.query(compile(sql, params));

  return {
    prepare: (sql) => ({
      run: async (p) => {
        const r = await runQuery(sql, p);
        return { changes: r.rowCount, lastInsertRowid: r.rows?.[0]?.id ?? null };
      },
      get: async (p) => (await runQuery(sql, p)).rows[0],
      all: async (p) => (await runQuery(sql, p)).rows,
    }),
    exec: async (sql) => {
      for (const s of sql.split(";").map((x) => x.trim()).filter(Boolean)) {
        await pool.query(s);
      }
    },
    // Raw ad-hoc SQL, read-only by contract (the /api/explorer route enforces
    // SELECT-only BEFORE it reaches here). Returns { columns, rows, rowCount }.
    queryRaw: async (sql) => {
      const r = await runQuery(sql);
      return {
        columns: (r.fields || []).map((f) => f.name),
        rows: r.rows,
        rowCount: r.rowCount != null ? r.rowCount : r.rows.length,
      };
    },
    close: async () => pool.end(),
  };
}

/* ---------------- Public surface ---------------- */
export const queries = {};   // populated by initDb() (populated in place)
export let db = null;        // set by initDb(); live binding for static importers

// Ad-hoc read-only SQL for the DB Explorer UI. The caller (route) is responsible
// for enforcing SELECT-only; this just executes and returns { columns, rows, rowCount }.
export async function rawQuery(sql) {
  if (!db) throw new Error("database not initialized");
  return db.queryRaw(sql);
}

export async function initDb() {
  if (!driver) driver = await (config.dbDriver === "pg" ? pgDriver() : sqliteDriver());
  await driver.exec(schema);

  // --- Idempotent migrations for the `users` table (existing deployments) ---
  // google_sub was added after the initial email/password rollout. Fresh DBs
  // get it from CREATE TABLE above; here we add it to older DBs WITHOUT
  // downtime. Both statements are wrapped so "already exists" errors are
  // ignored — safe to re-run.
  const migrations = [
    `ALTER TABLE users ADD COLUMN google_sub TEXT`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub)`,
    // Rotation feature: tag jobs created by the folder-import planner (vs. 'manual'),
    // and optionally point a job at a reused media_asset row (shared pool, Phase 2).
    `ALTER TABLE jobs ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'`,
    `ALTER TABLE jobs ADD COLUMN media_asset_id TEXT`,
    `ALTER TABLE jobs ADD COLUMN platform TEXT NOT NULL DEFAULT 'youtube'`,
    `ALTER TABLE jobs ADD COLUMN format TEXT NOT NULL DEFAULT 'video'`,
    `ALTER TABLE jobs ADD COLUMN instagram_account_id TEXT`,
    `ALTER TABLE jobs ADD COLUMN facebook_page_id TEXT`,
    // Folder watcher: track whether a watched path is currently reachable.
    `ALTER TABLE source_folders ADD COLUMN status TEXT NOT NULL DEFAULT 'reachable'`,
  ];
  for (const sql of migrations) {
    try { await driver.exec(sql); }
    catch (e) { /* column/index already present — OK */ }
  }

  // Build the statement set AFTER schema exists (sqlite validates INSERT
  // column lists at prepare time). All statements carry the same async surface
  // regardless of driver.
  const S = (sql) => driver.prepare(sql);
  queries.insertChannel = S(`INSERT INTO channels (id, name, google_client_id, google_client_secret, refresh_token, quota_reset_at) VALUES (@id, @name, @clientId, @clientSecret, @refreshToken, @quotaResetAt)`);
  queries.findChannel = S(`SELECT * FROM channels WHERE id = @id`);
  queries.listActiveChannels = S(`SELECT * FROM channels WHERE active = 1 ORDER BY last_used_at ASC, quota_used ASC`);
  queries.spendQuota = S(`UPDATE channels SET quota_used = quota_used + @cost, last_used_at = @now WHERE id = @id`);
  queries.tickAllBudgets = S(`UPDATE channels SET quota_used = 0, quota_reset_at = quota_reset_at + 86400 WHERE quota_reset_at <= @now`);
  queries.deactivateChannel = S(`UPDATE channels SET active = 0 WHERE id = @id`);
  queries.saveTokens = S(`UPDATE channels SET access_token = @accessToken, refresh_token = COALESCE(@refreshToken, refresh_token), token_expires_at = @expiresAt WHERE id = @id`);

  queries.insertUser = S(`INSERT INTO users (id, email, name, password_hash, avatar, created_at, updated_at) VALUES (@id, @email, @name, @passwordHash, @avatar, @created, @updated) RETURNING id, email, name, avatar, created_at`);
  queries.findUserByEmail = S(`SELECT id, email, name, password_hash, avatar, google_sub, created_at FROM users WHERE email = @email`);
  queries.findUserByGoogleSub = S(`SELECT id, email, name, password_hash, avatar, google_sub, created_at FROM users WHERE google_sub = @googleSub`);
  queries.linkGoogle = S(`UPDATE users SET email = @email, name = COALESCE(@name, name), avatar = COALESCE(@avatar, avatar), google_sub = @googleSub, updated_at = @updatedAt WHERE id = @id RETURNING id, email, name, avatar, created_at`);
  queries.findUserById = S(`SELECT id, email, name, password_hash, avatar, created_at FROM users WHERE id = @id`);
  queries.updateUser = S(`UPDATE users SET email = COALESCE(@email, email), name = COALESCE(@name, name), avatar = COALESCE(@avatar, avatar), updated_at = @updatedAt WHERE id = @id RETURNING id, email, name, avatar, created_at`);
  queries.userCount = S(`SELECT COUNT(*) AS n FROM users`);

  queries.insertJob = S(`INSERT INTO jobs (id, channel_id, filename, title, description, hashtags, tags, category, privacy, scheduled_at, priority, next_retry_at, status, created_at, updated_at) VALUES (@id, @channelId, @filename, @title, @description, @hashtags, @tags, @category, @privacy, @scheduledAt, @priority, @nextRetryAt, @status, @created, @updated)`);
  queries.insertPlatformJob = S(`INSERT INTO jobs (id, channel_id, filename, title, description, hashtags, tags, category, privacy, platform, format, instagram_account_id, facebook_page_id, scheduled_at, priority, next_retry_at, status, created_at, updated_at) VALUES (@id, @channelId, @filename, @title, @description, @hashtags, @tags, @category, @privacy, @platform, @format, @instagramAccountId, @facebookPageId, @scheduledAt, @priority, @nextRetryAt, @status, @created, @updated)`);
  queries.claimJob = S(`UPDATE jobs SET status = 'uploading' WHERE id = @id AND status = 'pending' RETURNING *`);
  queries.dueJobs = S(`SELECT * FROM jobs WHERE status = 'pending' AND scheduled_at <= @now AND (next_retry_at IS NULL OR next_retry_at <= @now) ORDER BY priority ASC, scheduled_at ASC, created_at ASC`);
  queries.setJobStatus = S(`UPDATE jobs SET status = @status, retry_count = @retryCount, next_retry_at = @nextRetryAt, last_error = @lastError, updated_at = @updatedAt WHERE id = @id`);
  queries.requeueJob = S(`UPDATE jobs SET status = 'pending', retry_count = retry_count + 1, next_retry_at = @nextRetryAt, channel_id = @channelId, last_error = @lastError, updated_at = @updatedAt WHERE id = @id`);
  queries.markDone = S(`UPDATE jobs SET status = 'done', retry_count = @retryCount, last_error = NULL, updated_at = @updatedAt WHERE id = @id`);
  queries.findJob = S(`SELECT * FROM jobs WHERE id = @id`);
  queries.findInstagramAccount = S(`SELECT * FROM instagram_accounts WHERE id = @id`);
  queries.listInstagramAccounts = S(`SELECT id, username, token_expires_at, active FROM instagram_accounts ORDER BY username`);
  queries.deactivateInstagramAccount = S(`UPDATE instagram_accounts SET active = 0, updated_at = @updatedAt WHERE id = @id`);
  queries.saveInstagramToken = S(`UPDATE instagram_accounts SET access_token = @accessToken, token_expires_at = @expiresAt, updated_at = @updatedAt WHERE id = @id`);
  queries.insertInstagramUpload = S(`INSERT INTO instagram_uploads (id, job_id, instagram_media_id, permalink, created_at) VALUES (@id, @jobId, @mediaId, @permalink, @created)`);
  queries.upsertFacebookPage = S(`INSERT INTO facebook_pages (id, name, access_token, token_expires_at, active, created_at, updated_at) VALUES (@id, @name, @accessToken, @expiresAt, 1, @now, @now) ON CONFLICT(id) DO UPDATE SET name = excluded.name, access_token = excluded.access_token, token_expires_at = excluded.token_expires_at, active = 1, updated_at = excluded.updated_at`);
  queries.findFacebookPage = S(`SELECT * FROM facebook_pages WHERE id = @id`);
  queries.listFacebookPages = S(`SELECT id, name, token_expires_at, active FROM facebook_pages ORDER BY name`);
  queries.deactivateFacebookPage = S(`UPDATE facebook_pages SET active = 0, updated_at = @updatedAt WHERE id = @id`);
  queries.insertFacebookUpload = S(`INSERT INTO facebook_uploads (id, job_id, facebook_video_id, permalink, created_at) VALUES (@id, @jobId, @videoId, @permalink, @created)`);
  queries.listJobs = S(`SELECT jobs.*, uploads.youtube_url AS youtube_url,
      COALESCE(uploads.youtube_url, instagram_uploads.permalink, facebook_uploads.permalink) AS published_url,
      instagram_accounts.username AS instagram_username,
      facebook_pages.name AS facebook_page_name
    FROM jobs
    LEFT JOIN uploads ON uploads.job_id = jobs.id
    LEFT JOIN instagram_uploads ON instagram_uploads.job_id = jobs.id
    LEFT JOIN instagram_accounts ON instagram_accounts.id = jobs.instagram_account_id
    LEFT JOIN facebook_uploads ON facebook_uploads.job_id = jobs.id
    LEFT JOIN facebook_pages ON facebook_pages.id = jobs.facebook_page_id
    ORDER BY jobs.priority ASC, jobs.scheduled_at ASC, jobs.created_at DESC`);
  queries.insertUpload = S(`INSERT INTO uploads (id, job_id, channel_id, youtube_id, youtube_url, etag, quota_cost, created_at) VALUES (@id, @jobId, @channelId, @youtubeId, @youtubeUrl, @etag, @quotaCost, @created)`);

  /* ---- folder import / rotation queries ---- */
  queries.insertFolder = S(`INSERT INTO source_folders (id, path, active, scan_interval, last_scan_at, created_at, updated_at) VALUES (@id, @path, @active, @scanInterval, @lastScanAt, @created, @updated)`);
  queries.findFolderByPath = S(`SELECT * FROM source_folders WHERE path = @path`);
  queries.findFolder = S(`SELECT * FROM source_folders WHERE id = @id`);
  queries.deleteFolder = S(`DELETE FROM source_folders WHERE id = @id`);
  queries.listFolders = S(`SELECT *, (SELECT COUNT(*) FROM source_items WHERE folder_id = source_folders.id) AS item_count FROM source_folders ORDER BY created_at DESC`);
  queries.setFolderLastScan = S(`UPDATE source_folders SET last_scan_at = @lastScanAt, updated_at = @updatedAt WHERE id = @folderId`);
  queries.setFolderStatus = S(`UPDATE source_folders SET status = @status, updated_at = @updatedAt WHERE id = @folderId`);
  queries.listActiveFolders = S(`SELECT * FROM source_folders WHERE active = 1 ORDER BY created_at ASC`);

  queries.insertItem = S(`INSERT INTO source_items (id, folder_id, filename, file_path, size_bytes, sha256, detected_at, status, created_at, updated_at) VALUES (@id, @folderId, @filename, @filePath, @sizeBytes, @sha256, @detectedAt, @status, @created, @updated)`);
  queries.findItemByHash = S(`SELECT * FROM source_items WHERE sha256 = @sha256`);
  queries.updateItemLocation = S(`UPDATE source_items SET filename = @filename, file_path = @filePath, size_bytes = @sizeBytes, updated_at = @updatedAt WHERE id = @id`);
  queries.updateItemStatus = S(`UPDATE source_items SET status = @status, updated_at = @updatedAt WHERE id = @id`);
  queries.listFolderItems = S(`SELECT * FROM source_items WHERE folder_id = @folderId ORDER BY detected_at DESC`);

  queries.insertRule = S(`INSERT INTO rotation_rules (id, folder_id, channel_id, frequency, interval_n, weekdays, time_of_day, timezone, start_date, pool_mode, caption_template, active, created_at, updated_at) VALUES (@id, @folderId, @channelId, @frequency, @intervalN, @weekdays, @timeOfDay, @timezone, @startDate, @poolMode, @captionTemplate, @active, @created, @updated)`);
  queries.findRule = S(`SELECT * FROM rotation_rules WHERE id = @id`);
  queries.listRulesForFolder = S(`SELECT * FROM rotation_rules WHERE folder_id = @folderId ORDER BY created_at DESC`);
  queries.updateRule = S(`UPDATE rotation_rules SET frequency = @frequency, interval_n = @intervalN, weekdays = @weekdays, time_of_day = @timeOfDay, timezone = @timezone, start_date = @startDate, pool_mode = @poolMode, caption_template = @captionTemplate, active = @active, updated_at = @updatedAt WHERE id = @id`);
  queries.deleteRule = S(`DELETE FROM rotation_rules WHERE id = @id`);

  queries.insertAssignment = S(`INSERT INTO rotation_assignments (id, rule_id, item_id, scheduled_at, job_id, status, created_at, updated_at) VALUES (@id, @ruleId, @itemId, @scheduledAt, @jobId, @status, @created, @updated)`);
  queries.findAssignmentByItem = S(`SELECT * FROM rotation_assignments WHERE item_id = @itemId`);
  queries.listAssignmentsForRule = S(`SELECT a.*, i.filename, i.sha256 FROM rotation_assignments a JOIN source_items i ON i.id = a.item_id WHERE a.rule_id = @ruleId ORDER BY a.created_at DESC`);
  queries.updateAssignmentSlot = S(`UPDATE rotation_assignments SET scheduled_at = @scheduledAt, job_id = @jobId, status = @status, updated_at = @updatedAt WHERE id = @id`);

  queries.insertMediaAsset = S(`INSERT INTO media_assets (id, sha256, path, size_bytes, created_at, updated_at) VALUES (@id, @sha256, @path, @sizeBytes, @created, @updated)`);
  queries.findMediaByHash = S(`SELECT * FROM media_assets WHERE sha256 = @sha256`);
  queries.deleteMediaAsset = S(`DELETE FROM media_assets WHERE id = @id`);
  queries.listOrphanedMedia = S(`SELECT m.* FROM media_assets m LEFT JOIN jobs j ON j.media_asset_id = m.id WHERE j.id IS NULL`);

  /* ---- assignment-planner queries (Phase 2) ---- */
  queries.listActiveRules = S(`SELECT * FROM rotation_rules WHERE active = 1 ORDER BY created_at ASC`);
  queries.findAssignmentForSlot = S(`SELECT * FROM rotation_assignments WHERE rule_id = @ruleId AND scheduled_at = @scheduledAt`);
  queries.countAssignmentsBeforeSlot = S(`SELECT COUNT(*) AS n FROM rotation_assignments WHERE rule_id = @ruleId AND scheduled_at < @scheduledAt`);
  // Eligible items for the planner. dedicated: never assigned to ANY rule yet.
  // shared: not yet assigned to THIS rule (a 'used' item is still eligible for
  // other rules/channels, but each rule publishes it at most once).
  queries.pickItemDedicated = S(`SELECT s.* FROM source_items s WHERE s.folder_id = @folderId AND s.status = 'new' AND NOT EXISTS (SELECT 1 FROM rotation_assignments a WHERE a.item_id = s.id) ORDER BY s.detected_at ASC, s.created_at ASC`);
  queries.pickItemShared = S(`SELECT s.* FROM source_items s WHERE s.folder_id = @folderId AND s.status IN ('new','used') AND NOT EXISTS (SELECT 1 FROM rotation_assignments a WHERE a.rule_id = @ruleId AND a.item_id = s.id) ORDER BY s.detected_at ASC, s.created_at ASC`);
  // Rotation-created jobs reuse the same columns but carry source='rotation' + media_asset_id.
  queries.insertRotationJob = S(`INSERT INTO jobs (id, channel_id, filename, title, description, hashtags, tags, category, privacy, scheduled_at, priority, next_retry_at, status, created_at, updated_at, source, media_asset_id) VALUES (@id, @channelId, @filename, @title, @description, @hashtags, @tags, @category, @privacy, @scheduledAt, @priority, @nextRetryAt, @status, @created, @updated, 'rotation', @mediaAssetId)`);

  db = driver; // activate live binding for static importers
  return driver;
}

export function getDb() {
  if (!db) throw new Error("db not initialised — call initDb() first");
  return db;
}
