/**
 * Worker entry point.
 *
 * `npm run worker` — separate process that drains the scheduled-upload queue.
 * Keeping it separate from the API server means long uploads never block HTTP
 * requests and it can be scaled to multiple instances (each with its own
 * DB row locks via claimJob).
 *
 * The worker also hosts the background, non-HTTP Phase 2 machinery:
 *   - the rotation Assignment Planner tick (POST /api/rotation/plan equiv),
 *   - the media-store cleanup sweep (cleanOrphanedMedia),
 *   - the folder watcher (chokidar) + its polling safety net.
 * None of this touches Google, so it co-locates cleanly here.
 */
import { initDb, nowSec } from "./db.js";
import { start, stop } from "./services/scheduler.js";
import { startWatchers, stopWatchers } from "./services/watcher.js";
import { plan, cleanOrphanedMedia, HORIZON_HOURS } from "./services/rotation-planner.js";
import { config } from "./config.js";

await initDb();
console.log(`[worker] config: dryRun=${config.dryRun}, tick=${config.worker.tickMs}ms, ` +
            `maxConcurrent=${config.worker.maxConcurrent}/${config.worker.perChannelMaxConcurrent} ` +
            `(per-ch)`);

let planTimer = null;
let cleanupTimer = null;

const runPlanTick = async () => {
  try {
    const res = await plan({ fromSec: nowSec(), horizonHours: HORIZON_HOURS });
    if (res.scheduled || res.planned || res.jobs) {
      console.log(`[rotation] plan tick: ${res.scheduled} scheduled, ${res.planned} planned, ${res.jobs} jobs, ${res.skipped} skipped`);
    }
  } catch (e) {
    console.error("[rotation] plan tick error:", e);
  }
};

const runCleanup = async () => {
  try {
    const r = await cleanOrphanedMedia();
    if (r.removed) console.log(`[rotation] cleanup: removed ${r.removed} orphaned assets (${r.bytes} bytes)`);
  } catch (e) {
    console.error("[rotation] cleanup tick error:", e);
  }
};

const handle = (signal) => {
  console.log(`\n[worker] received ${signal}, shutting down…`);
  stop(); // upload loop
  stopWatchers(); // chokidar + polling safety net
  if (planTimer) clearInterval(planTimer);
  if (cleanupTimer) clearInterval(cleanupTimer);
  // Give in-flight uploads a moment, then exit.
  setTimeout(() => process.exit(0), 15000);
};
process.on("SIGINT", () => handle("SIGINT"));
process.on("SIGTERM", () => handle("SIGTERM"));

// Kick off the Phase 2 background loops.
runPlanTick();
runCleanup();
startWatchers();
planTimer = setInterval(runPlanTick, config.worker.planIntervalMs);
cleanupTimer = setInterval(runCleanup, Math.max(60, config.worker.planIntervalMs));
start();
