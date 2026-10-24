/**
 * Rotation Assignment Planner (Phase 2, core engine).
 *
 * For each active RotationRule it finds the rule's next UNFILLED scheduled
 * slot, assigns the next eligible SourceItem, and — if that slot falls within
 * the scheduling horizon — creates a real `jobs` row (which the existing
 * worker uploads unchanged) plus a `media_asset` (a single copy of the file in
 * config.storageRoot). This is how shared-pool reuse works today: multiple
 * channel jobs reference the SAME media_asset_id and point at the same file.
 *
 * Scheduling horizon = 72h by default (doc Section 4). Slots beyond the horizon
 * get a `planned` assignment only (no job yet); the horizon is "extended
 * forward" as the worker tick / planner tick advances time, so a planned slot
 * is converted to a `scheduled` job once it enters the window.
 *
 * Safety:
 *  - idempotent — running plan() twice does not double-create (each rule's
 *    next slot is checked for an existing assignment first).
 *  - shared-pool dedup — media_asset is keyed by sha256; the file is copied
 *    once and reused across channels.
 *  - a job is never created without a usable source file on disk.
 *
 * Run via: POST /api/rotation/plan (manual), or a periodic worker tick.
 */
import { randomUUID } from "node:crypto";
import { copyFile, rm } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { config } from "../config.js";
import { queries, nowSec } from "../db.js";
import { nextSlots } from "./timezone.js";
import { renderCaption } from "./caption.js";

const HOUR_SEC = 3600;
export const HORIZON_HOURS = 72;
const LOOKAHEAD_SLOTS = 8; // how far ahead to scan for "next unfilled" slot

function log(...args) {
  // tame in dry-run/test; verbose enough in prod
  console.log("[rotation-planner]", ...args);
}

// First slot (>= now) with no assignment for this rule.
async function nextUnfilledSlot(rule, fromSec) {
  for (const slot of nextSlots(rule, fromSec, LOOKAHEAD_SLOTS)) {
    const existing = await queries.findAssignmentForSlot.get({ ruleId: rule.id, scheduledAt: slot });
    if (!existing) return slot;
  }
  return null;
}

// Eligible source item for the rule, honoring pool mode.
async function pickItem(rule) {
  const q = rule.pool_mode === "dedicated" ? queries.pickItemDedicated : queries.pickItemShared;
  return await q.get({ folderId: rule.folder_id, ruleId: rule.id });
}

// Ensure a canonical copy lives in the media store; reuse by sha256 (shared).
async function findOrCreateMedia(item) {
  const existing = await queries.findMediaByHash.get({ sha256: item.sha256 });
  if (existing) return existing;
  const ext = extname(item.filename);
  const name = `${randomUUID()}${ext}`;
  const dest = join(config.storageRoot, name);
  await copyFile(item.file_path, dest);
  const id = randomUUID();
  const now = nowSec();
  await queries.insertMediaAsset.run({
    id,
    sha256: item.sha256,
    path: name,
    sizeBytes: Number(item.size_bytes),
    created: now,
    updated: now,
  });
  return { id, path: name, sha256: item.sha256, size_bytes: item.size_bytes };
}

function jobTitle(rule, item, index, slotSec) {
  return renderCaption(rule.caption_template || "{filename}", {
    filename: item.filename,
    index,
    date: slotSec * 1000,
  });
}

// Create the real `jobs` row + media asset the worker will upload.
async function createJob(rule, item, slot) {
  const media = await findOrCreateMedia(item);
  const idxRow = await queries.countAssignmentsBeforeSlot.get({ ruleId: rule.id, scheduledAt: slot });
  const index = (Number(idxRow?.n) || 0) + 1;
  const title = jobTitle(rule, item, index, slot);
  const now = nowSec();
  const id = randomUUID();
  await queries.insertRotationJob.run({
    id,
    channelId: rule.channel_id,
    filename: media.path, // uuid name under storageRoot
    title,
    description: "",
    hashtags: "",
    tags: "",
    category: null,
    privacy: "private",
    scheduledAt: slot,
    priority: 0,
    nextRetryAt: null,
    status: "pending",
    created: now,
    updated: now,
    mediaAssetId: media.id,
  });
  return { jobId: id, mediaAssetId: media.id, mediaPath: media.path, index, title };
}

/**
 * One planning tick.
 *
 * @param {{fromSec?:number,horizonHours?:number}} [opts]
 * @returns {Promise<{rules:number,scheduled:number,planned:number,skipped:number,jobs:number,details:Array}>}
 */
export async function plan(opts = {}) {
  const fromSec = opts.fromSec ?? nowSec();
  const horizonSec = (opts.horizonHours ?? HORIZON_HOURS) * HOUR_SEC;
  const rules = await queries.listActiveRules.all();
  const details = [];
  let scheduled = 0,
    planned = 0,
    skipped = 0,
    jobs = 0;

  for (const rule of rules) {
    const slot = await nextUnfilledSlot(rule, fromSec);
    if (!slot) {
      skipped++;
      details.push({ ruleId: rule.id, outcome: "all_slots_filled" });
      continue;
    }

    const item = await pickItem(rule);
    if (!item) {
      log("no eligible media for rule", rule.id, "at slot", slot);
      skipped++;
      details.push({ ruleId: rule.id, slot, outcome: "no_media" });
      continue;
    }

    const within = slot <= fromSec + horizonSec;
    let jobId = null,
      mediaAssetId = null;
    if (within) {
      const j = await createJob(rule, item, slot);
      jobId = j.jobId;
      mediaAssetId = j.mediaAssetId;
      jobs++;
    }

    const now = nowSec();
    await queries.insertAssignment.run({
      id: randomUUID(),
      ruleId: rule.id,
      itemId: item.id,
      scheduledAt: slot,
      jobId,
      status: within ? "scheduled" : "planned",
      created: now,
      updated: now,
    });

    // Mark the item consumed. dedicated -> stays eligible nowhere. shared ->
    // 'used', but still eligble for OTHER rules (pickItemShared allows 'new'|'used'
    // and already excludes items assigned to THIS rule).
    await queries.updateItemStatus.run({ id: item.id, status: "used", updatedAt: now });

    within ? scheduled++ : planned++;
    details.push({
      ruleId: rule.id,
      slot,
      within,
      itemId: item.id,
      assignmentId: undefined,
      jobId,
      mediaAssetId,
    });
  }

  return { rules: rules.length, scheduled, planned, skipped, jobs, details };
}

/** Slot preview for the Rotation Queue UI (read-only). */
export async function previewSlots(ruleId, opts = {}) {
  const rule = await queries.findRule.get({ id: ruleId });
  if (!rule) return null;
  const fromSec = opts.fromSec ?? nowSec();
  const count = opts.count ?? LOOKAHEAD_SLOTS;
  const slots = nextSlots(rule, fromSec, count);
  const out = [];
  for (const slot of slots) {
    const a = await queries.findAssignmentForSlot.get({ ruleId: rule.id, scheduledAt: slot });
    out.push({
      slot,
      assigned: !!a,
      status: a ? a.status : "open",
      jobId: a ? a.job_id : null,
    });
  }
  return out;
}

/**
 * Media-store cleanup (Phase 2 policy, Section 14): delete `media_assets` rows
 * (and their files) that no `jobs` row references. For shared pools the file
 * is kept until every referencing job is gone, so this is always safe — a
 * pending/scheduled job holds a reference. Returns a summary.
 */
export async function cleanOrphanedMedia() {
  const rows = await queries.listOrphanedMedia.all({});
  let removed = 0,
    bytes = 0,
    errors = [];
  for (const m of rows) {
    const file = join(config.storageRoot, m.path);
    try {
      if (existsSync(file)) {
        const s = statSync(file);
        await rm(file, { force: true });
        bytes += Number(s.size);
      }
      await queries.deleteMediaAsset.run({ id: m.id });
      removed++;
    } catch (e) {
      errors.push(`${m.id}: ${e.message}`);
    }
  }
  if (removed) log(`cleaned ${removed} orphaned media assets (${bytes} bytes)`);
  return { removed, bytes, errors };
}

export default { plan, previewSlots, cleanOrphanedMedia, HORIZON_HOURS };
