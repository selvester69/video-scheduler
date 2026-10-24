import { Router } from "express";
import { queries, db, nowSec } from "../db.js";
import { stageUpload } from "../middleware/stageUpload.js";
import { config } from "../config.js";

const router = Router();

/**
 * POST /api/videos
 *   Multipart form. Field name `video` is repeatable for multiple uploads;
 *   one job is created per file and all become `pending` (the worker dispatches
 *   due ones next tick, up to MAX_CONCURRENT_UPLOADS).
 *
 *   Text/metadata is sent in ONE of two ways:
 *     1. `metadata` — a JSON string blob (preferred, used by the web UI) with:
 *        { titles:[...], description, hashtags, tags, category, privacy,
 *          channelId, priority, scheduleAt }
 *        - titles[] is an ordered array, one per file (blank → use file name).
 *     2. Flat text fields: `description,hashtags,tags,category,privacy,
 *        channelId,priority,scheduleAt` (legacy single-upload clients). A single
 *        `title` applies when exactly one file is sent; `title[]` (repeated) is
 *        an ordered per-file array.
 *
 *   scheduleAt: ISO timestamp; omitted/`now` = upload ASAP. The worker only
 *   picks up jobs whose scheduled_at <= now, so future jobs stay `pending`.
 *
 *   Response (always batch-shaped):
 *     { created: [{id,title,scheduledAt}], count, message }
 */
router.post("/", stageUpload.array("video", config.upload.maxFiles), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: "at least one 'video' file is required" });

    // Metadata: prefer the compact `metadata` JSON blob (sent by the web UI for
    // multiple uploads; it carries per-file titles + shared fields). Fall back
    // to flat text fields for legacy single-upload clients.
    let meta = {};
    if (req.body.metadata) { try { meta = JSON.parse(req.body.metadata); } catch { /* ignore bad JSON */ } }
    const hasMeta = Boolean(req.body.metadata);

    // Per-file titles (ordered, one per file).
    let perTitles = [];
    if (hasMeta) {
      perTitles = Array.isArray(meta.titles) ? meta.titles : [];
    } else if (req.body["title[]"]) {
      perTitles = Array.isArray(req.body["title[]"]) ? req.body["title[]"] : [req.body["title[]"]];
    }
    const sharedTitle = hasMeta ? null : (req.body.title ? String(req.body.title).trim() : null);

    const whenStr = hasMeta ? (meta.scheduleAt || req.body.scheduleAt) : req.body.scheduleAt;
    const when = whenStr ? new Date(whenStr).getTime() : Date.now();
    if (isNaN(when)) return res.status(400).json({ error: "invalid scheduleAt" });
    const scheduledAt = Math.floor(when / 1000);
    const now = nowSec();

    const created = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const title =
        (perTitles[i] && String(perTitles[i]).trim()) ||
        (files.length === 1 && sharedTitle) ||
        f.originalname;
      if (!title) return res.status(400).json({ error: `title is required (${f.originalname})` });

      const id = crypto.randomUUID();
      await queries.insertJob.run({
        id,
        channelId: hasMeta ? (meta.channelId || null) : (req.body.channelId || null),
        filename: f.filename,
        title,
        description: hasMeta ? (meta.description || "") : (req.body.description || ""),
        hashtags: hasMeta ? normalizeHashtags(meta.hashtags || "") : normalizeHashtags(req.body.hashtags || ""),
        tags: hasMeta ? (meta.tags || "").trim() : (req.body.tags || "").trim(),
        category: hasMeta ? (meta.category || null) : (req.body.category || null),
        privacy: normalizePrivacy(hasMeta ? (meta.privacy || "private") : req.body.privacy),
        scheduledAt,
        priority: parseInt(hasMeta ? (meta.priority || "0") : (req.body.priority || "0"), 10),
        nextRetryAt: scheduledAt,
        status: "pending",
        created: now,
        updated: now,
      });
      created.push({ id, title, scheduledAt });
    }

    const verb = when <= Date.now() ? "Queued" : "Scheduled";
    res.status(201).json({
      created,
      count: created.length,
      message: `${verb} ${created.length} video(s) for upload`,
    });
  } catch (e) {
    console.error("create job(s) error:", e);
    res.status(400).json({ error: e.message });
  }
});

/**
 * GET /api/videos  — list all scheduled/upload jobs (newest first within priority order)
 */
router.get("/", async (_req, res) => {
  res.json(await queries.listJobs.all());
});

/**
 * GET /api/videos/:id
 */
router.get("/:id", async (req, res) => {
  const v = await queries.findJob.get({ id: req.params.id });
  if (!v) return res.status(404).json({ error: "not found" });
  res.json(v);
});

/**
 * DELETE /api/videos/:id — remove a scheduled job before it uploads.
 */
router.delete("/:id", async (req, res) => {
  const info = await db.prepare(`UPDATE jobs SET status='deleted' WHERE id=@id AND status IN ('pending','queued')`).run({ id: req.params.id });
  if (info.changes === 0) return res.status(404).json({ error: "not found or not deletable" });
  res.json({ id: req.params.id, status: "deleted" });
});

/**
 * PATCH /api/videos/:id — edit a SCHEDULED (pending) job's metadata.
 * The video file itself can't change (that would be a re-upload); only title,
 * description, hashtags, tags, category, privacy, channelId, priority, and
 * scheduleAt are editable. Jobs already uploading/done/failed are locked.
 */
router.patch("/:id", async (req, res) => {
  const id = req.params.id;
  try {
    const existing = await queries.findJob.get({ id });
    if (!existing) return res.status(404).json({ error: "not found" });
    if (existing.status !== "pending") {
      return res.status(409).json({ error: `can't edit a job that is "${existing.status}"` });
    }

    const b = req.body || {};
    const fields = [];
    const params = { id };

    if (b.title !== undefined) {
      if (!String(b.title).trim()) return res.status(400).json({ error: "title required" });
      fields.push("title = @title"); params.title = b.title;
    }
    if (b.description !== undefined) { fields.push("description = @description"); params.description = b.description || ""; }
    if (b.hashtags !== undefined) { fields.push("hashtags = @hashtags"); params.hashtags = normalizeHashtags(b.hashtags); }
    if (b.tags !== undefined) { fields.push("tags = @tags"); params.tags = (b.tags || "").trim(); }
    if (b.category !== undefined) { fields.push("category = @category"); params.category = b.category || null; }
    if (b.privacy !== undefined) { fields.push("privacy = @privacy"); params.privacy = normalizePrivacy(b.privacy); }
    if (b.channelId !== undefined) { fields.push("channel_id = @channelId"); params.channelId = b.channelId || null; }
    if (b.priority !== undefined) {
      const p = parseInt(b.priority || "0", 10);
      fields.push("priority = @priority"); params.priority = isNaN(p) ? 0 : p;
    }
    if (b.scheduleAt !== undefined) {
      const t = new Date(b.scheduleAt).getTime();
      if (isNaN(t)) return res.status(400).json({ error: "invalid scheduleAt" });
      const sec = Math.floor(t / 1000);
      fields.push("scheduled_at = @scheduledAt", "next_retry_at = @nextRetryAt");
      params.scheduledAt = sec; params.nextRetryAt = sec;
    }
    if (!fields.length) return res.status(400).json({ error: "no updatable fields" });

    fields.push("updated_at = @updatedAt"); params.updatedAt = nowSec();
    const info = await db.prepare(
      `UPDATE jobs SET ${fields.join(", ")} WHERE id = @id AND status = 'pending'`
    ).run(params);
    if (info.changes === 0) return res.status(409).json({ error: "job no longer editable (in progress or already processed)" });

    const updated = await queries.findJob.get({ id });
    res.json(updated);
  } catch (e) {
    console.error("update job error:", e);
    res.status(400).json({ error: e.message });
  }
});

function normalizeHashtags(raw) {
  if (!raw) return "";
  return String(raw)
    .split(/[\s,]+/)
    .map((h) => h.replace(/^#+/, "#"))
    .filter((h) => /^#\S+/.test(h))
    .join(" ");
}

function normalizePrivacy(p) {
  const v = (p || "private").toLowerCase();
  return ["public", "unlisted", "private"].includes(v) ? v : "private";
}

export default router;
