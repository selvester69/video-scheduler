/**
 * DB Explorer SQL-guard tests.
 *
 * Covers the read-only /auth-gated `POST /api/explorer/query` contract:
 *   - unauthenticated -> 401
 *   - SELECT (incl. leading `;` and a read-only CTE `WITH`) -> 200 with rows
 *   - INSERT / UPDATE / DELETE / DROP / stacked statements -> 400
 *
 * The "SELECT * FROM users" case re-asserts the identity invariant from the
 * adjacent suite: the row returned is the one that was actually registered
 * (`selvester69@...`-style seed), not some phantom account.
 *
 * Isolated: own temp SQLite DB + own Express app (DB_DRIVER=sqlite via the
 * lazy better-sqlite3 import). Runs under `node --test tests/*.test.js`.
 */
import { mkdirSync } from "fs";
import { rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import express from "express";

const tmp = join(tmpdir(), `yt-sched-explorer-${process.pid}`);
mkdirSync(tmp, { recursive: true });

// Env MUST precede app imports (config.js reads process.env at import time).
process.env.NODE_ENV = "test";
process.env.DB_DRIVER = "sqlite";
process.env.DB_PATH = join(tmp, "test.db");
process.env.STORAGE_ROOT = join(tmp, "storage");
process.env.DRY_RUN = "true";
process.env.JWT_SECRET = "explorer-test-secret";

const { initDb, queries, nowSec } = await import("../src/db.js");
const { config } = await import("../src/config.js");
const authSrv = await import("../src/services/auth.js");
const { default: sessionRouter } = await import("../src/routes/session.js");
const { default: explorerRouter } = await import("../src/routes/explorer.js");
const { requireAuth } = await import("../src/middleware/auth.js");

const { hashPassword } = authSrv;
const COOKIE = config.auth.cookieName;
const SEED = "selvester69@gmail.com"; // the "wrong" account from the support report

let app, server, base, jar;

async function request(path, { method = "GET", json, cookie } = {}) {
  const headers = {};
  if (json !== undefined) headers["Content-Type"] = "application/json";
  if (cookie) headers["Cookie"] = cookie;
  const res = await fetch(`${base}${path}`, { method, headers, body: json !== undefined ? JSON.stringify(json) : undefined, redirect: "manual" });
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const text = await res.text();
  return { status: res.status, setCookies, text };
}
function cookieValue(setCookies, name) {
  for (const c of setCookies) if (c.startsWith(name + "=")) return c.split(";")[0].slice(name.length + 1);
  throw new Error(`cookie ${name} not set`);
}
function authCookie(setCookies) {
  return `${COOKIE}=${cookieValue(setCookies, COOKIE)}`;
}
async function query(sql, { authed = true } = {}) {
  return request("/api/explorer/query", { method: "POST", json: { sql }, cookie: authed ? jar : undefined });
}

before(async () => {
  await initDb();
  // Seed one real user so SELECT has data, and so login yields an auth cookie.
  await queries.insertUser.run({
    id: "u-explorer", email: SEED, name: "Seeded", passwordHash: await hashPassword("s3cret"),
    avatar: null, created: nowSec(), updated: nowSec(),
  });
  app = express();
  app.use(express.json());
  app.use("/api/auth", sessionRouter);
  app.use("/api/explorer", requireAuth, explorerRouter);
  app.use((req, res) => res.status(404).json({ error: "not found" }));
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
  const r = await request("/api/auth/login", { method: "POST", json: { email: SEED, password: "s3cret" } });
  assert.equal(r.status, 200, "seed login must succeed");
  jar = authCookie(r.setCookies);
});

after(async () => {
  try { server?.close?.(); } catch {}
  try { await (await import("../src/db.js")).getDb()?.close?.(); } catch {}
  try { await rm(tmp, { recursive: true, force: true }); } catch {}
});

describe("DB Explorer", () => {
  test("rejects unauthenticated requests -> 401", async () => {
    const r = await query("SELECT 1", { authed: false });
    assert.equal(r.status, 401);
  });

  test("allows SELECT and returns columns + rows (seeded identity)", async () => {
    const r = await query("SELECT email, name FROM users ORDER BY created_at");
    assert.equal(r.status, 200);
    const j = JSON.parse(r.text);
    assert.deepEqual(j.columns, ["email", "name"]);
    assert.ok(j.rowCount >= 1);
    assert.equal(j.rows[0].email, SEED, "the row returned must be the seeded identity, not a phantom");
    assert.equal(j.truncated, false);
  });

  test("strips a single trailing semicolon (SELECT 1;) -> 200", async () => {
    const r = await query("SELECT 1 AS one;");
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.text).rows[0].one, 1);
  });

  test("allows a read-only CTE (WITH … SELECT) -> 200", async () => {
    const r = await query("WITH x AS (SELECT 1 AS n) SELECT n FROM x");
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.text).rows[0].n, 1);
  });

  test("rejects INSERT -> 400", async () => {
    const r = await query("INSERT INTO users (id, email, name) VALUES ('x','x@x.com','x')");
    assert.equal(r.status, 400);
    assert.match(r.text, /read-only/);
  });

  test("rejects UPDATE -> 400", async () => {
    const r = await query("UPDATE users SET name = 'hacked'");
    assert.equal(r.status, 400);
  });

  test("rejects DELETE -> 400", async () => {
    const r = await query("DELETE FROM users");
    assert.equal(r.status, 400);
  });

  test("rejects DROP TABLE -> 400", async () => {
    const r = await query("DROP TABLE users");
    assert.equal(r.status, 400);
  });

  test("rejects stacked statements (SELECT 1; SELECT 2) -> 400", async () => {
    const r = await query("SELECT 1; SELECT 2");
    assert.equal(r.status, 400);
    assert.match(r.text, /multiple statements/);
  });
});
