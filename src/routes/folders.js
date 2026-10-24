/**
 * Bulk folder import + rotation-rule routes (Feature_Bulk_Folder_Import_Scheduling.md).
 *
 * Phase 1 surface:
 *   GET    /api/folders                       list folders + item counts
 *   POST   /api/folders                       add a watched folder + initial scan
 *   POST   /api/folders/:id/rescan            re-scan a folder (dedup by sha256)
 *   GET    /api/folders/:id/items             list detected files
 *   POST   /api/folders/:id/rules             create a per-channel rotation rule
 *   PATCH  /api/rules/:id                     update a rule
 *   DELETE /api/rules/:id                     stop a rule (keeps scheduled jobs)
 *   GET    /api/rules/:id/assignments         preview planned assignments
 *
 * Phase 2 core (now implemented in src/services/rotation-planner.js): the
 * Assignment Planner turn (POST /api/rotation/plan) that walks active rules,
 * fills each rule's next unfilled slot within the 72h horizon, copies the file
 * into the media store, and inserts real `jobs` rows (tagged source='rotation')
 * that the existing worker uploads unchanged. Slot math is timezone/DST-aware
 * (src/services/timezone.js) and captions render via src/services/caption.js.
 * The manual rescan scan lives in this module.
 *
 * Still deferred (Phase 2 remainder): the chokidar watcher + polling safety net,
 * the periodic cleanOrphanedMedia() cleanup job, auto-running plan() on the
 * worker tick, and the Rotation Queue UI.
 */
import { Router } from "express";
import { existsSync, statSync } from "fs";
import { isAbsolute } from "path";
import { config } from "../config.js";
import { queries, nowSec } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { scanFolder } from "../services/scanner.js";
import { plan, previewSlots, cleanOrphanedMedia, HORIZON_HOURS } from "../services/rotation-planner.js";

export const foldersRouter = Router();
export const rulesRouter = Router();
export const rotationRouter = Router();

const FREQUENCIES = new Set(["daily", "every_n_days", "weekdays"]);
const POOL_MODES = new Set(["shared", "dedicated"]);
const TIME_RE = /^\d{2}:\d{2}$/;

function folderValidationError(p) {
  if (typeof p !== "string" || !p.trim()) return "path is required";
  if (!isAbsolute(p)) return "path must be absolute";
  if (!existsSync(p)) return `path does not exist: ${p}`;
  if (!statSync(p).isDirectory()) return `path is not a directory: ${p}`;
  return null;
}
function weekdaysValid(s) {
  return /^[0-6](,[0-6])*$/.test(String(s || "").trim());
}
function parseStartDate(v) {
  if (v == null || v === "") return NaN;
  if (typeof v === "number") return v < 0 ? NaN : v * 1000; // assume epoch seconds
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? NaN : ms;
}
function serializeRule(r) {
  return {
    id: r.id,
    folderId: r.folder_id,
    channelId: r.channel_id,
    frequency: r.frequency,
    intervalN: r.interval_n ?? null,
    weekdays: r.weekdays ?? null,
    timeOfDay: r.time_of_day,
    timezone: r.timezone,
    startDate: r.start_date,
    poolMode: r.pool_mode,
    captionTemplate: r.caption_template ?? null,
    active: r.active ? true : false,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/* ---------------- folder CRUD ---------------- */

foldersRouter.get("/", requireAuth, async (_req, res) => {
  const rows = await queries.listFolders.all();
  res.json(
    rows.map((r) => ({
      id: r.id,
      path: r.path,
      active: r.active ? true : false,
      status: r.status,                 // reachable | unreachable (FR-ROT-07)
      scanInterval: r.scan_interval,
      lastScanAt: r.last_scan_at,
      itemCount: Number(r.item_count) || 0,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }))
  );
});

foldersRouter.post("/", requireAuth, async (req, res) => {
  const { path: p, scanInterval } = req.body || {};
  const err = folderValidationError(p);
  if (err) return res.status(400).json({ error: err });
  const existing = await queries.findFolderByPath.get({ path: p });
  if (existing) return res.status(409).json({ error: "folder already added", id: existing.id });

  const id = crypto.randomUUID();
  const now = nowSec();
  await queries.insertFolder.run({
    id,
    path: p,
    active: 1,
    scanInterval: scanInterval ?? 300,
    lastScanAt: null,
    created: now,
    updated: now,
  });
  const scan = await scanFolder(id);
  const row = await queries.findFolder.get({ id });
  res.status(201).json({
    id: row.id,
    path: row.path,
    active: row.active ? true : false,
    scanInterval: row.scan_interval,
    lastScanAt: row.last_scan_at,
    itemCount: scan.added,
    scan,
  });
});

// Remove a watched folder. Cascades delete rules -> assignments and items
// (FK ON DELETE CASCADE); any *already-scheduled* rotation jobs are left intact
// to be processed or cancelled from the Queue, mirroring rule-deletion semantics.
foldersRouter.delete("/:id", requireAuth, async (req, res) => {
  const folder = await queries.findFolder.get({ id: req.params.id });
  if (!folder) return res.status(404).json({ error: "folder not found" });
  await queries.deleteFolder.run({ id: req.params.id });
  res.json({ ok: true, id: req.params.id });
});

foldersRouter.post("/:id/rescan", requireAuth, async (req, res) => {
  const folder = await queries.findFolder.get({ id: req.params.id });
  if (!folder) return res.status(404).json({ error: "folder not found" });
  const scan = await scanFolder(folder.id);
  res.json(scan);
});

foldersRouter.get("/:id/items", requireAuth, async (req, res) => {
  const folder = await queries.findFolder.get({ id: req.params.id });
  if (!folder) return res.status(404).json({ error: "folder not found" });
  const items = await queries.listFolderItems.all({ folderId: req.params.id });
  res.json(
    items.map((i) => ({
      id: i.id,
      filename: i.filename,
      sizeBytes: Number(i.size_bytes),
      sha256: i.sha256,
      status: i.status,
      detectedAt: i.detected_at,
    }))
  );
});

/* ---------------- rules ---------------- */

foldersRouter.post("/:id/rules", requireAuth, async (req, res) => {
  const folder = await queries.findFolder.get({ id: req.params.id });
  if (!folder) return res.status(404).json({ error: "folder not found" });

  const { channelId, frequency, intervalN, weekdays, timeOfDay, timezone, startDate, poolMode, captionTemplate } = req.body || {};
  if (!channelId) return res.status(400).json({ error: "channelId is required" });
  const ch = await queries.findChannel.get({ id: channelId });
  if (!ch) return res.status(400).json({ error: `unknown channel: ${channelId}` });
  if (!FREQUENCIES.has(frequency))
    return res.status(400).json({ error: "frequency must be daily | every_n_days | weekdays" });
  if (!TIME_RE.test(timeOfDay)) return res.status(400).json({ error: "timeOfDay must be HH:mm" });
  if (frequency === "every_n_days" && (!Number.isInteger(intervalN) || intervalN < 1))
    return res.status(400).json({ error: "intervalN (>=1) is required for every_n_days" });
  if (frequency === "weekdays" && !weekdaysValid(weekdays))
    return res.status(400).json({ error: "weekdays must be a CSV of 0-6" });
  if (poolMode && !POOL_MODES.has(poolMode)) return res.status(400).json({ error: "poolMode must be shared | dedicated" });
  const startMs = parseStartDate(startDate);
  if (Number.isNaN(startMs)) return res.status(400).json({ error: "startDate is required (ISO date or epoch seconds)" });

  const id = crypto.randomUUID();
  const now = nowSec();
  await queries.insertRule.run({
    id,
    folderId: folder.id,
    channelId,
    frequency,
    intervalN: frequency === "every_n_days" ? intervalN : null,
    weekdays: frequency === "weekdays" ? String(weekdays) : null,
    timeOfDay,
    timezone: timezone || "UTC",
    startDate: Math.floor(startMs / 1000),
    poolMode: poolMode || "shared",
    captionTemplate: captionTemplate ?? null,
    active: 1,
    created: now,
    updated: now,
  });
  const rule = await queries.findRule.get({ id });
  res.status(201).json(serializeRule(rule));
});

// List a folder's rotation rules (for the editor / queue view).
foldersRouter.get("/:id/rules", requireAuth, async (req, res) => {
  const folder = await queries.findFolder.get({ id: req.params.id });
  if (!folder) return res.status(404).json({ error: "folder not found" });
  const rows = await queries.listRulesForFolder.all({ folderId: req.params.id });
  res.json(rows.map(serializeRule));
});

rulesRouter.patch("/:id", requireAuth, async (req, res) => {
  const rule = await queries.findRule.get({ id: req.params.id });
  if (!rule) return res.status(404).json({ error: "rule not found" });

  const { frequency, intervalN, weekdays, timeOfDay, timezone, startDate, poolMode, captionTemplate, active } = req.body || {};
  if (frequency !== undefined && !FREQUENCIES.has(frequency))
    return res.status(400).json({ error: "frequency must be daily | every_n_days | weekdays" });
  if (timeOfDay !== undefined && !TIME_RE.test(timeOfDay)) return res.status(400).json({ error: "timeOfDay must be HH:mm" });
  if (frequency === "every_n_days" && (!Number.isInteger(intervalN) || intervalN < 1))
    return res.status(400).json({ error: "intervalN (>=1) is required for every_n_days" });
  if (frequency === "weekdays" && !weekdaysValid(weekdays))
    return res.status(400).json({ error: "weekdays must be a CSV of 0-6" });
  if (poolMode !== undefined && !POOL_MODES.has(poolMode)) return res.status(400).json({ error: "poolMode must be shared | dedicated" });
  const startMs = startDate === undefined ? NaN : parseStartDate(startDate);
  if (startDate !== undefined && Number.isNaN(startMs)) return res.status(400).json({ error: "invalid startDate" });

  await queries.updateRule.run({
    id: req.params.id,
    frequency: frequency ?? rule.frequency,
    intervalN: frequency === "every_n_days" ? intervalN : rule.interval_n,
    weekdays: frequency === "weekdays" ? String(weekdays) : rule.weekdays,
    timeOfDay: timeOfDay ?? rule.time_of_day,
    timezone: timezone ?? rule.timezone,
    startDate: startDate === undefined ? rule.start_date : Math.floor(startMs / 1000),
    poolMode: poolMode ?? rule.pool_mode,
    captionTemplate: captionTemplate ?? rule.caption_template,
    active: active === undefined ? rule.active : active ? 1 : 0,
    updatedAt: nowSec(),
  });
  const updated = await queries.findRule.get({ id: req.params.id });
  res.json(serializeRule(updated));
});

rulesRouter.delete("/:id", requireAuth, async (req, res) => {
  // Deleting a rule cascades to its rotation_assignments, but any jobs already
  // scheduled from those assignments are left intact (FR-ROT-09).
  const info = await queries.deleteRule.run({ id: req.params.id });
  res.json({ ok: info.changes > 0 });
});

rulesRouter.get("/:id/assignments", requireAuth, async (req, res) => {
  const rule = await queries.findRule.get({ id: req.params.id });
  if (!rule) return res.status(404).json({ error: "rule not found" });
  const rows = await queries.listAssignmentsForRule.all({ ruleId: req.params.id });
  res.json(
    rows.map((a) => ({
      id: a.id,
      itemId: a.item_id,
      filename: a.filename,
      sha256: a.sha256,
      scheduledAt: a.scheduled_at,
      jobId: a.job_id,
      status: a.status,
      createdAt: a.created_at,
    }))
  );
});

/* ---------------- rotation planner (Phase 2 core) ---------------- */

// GET /api/rules/:id/slots?count=8&from=<epochSec> -> preview upcoming slots
// (read-only; marks each slot open / assigned).
rulesRouter.get("/:id/slots", requireAuth, async (req, res) => {
  const rule = await queries.findRule.get({ id: req.params.id });
  if (!rule) return res.status(404).json({ error: "rule not found" });
  const count = Math.max(1, Math.min(32, Number(req.query.count) || 8));
  const fromSec = req.query.from ? Number(req.query.from) : nowSec();
  const preview = await previewSlots(rule.id, { fromSec, count });
  res.json({ ruleId: rule.id, slots: preview, horizonHours: HORIZON_HOURS });
});

// POST /api/rotation/plan -> run one planning tick now. Idempotent.
rotationRouter.post("/plan", requireAuth, async (_req, res, next) => {
  try {
    const summary = await plan({ fromSec: nowSec(), horizonHours: HORIZON_HOURS });
    res.json(summary);
  } catch (e) {
    next(e);
  }
});

// POST /api/rotation/cleanup -> delete unreferenced media_assets + files. Safe:
// any file still referenced by a job is never removed.
rotationRouter.post("/cleanup", requireAuth, async (_req, res, next) => {
  try {
    const summary = await cleanOrphanedMedia();
    res.json(summary);
  } catch (e) {
    next(e);
  }
});
