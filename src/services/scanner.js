/**
 * Folder scanner for the bulk-import feature (Feature_Bulk_Folder_Import_Scheduling.md).
 *
 * `scanFolder(folderId)` reads the registered folder path, walks video files,
 * computes a streaming SHA-256 per file, and inserts/updates `source_items`,
 * deduplicating app-wide by sha256 (FR-ROT-06: duplicates are not re-imported).
 *
 * This is the Phase 1 scan (manual rescan + the polling safety net). The live
 * chokidar watcher (Section 7) is Phase 2; it calls this same function.
 */
import { createHash } from "crypto";
import { createReadStream, readdir as readdirCb, stat as statCb } from "fs";
import { queries, nowSec } from "../db.js";

const VIDEO_EXTS = new Set([
  ".mp4", ".mov", ".mkv", ".webm", ".avi", ".flv", ".wmv", ".m4v", ".mpg", ".mpeg",
]);

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    const s = createReadStream(filePath);
    s.on("data", (c) => h.update(c));
    s.on("end", () => resolve(h.digest("hex")));
    s.on("error", reject);
  });
}
function readDir(dir) {
  return new Promise((resolve, reject) =>
    readdirCb(dir, { withFileTypes: true }, (e, d) => (e ? reject(e) : resolve(d)))
  );
}
function statFile(p) {
  return new Promise((resolve, reject) => {
    statCb(p, (e, s) => (e ? reject(e) : resolve(s)));
  });
}
function extOf(name) {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i).toLowerCase() : "";
}

/**
 * Scan a registered folder. Returns a summary object.
 * @param {string} folderId
 * @returns {Promise<{folderId, scanned, added, duplicates, refreshed, errors:string[]}>}
 */
export async function scanFolder(folderId) {
  const folder = await queries.findFolder.get({ id: folderId });
  if (!folder) {
    const e = new Error(`source folder not found: ${folderId}`);
    e.code = "NOT_FOUND";
    throw e;
  }
  const now = nowSec();
  let scanned = 0,
    added = 0,
    duplicates = 0,
    refreshed = 0;
  const errors = [];

  let entries;
  try {
    entries = await readDir(folder.path);
  } catch (e) {
    // Path unreachable (e.g. Drive unmounted) — record it but keep going.
    errors.push(`${folder.path}: ${e.message}`);
    await queries.setFolderStatus.run({ folderId: folder.id, status: "unreachable", updatedAt: now });
    await queries.setFolderLastScan.run({ folderId: folder.id, lastScanAt: now, updatedAt: now });
    return { folderId, scanned, added, duplicates, refreshed, errors };
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue; // skip subdirs (recursion is Phase 2 scope)
    if (!VIDEO_EXTS.has(extOf(entry.name))) continue; // only videos

    const filePath = folder.path + "/" + entry.name;
    let st;
    try {
      st = await statFile(filePath);
    } catch (e) {
      errors.push(`${filePath}: ${e.message}`);
      continue;
    }
    scanned++;

    let sha;
    try {
      sha = await hashFile(filePath);
    } catch (e) {
      errors.push(`${filePath}: ${e.message}`);
      continue;
    }

    const existing = await queries.findItemByHash.get({ sha256: sha });
    if (existing) {
      duplicates++;
      // If it already belongs to THIS folder, refresh size/location in place.
      if (existing.folder_id === folder.id) {
        await queries.updateItemLocation.run({
          id: existing.id,
          filename: entry.name,
          filePath: filePath,
          sizeBytes: Number(st.size),
          updatedAt: now,
        });
        refreshed++;
      }
      // Otherwise it's a genuine cross-folder duplicate (FR-ROT-06) — skip.
      continue;
    }

    await queries.insertItem.run({
      id: crypto.randomUUID(),
      folderId: folder.id,
      filename: entry.name,
      filePath: filePath,
      sizeBytes: Number(st.size),
      sha256: sha,
      detectedAt: now,
      status: "new",
      created: now,
      updated: now,
    });
    added++;
  }

  await queries.setFolderStatus.run({ folderId: folder.id, status: "reachable", updatedAt: now });
  await queries.setFolderLastScan.run({ folderId: folder.id, lastScanAt: now, updatedAt: now });
  return { folderId, scanned, added, duplicates, refreshed, errors };
}
