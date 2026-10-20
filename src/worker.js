/**
 * Worker entry point.
 *
 * `npm run worker` — separate process that drains the scheduled-upload queue.
 * Keeping it separate from the API server means long uploads never block HTTP
 * requests and it can be scaled to multiple instances (each with its own
 * DB row locks via claimJob).
 */
import { initDb } from "./db.js";
import { start, stop } from "./services/scheduler.js";
import { config } from "./config.js";

await initDb();
console.log(`[worker] config: dryRun=${config.dryRun}, tick=${config.worker.tickMs}ms, ` +
            `maxConcurrent=${config.worker.maxConcurrent}/${config.worker.perChannelMaxConcurrent} ` +
            `(per-ch)`);

const handle = (signal) => {
  console.log(`\n[worker] received ${signal}, shutting down…`);
  stop();
  // Give in-flight uploads a moment, then exit.
  setTimeout(() => process.exit(0), 15000);
};
process.on("SIGINT", () => handle("SIGINT"));
process.on("SIGTERM", () => handle("SIGTERM"));

start();
