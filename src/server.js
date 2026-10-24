import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { existsSync, mkdirSync } from "fs";
import { config } from "./config.js";
import { initDb, db, queries, nowSec } from "./db.js";
import authRouter from "./routes/auth.js";
import jobsRouter from "./routes/jobs.js";
import sessionRouter from "./routes/session.js";
import explorerRouter from "./routes/explorer.js";
import { foldersRouter, rulesRouter, rotationRouter } from "./routes/folders.js";
import instagramRouter from "./routes/instagram.js";
import { requireAuth } from "./middleware/auth.js";
import { currentUser, seedDefaultUser } from "./services/auth.js";
import { verifySignedMediaUrl } from "./services/media-url.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const STARTED_AT = Date.now();

app.use(cors());
app.use(express.json());

// Frontend
app.get("/", (req, res, next) => {
  // If auth is on and there's no valid session, send them to log in.
  if (config.auth.require && !currentUser(req)) return res.redirect("/login");
  next();
});
app.use("/", express.static(path.join(__dirname, "..", "public")));

// Login / register page (served when no auth cookie).
app.get("/login", (_req, res) => res.sendFile(path.join(__dirname, "..", "public", "login.html")));
app.get("/register", (_req, res) => res.sendFile(path.join(__dirname, "..", "public", "login.html")));
// Instagram fetches staged media using a short-lived, signed URL. Direct file
// paths are not public, even though the media must be reachable by Instagram.
app.get("/media/:filename", (req, res, next) => {
  const filename = req.params.filename;
  if (filename !== path.basename(filename) || filename.includes("\\")) return res.sendStatus(404);
  if (!verifySignedMediaUrl(filename, req.query.expires, req.query.signature)) return res.sendStatus(403);
  res.sendFile(filename, { root: config.storageRoot, acceptRanges: true, maxAge: "1h" }, (error) => {
    if (error && !res.headersSent) {
      if (error.status === 404) return res.sendStatus(404);
      next(error);
    }
  });
});

// API
app.get("/api/health", async (_req, res) => {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM channels").get();
  res.json({
    status: "ok",
    time: new Date().toISOString(),
    dryRun: config.dryRun,
    dbDriver: config.dbDriver,
    channels: Number(row?.n) || 0,
    uptime: Math.round((Date.now() - STARTED_AT) / 1000),
  });
});
app.use("/api/auth", sessionRouter);   // /register /login /logout /profile (profile gated internally)
app.use("/api/auth", authRouter);      // /connect /callback /channels (channels gated)
app.use("/api/videos", config.auth.require ? [requireAuth, jobsRouter] : jobsRouter);
app.use("/api/instagram", instagramRouter);
app.use("/api/folders", foldersRouter); // Phase 1: folder scan + rotation rules (self-gated)
app.use("/api/rules", rulesRouter);     // Phase 1: PATCH/DELETE/assignments for rotation rules
app.use("/api/rotation", rotationRouter); // Phase 2 core: POST /plan (assignment planner)
app.use("/api/explorer", requireAuth, explorerRouter); // admin read-only DB query UI

// OAuth callback is a public GET (Google redirects here with a query string)
app.use("/auth", authRouter);

if (!existsSync(config.storageRoot)) mkdirSync(config.storageRoot, { recursive: true });
await initDb();
await seedDefaultUser();

const port = config.port;
app.listen(port, () => {
  console.log(`🎬 YouTube video scheduler API on http://localhost:${port}`);
  console.log(`   dbDriver=${config.dbDriver}  dryRun=${config.dryRun}  storage=${config.storageRoot}`);
  console.log(`   connect a channel: http://localhost:${port}/api/auth/connect`);
});

export default app;
