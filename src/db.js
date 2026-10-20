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

CREATE INDEX IF NOT EXISTS idx_jobs_pending
  ON jobs (status, scheduled_at, priority)
  WHERE status = 'pending';
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
    close: async () => pool.end(),
  };
}

/* ---------------- Public surface ---------------- */
export const queries = {};   // populated by initDb() (populated in place)
export let db = null;        // set by initDb(); live binding for static importers

export async function initDb() {
  if (!driver) driver = await (config.dbDriver === "pg" ? pgDriver() : sqliteDriver());
  await driver.exec(schema);

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

  queries.insertJob = S(`INSERT INTO jobs (id, channel_id, filename, title, description, hashtags, tags, category, privacy, scheduled_at, priority, next_retry_at, status, created_at, updated_at) VALUES (@id, @channelId, @filename, @title, @description, @hashtags, @tags, @category, @privacy, @scheduledAt, @priority, @nextRetryAt, @status, @created, @updated)`);
  queries.claimJob = S(`UPDATE jobs SET status = 'uploading' WHERE id = @id AND status = 'pending' RETURNING *`);
  queries.dueJobs = S(`SELECT * FROM jobs WHERE status = 'pending' AND scheduled_at <= @now AND (next_retry_at IS NULL OR next_retry_at <= @now) ORDER BY priority ASC, scheduled_at ASC, created_at ASC`);
  queries.setJobStatus = S(`UPDATE jobs SET status = @status, retry_count = @retryCount, next_retry_at = @nextRetryAt, last_error = @lastError, updated_at = @updatedAt WHERE id = @id`);
  queries.requeueJob = S(`UPDATE jobs SET status = 'pending', retry_count = retry_count + 1, next_retry_at = @nextRetryAt, channel_id = @channelId, last_error = @lastError, updated_at = @updatedAt WHERE id = @id`);
  queries.markDone = S(`UPDATE jobs SET status = 'done', retry_count = @retryCount, last_error = NULL, updated_at = @updatedAt WHERE id = @id`);
  queries.findJob = S(`SELECT * FROM jobs WHERE id = @id`);
  queries.listJobs = S(`SELECT * FROM jobs ORDER BY priority ASC, scheduled_at ASC, created_at DESC`);
  queries.insertUpload = S(`INSERT INTO uploads (id, job_id, channel_id, youtube_id, youtube_url, etag, quota_cost, created_at) VALUES (@id, @jobId, @channelId, @youtubeId, @youtubeUrl, @etag, @quotaCost, @created)`);

  db = driver; // activate live binding for static importers
  return driver;
}

export function getDb() {
  if (!db) throw new Error("db not initialised — call initDb() first");
  return db;
}
