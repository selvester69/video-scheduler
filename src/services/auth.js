/**
 * App-level auth: email/password + Google SSO sessions as an httpOnly JWT cookie.
 * bcryptjs + jsonwebtoken are pure-JS (no native build), so they're safe in
 * the linux/arm64 Docker image — unlike the native better-sqlite3 module.
 */
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { google } from "googleapis";
import { config } from "../config.js";
import { queries, nowSec } from "../db.js";

export const COOKIE = config.auth.cookieName;
const SECRET = config.auth.jwtSecret;

export function hashPassword(password) {
  return bcrypt.hash(password, 10);
}
export function comparePassword(password, hash) {
  return bcrypt.compare(password, hash);
}

export function signToken(user) {
  return jwt.sign({ sub: user.id, name: user.name, email: user.email }, SECRET, {
    expiresIn: config.auth.jwtExpires,
  });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, SECRET);
  } catch {
    return null;
  }
}

export function parseCookies(req) {
  const out = {};
  for (const c of (req.headers.cookie || "").split(";")) {
    const [k, ...v] = c.trim().split("=");
    if (k) out[k] = decodeURIComponent(v.join("="));
  }
  return out;
}

// Read the auth cookie and return the decoded token payload, or null.
export function currentUser(req) {
  return verifyToken(parseCookies(req)[COOKIE]);
}

export function issueAuthCookie(res, token) {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${config.auth.cookieMaxAge};` +
      (config.auth.cookieSecure ? " Secure;" : "")
  );
}

export function clearAuthCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0;` +
      (config.auth.cookieSecure ? " Secure;" : "")
  );
}

/**
 * Google SSO (app login).
 *
 * `getSsoAuthUrl()` is called by `GET /api/auth/google` to redirect the browser
 * to Google's consent screen with the lightweight `openid email profile` scope
 * set. `handleGoogleCallback(code)` is called by `GET /api/auth/google/callback`
 * (registered as an authorized redirect URI in Google Cloud) to exchange the
 * code, verify the returned id_token, and upsert a `users` row.
 */
function oauthClient() {
  return new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.ssoCallbackUrl
  );
}

export function getSsoAuthUrl() {
  const client = oauthClient();
  // `state` prevents CSRF against the app-login OAuth flow: it is stored in an
  // httpOnly cookie by the route and verified again in the callback.
  const state = crypto.randomUUID();
  const url = client.generateAuthUrl({
    scope: config.google.ssoScopes,
    access_type: "online",
    state,
  });
  return { url, state };
}

export async function handleGoogleCallback(code) {
  const oauth = oauthClient();
  const { tokens } = await oauth.getToken(code);
  const idToken = tokens.id_token;
  if (!idToken) throw new Error("no id_token returned from Google");

  // Verify signature, expiry, and audience (must match our client ID).
  const ticket = await oauth.verifyIdToken({
    idToken,
    audience: config.google.clientId,
  });
  const payload = ticket.getPayload();
  if (!payload || !payload.email) throw new Error("invalid Google id_token");
  if (payload.email_verified === false) throw new Error("Google email not verified");

  const email = (payload.email || "").toLowerCase();
  const now = nowSec();
  let user = await queries.findUserByGoogleSub.get({ googleSub: payload.sub });
  if (!user) user = await queries.findUserByEmail.get({ email });

  if (!user) {
    // First Google login for this identity — create a new account. No password
    // is ever set (this hash is an uncrackable placeholder so a Google-only
    // account can't be logged into via email/password), which also keeps
    // existing NOT NULL columns happy without a destructive migration.
    const placeholder = await hashPassword(crypto.randomUUID() + Date.now().toString(36));
    user = await queries.insertUser.get({
      id: crypto.randomUUID(),
      email,
      name: payload.name || email.split("@")[0],
      passwordHash: placeholder,
      avatar: payload.picture || null,
      created: now,
      updated: now,
    });
  } else if (!user.google_sub) {
    // Existing email/password account — link this Google identity to it.
    user = await queries.linkGoogle.get({
      email,
      name: payload.name || user.name,
      avatar: payload.picture || null,
      googleSub: payload.sub,
      updatedAt: now,
      id: user.id,
    });
  }
  return safeUser(user);
}

// Seed a default admin into an empty users table (first run), so the operator
// can log in immediately. Credentials come from env (see config.auth.seed*).
export async function seedDefaultUser() {
  if (!config.auth.require) return;
  const count = await queries.userCount.get();
  if (Number(count?.n) > 0) return;
  const id = crypto.randomUUID();
  const passwordHash = await hashPassword(config.auth.seedPassword);
  await queries.insertUser.run({
    id,
    email: config.auth.seedEmail.toLowerCase(),
    name: "Admin",
    passwordHash,
    avatar: null,
    created: nowSec(),
    updated: nowSec(),
  });
  console.warn(
    `[auth] seeded default admin  email=${config.auth.seedEmail}  password=${config.auth.seedPassword}` +
      `  (change with LOGIN_EMAIL / LOGIN_PASSWORD — do NOT ship this default)`
  );
}

// Strip secrets before sending a user object to the client.
export function safeUser(u) {
  if (!u) return null;
  return { id: u.id, email: u.email, name: u.name, avatar: u.avatar, created_at: u.created_at };
}
