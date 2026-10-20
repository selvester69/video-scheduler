/**
 * `npm run db:reset` — wipe & recreate tables (keeps connected channels if
 * RESET_KEEP_CHANNELS=1). Works for both SQLite and PostgreSQL.
 */
import { config } from "../src/config.js";
import { initDb, db } from "../src/db.js";

const keep = process.env.RESET_KEEP_CHANNELS === "1";
await initDb();

if (keep) {
  const channels = await db.prepare(
    `SELECT id, name, google_client_id, google_client_secret, refresh_token, quota_reset_at
     FROM channels`
  ).all();
  await db.exec("DELETE FROM uploads; DELETE FROM jobs;");
  for (const c of channels) {
    await db.prepare(
      `INSERT INTO channels (id, name, google_client_id, google_client_secret, refresh_token, quota_reset_at)
       VALUES (@id, @name, @google_client_id, @google_client_secret, @refresh_token, @quota_reset_at)
       ON CONFLICT(id) DO NOTHING`
    ).run(c);
  }
  console.log(`database reset at ${config.dbPath} (kept ${channels.length} channels)`);
} else {
  await db.exec("DELETE FROM uploads; DELETE FROM jobs; DELETE FROM channels;");
  console.log(`database reset at ${config.dbPath} (all data wiped)`);
}

await db.close?.();
