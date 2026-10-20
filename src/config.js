/** Centralized, env-driven config. Loaded once at startup. */
import { config as dotenvConfig } from "dotenv";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const result = dotenvConfig();
if (result.error && process.env.NODE_ENV !== "production") {
  // In production env vars are injected; in dev we warn but don't crash.
  if (process.env.NODE_ENV !== "test") {
    console.warn("No .env file loaded (using environment variables directly).");
  }
}

// Optional credentials file (e.g. for local/OAuth flows). Env vars always win.
// In Docker the file is mounted as a Docker `secret` at /run/secrets/google_creds;
// locally it lives at the project root as secrets.json.
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const secretCandidates = [
  process.env.SECRETS_FILE,
  "/run/secrets/google_creds",
  resolve(projectRoot, "secrets.json"),
];
let secrets = {};
for (const p of secretCandidates) {
  if (p && existsSync(p)) { try { secrets = JSON.parse(readFileSync(p, "utf8")); break; } catch { /* ignore parse errors */ } }
}

const parseBool = (v, dflt = false) => {
  if (v === undefined || v === "") return dflt;
  return ["1", "true", "yes"].includes(String(v).toLowerCase());
};

export const config = {
  port: parseInt(process.env.PORT || "3000", 10),
  nodeEnv: process.env.NODE_ENV || "development",
  dbDriver: process.env.DB_DRIVER || "sqlite",   // sqlite | pg
  databaseUrl: process.env.DATABASE_URL || "",   // required when DB_DRIVER=pg
  dbPath: process.env.DB_PATH || "./data/scheduler.db",
  storageRoot: process.env.STORAGE_ROOT || "./storage",
  dryRun: parseBool(process.env.DRY_RUN, false),

  google: {
    // Supports both the Google "web" shape ({web:{client_id,client_secret}})
    // and a flat secrets.json ({google:{client_id,client_secret}}).
    // Environment variables (incl. .env) always take precedence.
    clientId: process.env.GOOGLE_CLIENT_ID || secrets?.web?.client_id || secrets?.google?.client_id || "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || secrets?.web?.client_secret || secrets?.google?.client_secret || "",
    callbackUrl: process.env.GOOGLE_CALLBACK_URL || "http://localhost:3000/auth/callback",
    scopes: (process.env.YOUTUBE_SCOPES || "https://www.googleapis.com/auth/youtube.upload,https://www.googleapis.com/auth/youtube.readonly").split(",").map((s) => s.trim()),
  },

  worker: {
    tickMs: parseInt(process.env.WORKER_TICK_MS || "2000", 10),
    maxConcurrent: parseInt(process.env.MAX_CONCURRENT_UPLOADS || "2", 10),
    perChannelMaxConcurrent: parseInt(process.env.PER_CHANNEL_MAX_CONCURRENT || "1", 10),
  },

  quota: {
    defaultDaily: parseInt(process.env.DEFAULT_DAILY_QUOTA || "10000", 10),
    uploadCost: parseInt(process.env.UPLOAD_QUOTA_COST || "1600", 10),
    burnFraction: parseFloat(process.env.QUOTA_BURN_FRACTION || "0.85"),
    backoffBase: parseInt(process.env.BACKOFF_BASE || "15", 10),
    backoffMax: parseInt(process.env.BACKOFF_MAX || "3600", 10),
    maxRetries: parseInt(process.env.MAX_RETRIES || "8", 10),
  },
};
