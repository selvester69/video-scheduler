import { Router } from "express";
import { getAuthUrl, handleCallback } from "../services/youtube-auth.js";
import { db } from "../db.js";

const router = Router();

/**
 * GET /api/auth/connect
 *   Redirects the browser to Google's consent screen. After you grant access,
 *   Google calls /auth/callback with an authorization code.
 */
router.get("/connect", (req, res) => {
  res.redirect(getAuthUrl());
});

/**
 * GET /auth/callback  (configured as the OAuth redirect URI)
 *   Public GET endpoint (not under /api) because Google requires the exact URI
 *   you registered. Exchanges the code, resolves the channel, persists it, and
 *   returns the user to the home page.
 */
router.get("/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send("Missing authorization code");
  try {
    await handleCallback(code);
    res.redirect("/");
  } catch (e) {
    console.error("OAuth callback error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * GET /api/auth/channels  — list connected channels
 */
router.get("/channels", async (_req, res) => {
  const rows = await db.prepare(`SELECT id, name, quota_used, quota_reset_at, active, last_used_at FROM channels ORDER BY name`).all();
  res.json(rows);
});

/**
 * POST /api/auth/channels/:id/deactivate
 */
router.post("/channels/:id/deactivate", async (req, res) => {
  const { id } = req.params;
  const info = await db.prepare(`UPDATE channels SET active = 0 WHERE id = @id`).run({ id });
  res.json({ ok: info.changes > 0, deactivated: id });
});

export default router;
