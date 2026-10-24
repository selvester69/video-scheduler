import { Router } from "express";
import { config } from "../config.js";
import { queries, nowSec } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { connectFacebookPages, getFacebookAuthUrl } from "../services/facebook.js";

const router = Router();
const STATE_COOKIE = "facebook_oauth_state";
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
    secure: new URL(config.facebook.callbackUrl).protocol === "https:",
    path: "/",
    maxAge: STATE_MAX_AGE,
  };
}

router.get("/connect", requireAuth, (req, res) => {
  try {
    const state = crypto.randomUUID();
    res.cookie(STATE_COOKIE, state, cookieOptions());
    res.redirect(getFacebookAuthUrl(state));
  } catch (error) {
    res.status(503).json({ error: error.message });
  }
});

router.get("/callback", async (req, res) => {
  const state = req.query.state;
  const cookieState = readCookie(req, STATE_COOKIE);
  res.clearCookie(STATE_COOKIE, cookieOptions());
  if (!state || !cookieState || state !== cookieState) {
    return res.redirect("/?facebook_error=invalid_state#channels");
  }
  if (req.query.error) return res.redirect("/?facebook_error=authorization_denied#channels");
  if (!req.query.code) return res.redirect("/?facebook_error=missing_authorization_code#channels");

  try {
    await connectFacebookPages(String(req.query.code));
    res.redirect("/?facebook_connected=1#channels");
  } catch (error) {
    console.error("Facebook OAuth callback error:", error.message);
    res.redirect(`/?facebook_error=${encodeURIComponent(error.message)}#channels`);
  }
});

router.get("/status", requireAuth, async (_req, res) => {
  let publicUrlHttps = false;
  try {
    publicUrlHttps = new URL(config.facebook.publicAppUrl).protocol === "https:";
  } catch {
    publicUrlHttps = false;
  }
  res.json({
    configured: Boolean(config.facebook.appId && config.facebook.appSecret),
    publicUrlHttps,
    pages: await queries.listFacebookPages.all(),
  });
});

router.get("/pages", requireAuth, async (_req, res) => {
  res.json(await queries.listFacebookPages.all());
});

router.post("/pages/:id/disconnect", requireAuth, async (req, res) => {
  const result = await queries.deactivateFacebookPage.run({
    id: req.params.id,
    updatedAt: nowSec(),
  });
  if (!result.changes) return res.status(404).json({ error: "Facebook Page not found" });
  res.json({ id: req.params.id, active: false });
});

export default router;
