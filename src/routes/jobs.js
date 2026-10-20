import { Router } from "express";
import { queries, db, nowSec } from "../db.js";
import { stageUpload } from "../middleware/stageUpload.js";

const router = Router();

/**
 * POST /api/videos
 *   Multipart: `video` (file) + JSON-ish text fields:
 *     title*, description, hashtags, tags, privacy, channelId, scheduleAt
 *   (`*` required.) On success returns the created job (status: pending/done).
 *
 *   scheduleAt: ISO timestamp; omitted/`now` = upload ASAP. The worker only
 *   picks up jobs whose scheduled_at <= now, so future jobs stay `pending`.
 */
router.post("/", stageUpload.single("video"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "field 'video' is required" });
    if (!req.body.title) return res.status(400).json({ error: "title is required" });

    const when = req.body.scheduleAt
      ? new Date(req.body.scheduleAt).getTime()
      : Date.now();
    if (isNaN(when)) return res.status(400).json({ error: "invalid scheduleAt" });

    const id = crypto.randomUUID();
    const job = {
      id,
      channelId: req.body.channelId || null,
      filename: req.file.filename,
      title: req.body.title,
      description: req.body.description || "",
      hashtags: normalizeHashtags(req.body.hashtags),
      tags: (req.body.tags || "").trim(),
      category: req.body.category || null,
      privacy: normalizePrivacy(req.body.privacy),
      scheduledAt: Math.floor(when / 1000),
      priority: parseInt(req.body.priority || "0", 10),
      nextRetryAt: Math.floor(when / 1000),
      status: "pending",
    };

    await queries.insertJob.run({
      ...job,
      created: nowSec(),
      updated: nowSec(),
    });
    res.status(201).json({
      id,
      status: "scheduled",
      scheduledAt: job.scheduledAt,
      message: when <= Date.now()
        ? "Queued for immediate processing"
        : "Scheduled; will upload at the scheduled time",
    });
  } catch (e) {
    console.error("create job error:", e);
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
