/**
 * User-identity regression tests.
 *
 * Why this file exists: a support report said the live SSO "user id" was coming
 * back as `selvester69` when it should have been `mindwiring1209@gmail.com`.
 * Investigation showed the app has NO hardcoded email and sources the identity
 * purely from the credential Google returns (`payload.email` in auth.js) — the
 * live mix-up was the user's browser being signed into the wrong Google account.
 *
 * These tests lock in the offline-invariant that the identity in use is always
 * the one the user *proves* — the email on the login/credential, not a stale or
 * hardcoded value:
 *   - register as `selvester69@gmail.com` (the "wrong/old" account) -> works
 *   - a totally unknown email -> 401
 *   - rename the account to `mindwiring1209@gmail.com`
 *   - the OLD email (`selvester69`) can no longer sign in -> 401
 *   - the NEW email (`mindwiring1209`) signs in and IS the identity used
 *     (profile + decoded auth-token both carry `mindwiring1209`)
 *   - no `users` row remains with `selvester69`
 *
 * Isolated: its own temp SQLite DB (DB_DRIVER unset -> better-sqlite3 lazy import),
 * fresh process via `node --test tests/*.test.js`, so it never touches the
 * auth.test.js shared database.
 */
import { mkdirSync } from "fs";
import { rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { test, before, after, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";

// Env MUST precede any app import (config.js reads process.env at import time).
const tmp = join(tmpdir(), `yt-sched-identity-${process.pid}`);
mkdirSync(tmp, { recursive: true });
const storage = join(tmp, "storage");
mkdirSync(storage, { recursive: true });

process.env.NODE_ENV = "test";
process.env.DB_DRIVER = "sqlite";
process.env.DB_PATH = join(tmp, "test.db");
process.env.STORAGE_ROOT = storage;
process.env.DRY_RUN = "true";
process.env.JWT_SECRET = "identity-test-secret";

const { initDb, getDb, queries } = await import("../src/db.js");
const { config } = await import("../src/config.js");
const authSrv = await import("../src/services/auth.js");
const { default: sessionRouter } = await import("../src/routes/session.js");

const { verifyToken } = authSrv;
const COOKIE = config.auth.cookieName;
const OLD_EMAIL = "selvester69@gmail.com";   // the wrong/old identity from the report
const NEW_EMAIL = "mindwiring1209@gmail.com"; // the identity it should be

let app, server, base;
before(async () => {
  await initDb();
  app = express();
  app.use(express.json());
  app.use("/api/auth", sessionRouter);
  app.use((req, res) => res.status(404).json({ error: "not found" }));
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
});

async function request(path, { method = "GET", json, cookie } = {}) {
  const headers = {};
  if (json !== undefined) headers["Content-Type"] = "application/json";
  if (cookie) headers["Cookie"] = cookie;
  const res = await fetch(`${base}${path}`, {
    method, headers,
    body: json !== undefined ? JSON.stringify(json) : undefined,
    redirect: "manual",
  });
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const text = await res.text();
  return { status: res.status, setCookies, text, header: (n) => res.headers.get(n) };
}
function cookieValue(setCookies, name) {
  for (const c of setCookies) if (c.startsWith(name + "=")) return c.split(";")[0].slice(name.length + 1);
  throw new Error(`cookie ${name} not set`);
}
function authCookie(setCookies) {
  return `${COOKIE}=${cookieValue(setCookies, COOKIE)}`;
}
function decodeToken(jar) {
  const token = cookieValue([jar], COOKIE); // jar is "JWT=<value>"
  return verifyToken(token);
}

describe("user identity resolution", () => {
  beforeEach(async () => {
    // wipe users (except re-seed none) for full isolation between tests
    const db = getDb();
    await db.prepare("DELETE FROM users").run();
  });

  test("register + login as the reported (wrong) email works, proving it is just a credential", async () => {
    const r = await request("/api/auth/register", {
      method: "POST",
      json: { name: "Wrong", email: OLD_EMAIL, password: "s3cret" },
    });
    assert.equal(r.status, 201);
    assert.match(r.text, /selvester69\u0040gmail\.com/);
    const jar = authCookie(r.setCookies);

    const p = await request("/api/auth/profile", { cookie: jar });
    assert.equal(p.status, 200);
    assert.match(p.text, /selvester69\u0040gmail\.com/);
  });

  test("login with a never-registered email -> 401 (no phantom selvester69 session)", async () => {
    const r = await request("/api/auth/login", {
      method: "POST",
      json: { email: "does-not-exist@example.com", password: "s3cret" },
    });
    assert.equal(r.status, 401);
  });

  test("renaming selvester69 -> mindwiring1209 makes the old email stop working", async () => {
    // start from the wrong/old identity
    await request("/api/auth/register", {
      method: "POST",
      json: { name: "Old", email: OLD_EMAIL, password: "s3cret" },
    });

    // confirm the old one currently works
    const oldLogin = await request("/api/auth/login", {
      method: "POST",
      json: { email: OLD_EMAIL, password: "s3cret" },
    });
    assert.equal(oldLogin.status, 200);

    // rename it to the identity it should be
    const rename = await request("/api/auth/profile", {
      method: "PATCH",
      cookie: authCookie(oldLogin.setCookies),
      json: { email: NEW_EMAIL, name: "Right" },
    });
    assert.equal(rename.status, 200);
    assert.match(rename.text, /mindwiring1209\u0040gmail\.com/);

    // the OLD email is no longer a valid identity
    const stale = await request("/api/auth/login", {
      method: "POST",
      json: { email: OLD_EMAIL, password: "s3cret" },
    });
    assert.equal(stale.status, 401, "stale selvester69 email must not authenticate");

    // the NEW email IS the identity in use
    const login = await request("/api/auth/login", {
      method: "POST",
      json: { email: NEW_EMAIL, password: "s3cret" },
    });
    assert.equal(login.status, 200);
    assert.match(login.text, /mindwiring1209\u0040gmail\.com/);

    // profile carries the right identity
    const jar = authCookie(login.setCookies);
    const p = await request("/api/auth/profile", { cookie: jar });
    assert.equal(p.status, 200);
    assert.match(p.text, /mindwiring1209\u0040gmail\.com/);
    assert.equal(p.text.includes("selvester69"), false, "profile must not expose the stale selvester69 identity");

    // the decoded auth token carries the right identity
    const tok = decodeToken(jar);
    assert.ok(tok, "auth token must decode");
    assert.equal(tok.email, NEW_EMAIL);

    // no row in the DB still uses the old identity
    const gone = await queries.findUserByEmail.get({ email: OLD_EMAIL });
    assert.equal(gone, undefined, "no users row should remain for selvester69");
  });
});

after(async () => {
  try { server?.close?.(); } catch {}
  try { await getDb()?.close?.(); } catch {}
  try { await rm(tmp, { recursive: true, force: true }); } catch {}
});
