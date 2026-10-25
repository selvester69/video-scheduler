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
 *        { titles:[...], items:[{platform,format,title,channelId,
 *          instagramAccountId}], description, hashtags, tags, category,
 *          privacy, channelId, priority, scheduleAt }
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
    if (req.body.metadata) {
      try { meta = JSON.parse(req.body.metadata); }
      catch { return res.status(400).json({ error: "invalid metadata JSON" }); }
    }
    const hasMeta = Boolean(req.body.metadata);
    const hasItems = Array.isArray(meta.items);
    const items = hasItems ? meta.items : [];
    if (hasItems && items.length !== files.length) {
      return res.status(400).json({ error: "metadata items must match the number of uploaded files" });
    }

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

    const jobs = files.map((file, i) => {
      const item = items[i] || {};
      const itemWhen = item.scheduleAt
        ? new Date(item.scheduleAt).getTime()
        : when;
      if (!Number.isFinite(itemWhen)) {
        throw Object.assign(new Error(`invalid scheduleAt for ${file.originalname}`), { statusCode: 400 });
      }
      const platform = item.platform || meta.platform || "youtube";
      const format = item.format || meta.format || "video";
      const title = String(item.caption ?? item.title ?? perTitles[i] ?? sharedTitle ?? "").trim() || file.originalname;
      const channelId = item.channelId ?? meta.channelId ?? (hasMeta ? null : req.body.channelId || null);
      const instagramAccountId = item.instagramAccountId ?? meta.instagramAccountId ?? null;
      const facebookPageId = item.facebookPageId ?? meta.facebookPageId ?? null;
      if (!title) throw Object.assign(new Error(`title or caption is required (${file.originalname})`), { statusCode: 400 });
      if (!["youtube", "instagram", "facebook"].includes(platform)) {
        throw Object.assign(new Error(`unsupported platform for ${file.originalname}`), { statusCode: 400 });
      }
      if ((platform === "youtube" && !["video", "short"].includes(format)) ||
          (platform === "instagram" && format !== "reel") ||
          (platform === "facebook" && format !== "video")) {
        throw Object.assign(new Error(`invalid format for ${platform} upload (${file.originalname})`), { statusCode: 400 });
      }
      if (platform === "instagram") {
        if (!instagramAccountId) {
          throw Object.assign(new Error(`choose a connected Instagram account for ${file.originalname}`), { statusCode: 400 });
        }
        if (!config.instagram.publicAppUrl || new URL(config.instagram.publicAppUrl).protocol !== "https:") {
          throw Object.assign(new Error("Instagram Reels require APP_PUBLIC_URL to be a public HTTPS URL"), { statusCode: 400 });
        }
        if (!/\.(mp4|mov)$/i.test(file.originalname)) {
          throw Object.assign(new Error(`Instagram Reels require an MP4 or MOV file (${file.originalname})`), { statusCode: 400 });
        }
        if (title.length > 2200) {
          throw Object.assign(new Error(`Instagram captions must be 2,200 characters or fewer (${file.originalname})`), { statusCode: 400 });
        }
      }
      if (platform === "facebook") {
        if (!facebookPageId) {
          throw Object.assign(new Error(`choose a connected Facebook Page for ${file.originalname}`), { statusCode: 400 });
        }
        if (!config.facebook.publicAppUrl || new URL(config.facebook.publicAppUrl).protocol !== "https:") {
          throw Object.assign(new Error("Facebook videos require APP_PUBLIC_URL to be a public HTTPS URL"), { statusCode: 400 });
        }
        if (!/\.(mp4|mov|m4v)$/i.test(file.originalname)) {
          throw Object.assign(new Error(`Facebook videos require an MP4, MOV, or M4V file (${file.originalname})`), { statusCode: 400 });
        }
      }
      return {
        file, item, platform, format, title, channelId, instagramAccountId, facebookPageId,
        scheduledAt: Math.floor(itemWhen / 1000),
      };
    });

    for (const job of jobs) {
      if (job.platform === "instagram") {
        const account = await queries.findInstagramAccount.get({ id: job.instagramAccountId });
        if (!account || !account.active) {
          return res.status(400).json({ error: `Instagram account is not connected or active (${job.file.originalname})` });
        }
      }
      if (job.platform === "facebook") {
        const page = await queries.findFacebookPage.get({ id: job.facebookPageId });
        if (!page || !page.active) {
          return res.status(400).json({ error: `Facebook Page is not connected or active (${job.file.originalname})` });
        }
      }
    }

    const created = [];
    for (let i = 0; i < files.length; i++) {
      const { file: f, item, platform, format, title, channelId, instagramAccountId, facebookPageId, scheduledAt: itemScheduledAt } = jobs[i];

      const id = crypto.randomUUID();
      await queries.insertPlatformJob.run({
        id,
        channelId: platform === "youtube" ? channelId : null,
        platform,
        format,
        instagramAccountId: platform === "instagram" ? instagramAccountId : null,
        facebookPageId: platform === "facebook" ? facebookPageId : null,
        filename: f.filename,
        title,
        description: ["youtube", "facebook"].includes(platform)
          ? (item.description ?? (hasMeta ? meta.description : req.body.description) ?? "") : "",
        hashtags: platform === "youtube" ? normalizeHashtags(item.hashtags ?? (hasMeta ? meta.hashtags : req.body.hashtags) ?? "") : "",
        tags: platform === "youtube" ? String(item.tags ?? (hasMeta ? meta.tags : req.body.tags) ?? "").trim() : "",
        category: hasMeta ? (meta.category || null) : (req.body.category || null),
        privacy: normalizePrivacy(item.privacy || (hasMeta ? (meta.privacy || "private") : req.body.privacy)),
        scheduledAt: itemScheduledAt,
        priority: parseInt(hasMeta ? (meta.priority || "0") : (req.body.priority || "0"), 10),
        nextRetryAt: itemScheduledAt,
        status: "pending",
        created: now,
        updated: now,
      });
      created.push({ id, title, scheduledAt: itemScheduledAt });
    }

    const verb = jobs.some((job) => job.scheduledAt > now) ? "Scheduled" : "Queued";
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
 * DELETE /api/videos/:id — cancel a scheduled job or dismiss a failed job.
 */
router.delete("/:id", async (req, res) => {
  const info = await db.prepare(`UPDATE jobs SET status='deleted', updated_at=@updatedAt WHERE id=@id AND status IN ('pending','queued','failed','exhausted')`).run({ id: req.params.id, updatedAt: nowSec() });
  if (info.changes === 0) return res.status(404).json({ error: "not found or not deletable" });
  res.json({ id: req.params.id, status: "deleted" });
});

/**
 * POST /api/videos/:id/retry — explicitly retry a failed/exhausted job.
 * Manual retries are delayed by two minutes and reset the automatic retry budget.
 */
router.post("/:id/retry", async (req, res) => {
  try {
    const job = await queries.findJob.get({ id: req.params.id });
    if (!job) return res.status(404).json({ error: "not found" });
    if (!["failed", "exhausted"].includes(job.status)) {
      return res.status(409).json({ error: "only failed or exhausted uploads can be retried" });
    }

    let channelId = job.channel_id;
    if (job.platform === "instagram") {
      const account = await queries.findInstagramAccount.get({ id: job.instagram_account_id });
      if (!account?.active) return res.status(409).json({ error: "Reconnect the Instagram account before retrying this upload" });
    } else if (job.platform === "facebook") {
      const page = await queries.findFacebookPage.get({ id: job.facebook_page_id });
      if (!page?.active) return res.status(409).json({ error: "Reconnect the Facebook Page before retrying this upload" });
    } else {
      const channels = await queries.listActiveChannels.all();
      if (!channels.length) return res.status(409).json({ error: "Connect an active YouTube channel before retrying this upload" });
      if (channelId && !channels.some((channel) => channel.id === channelId)) channelId = null;
    }

    const now = nowSec();
    const scheduledAt = now + 120;
    const info = await db.prepare(`UPDATE jobs SET status='pending', channel_id=@channelId, scheduled_at=@scheduledAt, next_retry_at=@scheduledAt, retry_count=0, last_error=NULL, updated_at=@now WHERE id=@id AND status IN ('failed','exhausted')`).run({
      id: job.id, channelId, scheduledAt, now,
    });
    if (!info.changes) return res.status(409).json({ error: "upload status changed; refresh and try again" });
    res.json(await queries.findJob.get({ id: job.id }));
  } catch (error) {
    console.error("retry job error:", error);
    res.status(400).json({ error: error.message || "could not retry upload" });
  }
});

/**
 * PATCH /api/videos/:id — edit a scheduled or failed job's metadata.
 * The video file itself can't change (that would be a re-upload); only title,
 * description, hashtags, tags, category, privacy, channelId, priority, and
 * scheduleAt are editable. Jobs already uploading or done are locked.
 */
router.patch("/:id", async (req, res) => {
  const id = req.params.id;
  try {
    const existing = await queries.findJob.get({ id });
    if (!existing) return res.status(404).json({ error: "not found" });
    if (!["pending", "failed", "exhausted"].includes(existing.status)) {
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
      `UPDATE jobs SET ${fields.join(", ")} WHERE id = @id AND status IN ('pending','failed','exhausted')`
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
