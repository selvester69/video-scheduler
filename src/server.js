import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { existsSync, mkdirSync } from "fs";
import { config } from "./config.js";
import { initDb, db } from "./db.js";
import authRouter from "./routes/auth.js";
import jobsRouter from "./routes/jobs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(express.json());

// Frontend
app.use("/", express.static(path.join(__dirname, "..", "public")));
// Staged video files (served to the worker on the same host; in a real deploy
// these live on S3 and the worker streams directly).
app.use(
  "/media",
  express.static(config.storageRoot, {
    range: true,
    maxAge: "1y",
    headers: { "Accept-Ranges": "bytes" },
  })
);

// API
app.get("/api/health", async (_req, res) => {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM channels").get();
  res.json({
    status: "ok",
    time: new Date().toISOString(),
    dryRun: config.dryRun,
    dbDriver: config.dbDriver,
    channels: Number(row?.n) || 0,
  });
});
app.use("/api/auth", authRouter);
app.use("/api/videos", jobsRouter);

// OAuth callback is a public GET (Google redirects here with a query string)
app.use("/auth", authRouter);

if (!existsSync(config.storageRoot)) mkdirSync(config.storageRoot, { recursive: true });
await initDb();

const port = config.port;
app.listen(port, () => {
  console.log(`🎬 YouTube video scheduler API on http://localhost:${port}`);
  console.log(`   dbDriver=${config.dbDriver}  dryRun=${config.dryRun}  storage=${config.storageRoot}`);
  console.log(`   connect a channel: http://localhost:${port}/api/auth/connect`);
});

export default app;
