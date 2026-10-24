import { currentUser } from "../services/auth.js";

/**
 * requireAuth — gate routes behind a valid auth cookie.
 * On miss, returns 401 JSON so the SPA can redirect to /login.
 */
export function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: "authentication required" });
  req.user = user;
  next();
}
