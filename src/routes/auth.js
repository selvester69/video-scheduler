import { Router } from "express";
import { getAuthUrl, handleCallback } from "../services/youtube-auth.js";
import { db } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

// The app doesn't mount cookie-parser, so read the one cookie we own manually.
function readCookie(req, name) {
  const m = (req.headers.cookie || "").match(
    new RegExp("(?:^|; )" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "=([^;]*)")
  );
  return m ? decodeURIComponent(m[1]) : undefined;
}

// OAuth callbacks are followed by a browser; return real HTML, not raw JSON.
const entityMap = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => entityMap[c]);
}
function errorPage(msg) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Channel connect error</title></head>
<body style="font-family:sans-serif;padding:2rem;max-width:40rem">
<h1>Channel connect error</h1><p>${escapeHtml(msg)}</p>
<p><a href="/">← Back to the app</a></p></body></html>`;
}

const OAUTH_STATE_COOKIE = "oauth_state";
const STATE_MAX_AGE = 5 * 60 * 1000; // 5 minutes

/**
 * GET /api/auth/connect
 *   Generates a fresh OAuth `state` token (anti-CSRF), stores it in an httpOnly
 *   cookie, then redirects the browser to Google's consent screen. Google
 *   returns the same `state` value in the callback; we verify it server-side.
 */
router.get("/connect", (_req, res) => {
  const { url, state } = getAuthUrl();
  res.cookie(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: false, // localhost over HTTP
    path: "/",
    maxAge: STATE_MAX_AGE,
  });
  res.redirect(url);
});

/**
 * GET /auth/callback  (configured as the OAuth redirect URI)
 *   Public GET endpoint (not under /api) because Google requires the exact URI
 *   you registered. We verify the `state` matches the cookie (CSRF guard),
 *   exchange the code, resolve the channel, persist it, and return the user to
 *   the home page.
 */
router.get("/callback", async (req, res) => {
  const code = req.query.code;
  const state = req.query.state;
  const cookieState = readCookie(req, OAUTH_STATE_COOKIE);

  const clearState = () =>
    res.clearCookie(OAUTH_STATE_COOKIE, {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      path: "/",
    });

  // Reject anything without a valid, matching state: missing code, missing
  // state, no cookie, or a tampered/mismatched state.
  if (!code || !state || !cookieState || state !== cookieState) {
    clearState();
    return res
      .status(400)
      .send(errorPage("Invalid or expired OAuth state. Please try connecting again."));
  }

  // State is single-use: drop it before we do the (slower) token exchange.
  clearState();

  try {
    await handleCallback(code);
    res.redirect("/");
  } catch (e) {
    console.error("OAuth callback error:", e);
    res.status(500).send(errorPage(e.message));
  }
});

/**
 * GET /api/auth/channels  — list connected channels
 */
router.get("/channels", requireAuth, async (_req, res) => {
  const rows = await db
    .prepare(`SELECT id, name, quota_used, quota_reset_at, active, last_used_at FROM channels ORDER BY name`)
    .all();
  res.json(rows);
});

/**
 * POST /api/auth/channels/:id/deactivate
 */
router.post("/channels/:id/deactivate", requireAuth, async (req, res) => {
  const { id } = req.params;
  const info = await db.prepare(`UPDATE channels SET active = 0 WHERE id = @id`).run({ id });
  res.json({ ok: info.changes > 0, deactivated: id });
});

export default router;
