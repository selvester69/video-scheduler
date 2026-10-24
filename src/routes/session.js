import { Router } from "express";
import { db, queries, nowSec } from "../db.js";
import {
  hashPassword,
  comparePassword,
  signToken,
  issueAuthCookie,
  clearAuthCookie,
  currentUser,
  safeUser,
  parseCookies,
  getSsoAuthUrl,
  handleGoogleCallback,
} from "../services/auth.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

const SSO_STATE_COOKIE = "sso_state";
const STATE_MAX_AGE = 5 * 60 * 1_000; // 5 minutes

/**
 * POST /api/auth/register  { name?, email, password }  → auto-login
 */
router.post("/register", async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "email and password are required" });
  if (password.length < 6) return res.status(400).json({ error: "password must be at least 6 characters" });

  const existing = await queries.findUserByEmail.get({ email: email.toLowerCase() });
  if (existing) return res.status(409).json({ error: "email already registered" });

  const id = crypto.randomUUID();
  const passwordHash = await hashPassword(password);
  const user = await queries.insertUser.get({
    id,
    email: email.toLowerCase(),
    name: name || email.split("@")[0],
    passwordHash,
    avatar: null,
    created: nowSec(),
    updated: nowSec(),
  });
  issueAuthCookie(res, signToken(user));
  res.status(201).json(safeUser(user));
});

/**
 * POST /api/auth/login  { email, password }  → sets auth cookie
 */
router.post("/login", async (req, res) => {
  const { email, password } = req.body || {};
  const user = await queries.findUserByEmail.get({ email: (email || "").toLowerCase() });
  const ok = user && (await comparePassword(password, user.password_hash));
  if (!ok) return res.status(401).json({ error: "invalid credentials" });

  issueAuthCookie(res, signToken(user));
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM channels`).get();
  res.json({ ...safeUser(user), channels: Number(row?.n) || 0 });
});

/**
 * POST /api/auth/logout  → clears auth cookie
 */
router.post("/logout", (_req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

/**
 * Google SSO app login.
 *   GET /api/auth/google          → redirect to Google consent (with CSRF state)
 *   GET /api/auth/google/callback → Google redirects here with ?code=&state=
 */
router.get("/google", (_req, res) => {
  const { url, state } = getSsoAuthUrl();
  res.cookie(SSO_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: false, // localhost over HTTP
    path: "/",
    maxAge: STATE_MAX_AGE,
  });
  res.redirect(url);
});

router.get("/google/callback", async (req, res) => {
  const code = req.query.code;
  const state = req.query.state;
  const cookieState = parseCookies(req)[SSO_STATE_COOKIE];

  const clearSsoState = () =>
    res.clearCookie(SSO_STATE_COOKIE, { httpOnly: true, sameSite: "lax", secure: false, path: "/" });

  // CSRF guard: a missing/mismatched `state` means the request didn't come back
  // from the Google flow we started (or was replayed). Reject and redirect.
  if (!code || !state || !cookieState || state !== cookieState) {
    clearSsoState();
    return res.redirect("/login?error=state");
  }

  // State is single-use: consume it before the token exchange.
  clearSsoState();

  try {
    const user = await handleGoogleCallback(code);
    issueAuthCookie(res, signToken(user));
    res.redirect("/");
  } catch (e) {
    console.error("Google SSO callback error:", e);
    res.redirect("/login?error=google");
  }
});

/**
 * GET /api/auth/profile  → current user (401 if not authed)
 */
router.get("/profile", requireAuth, async (req, res) => {
  const user = await queries.findUserById.get({ id: req.user.sub });
  res.json(safeUser(user));
});

/**
 * PATCH /api/auth/profile  { name?, avatar? }  → update profile
 */
router.patch("/profile", requireAuth, async (req, res) => {
  const { name, avatar } = req.body || {};
  let email;
  if (req.body?.email !== undefined) {
    email = String(req.body.email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "a valid email address is required" });
    }
    const existing = await queries.findUserByEmail.get({ email });
    if (existing && existing.id !== req.user.sub) {
      return res.status(409).json({ error: "email is already in use" });
    }
  }
  const updated = await queries.updateUser.get({
    name,
    email: email || null,
    avatar: avatar || null,
    updatedAt: nowSec(),
    id: req.user.sub,
  });
  if (!updated) return res.status(404).json({ error: "user not found" });
  issueAuthCookie(res, signToken(updated)); // re-issue with fresh name
  res.json(safeUser(updated));
});

export default router;
