import { Router } from "express";
import { config } from "../config.js";
import { db, queries, nowSec } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { connectInstagramAccount, getInstagramAuthUrl } from "../services/instagram.js";

const router = Router();
const STATE_COOKIE = "instagram_oauth_state";
const STATE_MAX_AGE = 5 * 60 * 1000;

function readCookie(req, name) {
  const entry = (req.headers.cookie || "").split(";").map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : null;
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: new URL(config.instagram.callbackUrl).protocol === "https:",
    path: "/",
    maxAge: STATE_MAX_AGE,
  };
}

router.get("/connect", requireAuth, (req, res) => {
  try {
    const state = crypto.randomUUID();
    res.cookie(STATE_COOKIE, state, cookieOptions());
    res.redirect(getInstagramAuthUrl(state));
  } catch (error) {
    res.status(503).json({ error: error.message });
  }
});

router.get("/callback", async (req, res) => {
  const state = req.query.state;
  const cookieState = readCookie(req, STATE_COOKIE);
  res.clearCookie(STATE_COOKIE, cookieOptions());
  if (!state || !cookieState || state !== cookieState) {
    return res.redirect("/?instagram_error=invalid_state#channels");
  }
  if (req.query.error) {
    return res.redirect("/?instagram_error=authorization_denied#channels");
  }
  if (!req.query.code) return res.redirect("/?instagram_error=missing_authorization_code#channels");

  try {
    await connectInstagramAccount(String(req.query.code));
    res.redirect("/?instagram_connected=1#channels");
  } catch (error) {
    console.error("Instagram OAuth callback error:", error.message);
    res.redirect(`/?instagram_error=${encodeURIComponent(error.message)}#channels`);
  }
});

router.get("/accounts", requireAuth, async (_req, res) => {
  res.json(await queries.listInstagramAccounts.all());
});

router.get("/status", requireAuth, async (_req, res) => {
  let publicUrlHttps = false;
  try {
    publicUrlHttps = new URL(config.instagram.publicAppUrl).protocol === "https:";
  } catch {
    publicUrlHttps = false;
  }
  res.json({
    configured: Boolean(config.instagram.appId && config.instagram.appSecret),
    publicUrlHttps,
    accounts: await queries.listInstagramAccounts.all(),
  });
});

router.post("/accounts/:id/disconnect", requireAuth, async (req, res) => {
  const result = await queries.deactivateInstagramAccount.run({
    id: req.params.id,
    updatedAt: nowSec(),
  });
  if (!result.changes) return res.status(404).json({ error: "Instagram account not found" });
  res.json({ id: req.params.id, active: false });
});

export default router;
