/**
 * Auth + OAuth "state" (CSRF) tests.
 *
 * Spins up a fresh temp SQLite DB, boots the REAL Express routers (the same
 * ones the running app mounts), and asserts:
 *   - the OAuth connect / SSO redirect emits a `state` token in BOTH the
 *     redirect URL and an httpOnly cookie, and the two match;
 *   - the callback REJECTS missing / mismatched `state` (the CSRF guard)
 *     without contacting Google (fully offline, no network);
 *   - bcrypt hash/compare, JWT sign/verify, and safeUser work;
 *   - email/password register -> login -> profile(401/200) -> logout works
 *     end-to-end against the test DB.
 *
 * Uses only Node's built-in test runner + Node 24's global fetch. Same SQLite
 * query surface as the scheduler tests (better-sqlite3, no native pg).
 */
import { mkdirSync } from "fs";
import { rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import express from "express";

const tmp = join(tmpdir(), `yt-sched-auth-test-${process.pid}`);
mkdirSync(tmp, { recursive: true });
const storage = join(tmp, "storage");
mkdirSync(storage, { recursive: true });

// Env MUST be set before importing any app module: config.js reads process.env
// once, at import time.
process.env.NODE_ENV = "test";
process.env.DB_DRIVER = "sqlite";
process.env.DB_PATH = join(tmp, "test.db");
process.env.STORAGE_ROOT = storage;
process.env.DRY_RUN = "true";
process.env.JWT_SECRET = "test-secret";

const { initDb, getDb, queries, nowSec } = await import("../src/db.js");
const { config } = await import("../src/config.js");
const authSrv = await import("../src/services/auth.js");
const { getAuthUrl } = await import("../src/services/youtube-auth.js");
const { default: sessionRouter } = await import("../src/routes/session.js");
const { default: authRouter } = await import("../src/routes/auth.js");

const { hashPassword, comparePassword, signToken, verifyToken, safeUser, getSsoAuthUrl } = authSrv;
const COOKIE = config.auth.cookieName;

// Express mirrors the production mounts:
//   /api/auth -> sessionRouter (register/login/logout/profile/google) + authRouter (connect/channels)
//   /auth     -> authRouter (channel OAuth callback URI registered in Google Cloud)
let app, server, base;
before(async () => {
  await initDb();
  app = express();
  app.use(express.json());
  app.use("/api/auth", sessionRouter);
  app.use("/api/auth", authRouter);
  app.use("/auth", authRouter);
  app.use((req, res) => res.status(404).json({ error: "not found" }));
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  try { server?.close?.(); } catch {}
  try { await getDb()?.close?.(); } catch {}
  try { await rm(tmp, { recursive: true, force: true }); } catch {}
});

// ---- tiny fetch + cookie helpers (Node 24 global fetch) ----
async function request(path, { method = "GET", json, cookie } = {}) {
  const headers = {};
  if (json !== undefined) headers["Content-Type"] = "application/json";
  if (cookie) headers["Cookie"] = cookie;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
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
// Express clearCookie deletes via an expired Epoch Expires (not always Max-Age=0).
function expectCleared(setCookies, name) {
  const c = setCookies.find((c) => c.startsWith(name + "="));
  assert.ok(c, `${name} cleared cookie should be present`);
  const body = c.slice(name.length);
  assert.match(body, /^=;?/, `${name} cookie value must be empty`);
  assert.match(body, /Max-Age=0|Expires=.*1970/i, `${name} cookie must carry a past expiry`);
}

const UUID = /[a-f0-9-]{36}/;

describe("OAuth CSRF state — channel connect", () => {
  test("GET /api/auth/connect emits state in URL + httpOnly cookie (and they match)", async () => {
    const r = await request("/api/auth/connect");
    assert.equal(r.status, 302);
    const loc = r.header("location");
    const m = loc.match(/[?&]state=([a-f0-9-]+)/);
    assert.ok(m, "Google URL must carry a state parameter");
    const urlState = m[1];
    const c = r.setCookies.find((c) => c.startsWith("oauth_state="));
    assert.ok(c, "oauth_state cookie must be set");
    assert.match(c, /HttpOnly/);
    assert.match(c, /SameSite=Lax/);
    const cookieState = c.split(";")[0].slice("oauth_state=".length);
    assert.equal(urlState, cookieState, "state in URL and cookie must match");
  });

  test("callback rejects missing state -> 400 (no Google call)", async () => {
    const r = await request("/auth/callback?code=x"); // no state query, no cookie
    assert.equal(r.status, 400);
    assert.match(r.text, /Invalid or expired OAuth state/);
  });

  test("callback rejects mismatched state -> 400 + cookie cleared", async () => {
    const r = await request("/auth/callback?code=x&state=bad", { cookie: "oauth_state=good-cookie" });
    assert.equal(r.status, 400);
    expectCleared(r.setCookies, "oauth_state");
  });
});

describe("OAuth CSRF state — Google SSO login", () => {
  test("GET /api/auth/google emits state in URL + httpOnly cookie (and they match)", async () => {
    const r = await request("/api/auth/google");
    assert.equal(r.status, 302);
    const loc = r.header("location");
    const m = loc.match(/[?&]state=([a-f0-9-]+)/);
    assert.ok(m, "Google URL must carry a state parameter");
    const c = r.setCookies.find((c) => c.startsWith("sso_state="));
    assert.ok(c, "sso_state cookie must be set");
    assert.match(c, /HttpOnly/);
    assert.match(c, /SameSite=Lax/);
    const urlState = m[1];
    const cookieState = c.split(";")[0].slice("sso_state=".length);
    assert.equal(urlState, cookieState, "state in URL and cookie must match");
  });

  test("callback rejects missing state -> redirect /login?error=state", async () => {
    const r = await request("/api/auth/google/callback?code=x");
    assert.equal(r.status, 302);
    assert.match(r.header("location"), /\/login\?error=state/);
  });

  test("callback rejects mismatched state -> redirect /login?error=state", async () => {
    const r = await request("/api/auth/google/callback?code=x&state=bad", { cookie: "sso_state=good-cookie" });
    assert.equal(r.status, 302);
    assert.match(r.header("location"), /\/login\?error=state/);
  });

  test("state token is a 36-char UUID-style value", async () => {
    const { state } = getSsoAuthUrl();
    assert.match(state, UUID);
    assert.equal(typeof getAuthUrl().url, "string");
    assert.match(getAuthUrl().state, UUID);
  });
});

describe("auth service primitives", () => {
  test("bcrypt hash/compare", async () => {
    const h = await hashPassword("s3cret");
    assert.notEqual(h, "s3cret");
    assert.equal(await comparePassword("s3cret", h), true);
    assert.equal(await comparePassword("nope", h), false);
  });

  test("JWT sign/verify roundtrip", () => {
    const token = signToken({ id: "u1", name: "Tester", email: "t@example.com" });
    const p = verifyToken(token);
    assert.ok(p);
    assert.equal(p.sub, "u1");
    assert.equal(p.email, "t@example.com");
    assert.equal(verifyToken("garbage"), null);
  });

  test("safeUser strips password_hash", () => {
    const safe = safeUser({ id: "u", email: "t@e.com", name: "t", password_hash: "secret", avatar: null, created_at: 1 });
    assert.equal(safe.id, "u");
    assert.equal(safe.email, "t@e.com");
    assert.equal(safe.password_hash, undefined);
    assert.equal(safe.passwordHash, undefined);
  });
});

describe("auth HTTP flow", () => {
  before(async () => {
    // Seed one known user directly so login tests are independent of order.
    const h = await hashPassword("s3cret");
    await queries.insertUser.run({
      id: crypto.randomUUID(),
      email: "tester@example.com",
      name: "Tester",
      passwordHash: h,
      avatar: null,
      created: nowSec(),
      updated: nowSec(),
    });
  });

  test("register a new user -> 201 + auth cookie, no password in body", async () => {
    const r = await request("/api/auth/register", {
      method: "POST",
      json: { name: "New", email: "new@example.com", password: "s3cret" },
    });
    assert.equal(r.status, 201);
    assert.ok(authCookie(r.setCookies), "auth cookie set on register");
    assert.equal(r.text.includes("password"), false, "response must not leak password fields");
    assert.match(r.text, /new@example\.com/);
  });

  test("login wrong password -> 401", async () => {
    const r = await request("/api/auth/login", {
      method: "POST",
      json: { email: "tester@example.com", password: "wrong" },
    });
    assert.equal(r.status, 401);
  });

  test("login correct -> 200 + auth cookie", async () => {
    const r = await request("/api/auth/login", {
      method: "POST",
      json: { email: "tester@example.com", password: "s3cret" },
    });
    assert.equal(r.status, 200);
    assert.ok(authCookie(r.setCookies));
  });

  test("profile without cookie -> 401", async () => {
    const r = await request("/api/auth/profile");
    assert.equal(r.status, 401);
  });

  test("profile with cookie -> 200 + email", async () => {
    const { setCookies } = await request("/api/auth/login", {
      method: "POST",
      json: { email: "tester@example.com", password: "s3cret" },
    });
    const jar = authCookie(setCookies);
    const r = await request("/api/auth/profile", { cookie: jar });
    assert.equal(r.status, 200);
    assert.match(r.text, /tester@example\.com/);
  });

  test("profile email can be changed and used for the next sign-in", async () => {
    const { setCookies } = await request("/api/auth/login", {
      method: "POST",
      json: { email: "tester@example.com", password: "s3cret" },
    });
    const jar = authCookie(setCookies);
    const updated = await request("/api/auth/profile", {
      method: "PATCH",
      cookie: jar,
      json: { email: "Mindwiring1209@gmail.com" },
    });
    assert.equal(updated.status, 200);
    assert.match(updated.text, /mindwiring1209@gmail\.com/);

    const login = await request("/api/auth/login", {
      method: "POST",
      json: { email: "mindwiring1209@gmail.com", password: "s3cret" },
    });
    assert.equal(login.status, 200);
    assert.match(login.text, /mindwiring1209@gmail\.com/);
  });

  test("profile email rejects invalid and already-used addresses", async () => {
    const { setCookies } = await request("/api/auth/login", {
      method: "POST",
      json: { email: "mindwiring1209@gmail.com", password: "s3cret" },
    });
    const jar = authCookie(setCookies);
    const invalid = await request("/api/auth/profile", {
      method: "PATCH",
      cookie: jar,
      json: { email: "not-an-email" },
    });
    assert.equal(invalid.status, 400);

    const duplicate = await request("/api/auth/profile", {
      method: "PATCH",
      cookie: jar,
      json: { email: "new@example.com" },
    });
    assert.equal(duplicate.status, 409);
  });

  test("logout -> 200 ok:true + auth cookie cleared", async () => {
    const { setCookies } = await request("/api/auth/login", {
      method: "POST",
      json: { email: "mindwiring1209@gmail.com", password: "s3cret" },
    });
    const jar = authCookie(setCookies);
    const r = await request("/api/auth/logout", { method: "POST", cookie: jar });
    assert.equal(r.status, 200);
    assert.match(r.text, /"ok":\s*true/);
    expectCleared(r.setCookies, COOKIE);
  });
});
