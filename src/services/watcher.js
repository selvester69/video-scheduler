/**
 * Folder watcher (Phase 2, Section 7).
 *
 * Primary trigger: chokidar watches each *active* source_folder. File changes
 * are de-bounced by `config.watcher.settleMs` (default 2s) to coalesce a batch
 * of writes (e.g. a single video finishing copying) into one scan.
 *
 * Safety net: every folder's `scan_interval` (default 300s) also triggers a full
 * `scanFolder` regardless of watcher state, so a missed event or an
 * externally-mounted volume still refreshes.
 *
 * Reachability: if a watched path doesn't exist, the folder is marked
 * `unreachable` (source_folders.status) and is NOT watched; a later rescan or a
 * re-appearing path flips it back to `reachable`.
 *
 * The watcher performs NO Google work — it only scans folders + touches the DB,
 * so it runs in the background worker process alongside the upload loop.
 */
import { existsSync, statSync } from "fs";
import { watch } from "chokidar";
import { config } from "../config.js";
import { queries, nowSec } from "../db.js";
import { scanFolder } from "./scanner.js";

const log = (...a) => console.log("[watcher]", ...a);

const watchers = new Map(); // folderId -> chokidar FSWatcher
const pending = new Map(); // folderId -> setTimeout handle
let pollTimer = null;

export async function refreshFolderStatus(folder) {
  const ok =
    typeof folder.path === "string" &&
    existsSync(folder.path) &&
    statSync(folder.path).isDirectory();
  await queries.setFolderStatus.run({
    folderId: folder.id,
    status: ok ? "reachable" : "unreachable",
    updatedAt: nowSec(),
  });
  return ok;
}

/** Debounced scan: wait `settleMs`, then scan once (coalesces bursts). */
function scheduleScan(folderId) {
  if (pending.has(folderId)) return; // a scan is already queued — settle window covers it
  const h = setTimeout(async () => {
    pending.delete(folderId);
    try {
      const scan = await scanFolder(folderId);
      if (scan.scanned || scan.added || scan.duplicates || scan.refreshed) {
        log(`scan ${folderId}: +${scan.added} new, ${scan.duplicates} dup, ${scan.refreshed} refreshed`);
      }
      if (scan.errors.length) log(`scan ${folderId} errors:`, scan.errors);
    } catch (e) {
      log(`scan ${folderId} failed:`, e.message);
    }
  }, config.watcher.settleMs);
  pending.set(folderId, h);
}

function startWatchingFolder(folder) {
  if (watchers.has(folder.id)) watchers.get(folder.id).close();
  log(`watching ${folder.path}`);
  const w = watch(folder.path, {
    ignoreInitial: true,
    depth: 0,
    ignored: ["**/node_modules/**", "**/.git/**"],
  });
  w.on("all", (_event, _path) => scheduleScan(folder.id));
  watchers.set(folder.id, w);
}

async function reconcile() {
  const folders = await queries.listActiveFolders.all();
  for (const f of folders) {
    const ok = await refreshFolderStatus(f);
    if (ok && !watchers.has(f.id)) startWatchingFolder(f);
    else if (!ok && watchers.has(f.id)) {
      watchers.get(f.id).close();
      watchers.delete(f.id);
    }
  }
}

export async function startWatchers() {
  if (pollTimer) return; // already running
  await reconcile();
  const tick = async () => {
    const folders = await queries.listActiveFolders.all();
    for (const f of folders) {
      const intervalMs = (f.scan_interval || 300) * 1000;
      if (f.last_scan_at && Date.now() / 1000 - f.last_scan_at < intervalMs / 1000) continue;
      try {
        const ok = await refreshFolderStatus(f);
        if (ok) await scanFolder(f.id);
      } catch (e) {
        log(`poll scan ${f.id} failed:`, e.message);
      }
    }
  };
  // safety-net cadence = the smallest scan_interval among active folders (clamped).
  let minInterval = 300;
  const folders0 = await queries.listActiveFolders.all();
  if (folders0.length) minInterval = Math.min(...folders0.map((f) => f.scan_interval || 300));
  pollTimer = setInterval(tick, Math.max(5000, Math.min(minInterval * 1000, 300000)));
  log("watchers started");
}

export function stopWatchers() {
  for (const h of pending.values()) clearTimeout(h);
  pending.clear();
  for (const w of watchers.values()) w.close();
  watchers.clear();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  log("watchers stopped");
}

export default { startWatchers, stopWatchers, refreshFolderStatus };
