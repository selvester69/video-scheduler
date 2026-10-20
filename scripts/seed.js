/**
 * `npm run seed` — create a demo channel from env GOOGLE_CLIENT_ID/SECRET.
 * Useful for DRY_RUN=true local testing (a placeholder refresh_token gives the
 * worker a channel to schedule against). For real uploads, use /api/auth/connect.
 */
import { config } from "../src/config.js";
import { initDb, db, nowSec } from "../src/db.js";

const name = process.argv[3] || "Demo Channel";
const id = process.argv[2] || `uc-${crypto.randomUUID().slice(0, 8)}`;
const now = nowSec();

await initDb();
const info = await db.prepare(
  `INSERT INTO channels (id, name, google_client_id, google_client_secret,
     refresh_token, quota_reset_at, active)
   VALUES (@id, @name, @cid, @csec, @rt, @reset, 1)
   ON CONFLICT(id) DO UPDATE SET
     name = excluded.name,
     google_client_id = excluded.google_client_id,
     google_client_secret = excluded.google_client_secret
   RETURNING id, name, quota_used, active`
).get({
  id,
  name,
  cid: config.google.clientId,
  csec: config.google.clientSecret,
  rt: "refresh-token-placeholder",
  reset: now + 86400,
});

console.log("seeded channel:", JSON.stringify(info, null, 2));
console.log("NOTE: dry-run placeholder. Run a real OAuth flow at /api/auth/connect for production.");
await db.close?.();
