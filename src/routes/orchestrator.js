import { randomUUID } from "crypto";
import { accessSync, constants } from "fs";
import { basename, resolve, sep } from "path";
import { Router } from "express";
import { db, nowSec } from "../db.js";
import { config as appConfig } from "../config.js";
import { requireAuth } from "../middleware/auth.js";
import { getOrchestratorRuntime, normalizeOrchestratorConfig, runOrchestratorCycle } from "../services/task-orchestrator.js";

const router = Router();
router.use(requireAuth);
const WORKSPACE_ID = "default";
const MAX_PAGE_SIZE = 100;
const WORKFLOW_ACTIONS = new Set(["validate", "upload", "wait_processing", "set_visibility", "cross_post", "reschedule", "playlist"]);
const DEFAULT_CONFIG = Object.freeze({ selectionIntervalSeconds: 60, maxTasksPerCycle: 5, fairness: true, platformOrder: ["youtube", "instagram", "facebook"], quotaSafetyMargin: 0.1, weights: { basePriority: 1, deadline: 30, quotaFit: 10, channelHealth: 15, retryPenalty: 5, quotaRisk: 15, campaignContinuity: 5 } });
const VALID_STATUSES = new Set(["pending", "queued", "uploading", "processing", "done", "published", "failed", "exhausted", "deleted", "cancelled", "deferred", "waiting_approval"]);

function parseConfig(value) {
  try {
    return normalizeOrchestratorConfig(value);
  } catch { return { ...DEFAULT_CONFIG, weights: { ...DEFAULT_CONFIG.weights } }; }
}

async function runtime() {
  const row = await getOrchestratorRuntime();
  return { ...row, config: parseConfig(row.config) };
}

async function writeAction({ jobId = null, actionType, actor = "operator", result = "success", reason, details = {} }) {
  await db.prepare(`INSERT INTO orchestrator_actions (id, workspace_id, job_id, action_type, actor, result, reason, details, created_at)
    VALUES (@id, @workspaceId, @jobId, @actionType, @actor, @result, @reason, @details, @createdAt)`)
    .run({ id: randomUUID(), workspaceId: WORKSPACE_ID, jobId, actionType, actor, result, reason,
      details: JSON.stringify(details), createdAt: nowSec() });
}

function encodeCursor(value) { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
function decodeCursor(value) {
  if (!value) return null;
  try { return JSON.parse(Buffer.from(value, "base64url").toString("utf8")); }
  catch { throw Object.assign(new Error("Invalid pagination cursor"), { status: 400 }); }
}
function parseDate(value, label, inclusiveEnd = false) {
  if (!value) return null;
  const raw = String(value);
  let ms = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  if (!Number.isFinite(ms)) throw Object.assign(new Error(`${label} must be a valid date`), { status: 400 });
  if (inclusiveEnd && /^\d{4}-\d{2}-\d{2}$/.test(raw)) ms += 86400000 - 1000;
  return Math.floor(ms / 1000);
}
function safeFileExists(filename) {
  if (!filename || basename(filename) !== filename) return false;
  const root = resolve(appConfig.storageRoot);
  const path = resolve(root, filename);
  if (!path.startsWith(`${root}${sep}`)) return false;
  try { accessSync(path, constants.R_OK); return true; } catch { return false; }
}
function clampScore(value) { return Math.max(0, Math.min(100, Math.round(value))); }

function calculateRisk(row, now, quotaLimit) {
  const factors = [];
  let risk = Math.max(0, Number(row.retry_count || 0)) * 12;
  if (!Number(row.destination_active)) { risk += 35; factors.push("Destination is disconnected or inactive"); }
  if (!row.file_exists) { risk += 30; factors.push("Media file is missing or unreadable"); }
  if (row.platform === "youtube" && Number(row.quota_used || 0) + appConfig.quota.uploadCost > quotaLimit) {
    risk += 30; factors.push("YouTube quota budget is insufficient");
  }
  if (row.status === "failed" || row.status === "exhausted") { risk += 25; factors.push("Previous upload attempt failed"); }
  if (row.scheduled_at < now && row.status === "pending") { risk += 15; factors.push("Scheduled time has passed"); }
  const retryRisk = Math.max(0, Number(row.retry_count || 0));
  if (retryRisk) factors.push(`${retryRisk} previous retr${retryRisk === 1 ? "y" : "ies"}`);
  return { score: clampScore(risk), factors };
}

async function queryTasks(params, options = {}) {
  const now = nowSec();
  const settings = options.settings || (await runtime()).config;
  const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, Number(params.limit) || 25));
  const sort = ["priority", "scheduled", "created"].includes(params.sort) ? params.sort : "scheduled";
  const cursor = decodeCursor(params.cursor);
  const where = [];
  const values = { now, soon: now + 86400, uploadCost: appConfig.quota.uploadCost,
    quotaLimit: Math.floor(appConfig.quota.defaultDaily * appConfig.quota.burnFraction * (1 - (settings.quotaSafetyMargin || 0))),
    baseWeight: settings.weights.basePriority, deadlineWeight: settings.weights.deadline,
    quotaFitWeight: settings.weights.quotaFit, channelWeight: settings.weights.channelHealth,
    retryPenalty: settings.weights.retryPenalty, quotaRisk: settings.weights.quotaRisk };
  if (params.status && params.status !== "all") {
    if (!VALID_STATUSES.has(params.status)) throw Object.assign(new Error("Unsupported task status"), { status: 400 });
    const aliases = { queued: "pending", processing: "uploading", published: "done", cancelled: "deleted" };
    if (params.status === "waiting_approval") where.push("jobs.orchestrator_approval_status = 'waiting'");
    else if (params.status === "deferred") where.push("jobs.orchestrator_deferred_until > @now");
    else { where.push("jobs.status = @status"); values.status = aliases[params.status] || params.status; }
  }
  if (params.platform && params.platform !== "all") {
    if (!["youtube", "instagram", "facebook"].includes(params.platform)) throw Object.assign(new Error("Unsupported platform"), { status: 400 });
    where.push("jobs.platform = @platform"); values.platform = params.platform;
  }
  if (params.channelId) {
    where.push("(jobs.channel_id = @channelId OR jobs.instagram_account_id = @channelId OR jobs.facebook_page_id = @channelId)");
    values.channelId = String(params.channelId).slice(0, 200);
  }
  const from = parseDate(params.from, "from");
  const to = parseDate(params.to, "to", true);
  if (from !== null) { where.push("jobs.scheduled_at >= @from"); values.from = from; }
  if (to !== null) { where.push("jobs.scheduled_at <= @to"); values.to = to; }
  if (from !== null && to !== null && from > to) throw Object.assign(new Error("from must not be after to"), { status: 400 });
  if (params.priorityMin != null && params.priorityMin !== "") {
    values.priorityMin = Math.max(0, Math.min(100, Number(params.priorityMin)));
    if (!Number.isFinite(values.priorityMin)) throw Object.assign(new Error("Invalid minimum priority"), { status: 400 });
    where.push("jobs.priority >= @priorityMin");
  }
  if (params.priorityMax != null && params.priorityMax !== "") {
    values.priorityMax = Math.max(0, Math.min(100, Number(params.priorityMax)));
    if (!Number.isFinite(values.priorityMax)) throw Object.assign(new Error("Invalid maximum priority"), { status: 400 });
    where.push("jobs.priority <= @priorityMax");
  }
  if (params.campaignId) { where.push("jobs.campaign_id = @campaignId"); values.campaignId = String(params.campaignId).slice(0, 160); }
  if (params.search) {
    values.search = `%${String(params.search).slice(0, 160).toLowerCase()}%`;
    where.push("(LOWER(jobs.title) LIKE @search OR LOWER(COALESCE(jobs.description, '')) LIKE @search)");
  }

  const urgencyExpression = `(CASE WHEN jobs.scheduled_at <= @now THEN @deadlineWeight WHEN jobs.scheduled_at <= @now + 3600 THEN @deadlineWeight * 0.8 WHEN jobs.scheduled_at <= @soon THEN @deadlineWeight * 0.5 ELSE 0 END)`;
  const liveQuotaUsed = `(CASE WHEN COALESCE(channels.quota_reset_at, 0) <= @now THEN 0 ELSE COALESCE(channels.quota_used, 0) END)`;
  const quotaFitExpression = `(CASE WHEN jobs.platform = 'youtube' AND ${liveQuotaUsed} + @uploadCost <= @quotaLimit THEN @quotaFitWeight ELSE 0 END)`;
  const healthExpression = `(CASE WHEN COALESCE(channels.active, instagram_accounts.active, facebook_pages.active, 0) = 1 THEN @channelWeight ELSE 0 END)`;
  const riskExpression = `((jobs.retry_count * @retryPenalty) + (CASE WHEN COALESCE(channels.active, instagram_accounts.active, facebook_pages.active, 0) = 0 THEN @quotaRisk ELSE 0 END) + (CASE WHEN jobs.platform = 'youtube' AND ${liveQuotaUsed} + @uploadCost > @quotaLimit THEN @quotaRisk ELSE 0 END))`;
  const campaignExpression = `(CASE WHEN jobs.campaign_id IS NOT NULL AND jobs.campaign_id <> '' THEN @campaignWeight ELSE 0 END)`;
  values.campaignWeight = settings.weights.campaignContinuity || 0;
  let preferenceExpression = "0";
  if (settings.platformOrder?.length) {
    const cases = settings.platformOrder.map((platform, index) => {
      values[`preferredPlatform${index}`] = platform;
      return `WHEN jobs.platform = @preferredPlatform${index} THEN ${(settings.platformOrder.length - index) * 2}`;
    });
    preferenceExpression = `(CASE ${cases.join(" ")} ELSE 0 END)`;
  }
  const scoreExpression = `((CASE WHEN jobs.priority * @baseWeight >= 100 THEN 0 ELSE 100 - jobs.priority * @baseWeight END) + ${urgencyExpression} + ${quotaFitExpression} + ${healthExpression} + ${campaignExpression} + ${preferenceExpression} - ${riskExpression})`;
  let cursorWhere = "";
  if (cursor) {
    if (sort === "priority") {
      cursorWhere = "WHERE priority_score < @cursorScore OR (priority_score = @cursorScore AND (scheduled_at > @cursorScheduled OR (scheduled_at = @cursorScheduled AND id > @cursorId)))";
      values.cursorScore = Number(cursor.score); values.cursorScheduled = Number(cursor.scheduledAt); values.cursorId = String(cursor.id || "");
    } else if (sort === "created") {
      cursorWhere = "WHERE created_at < @cursorCreated OR (created_at = @cursorCreated AND id > @cursorId)";
      values.cursorCreated = Number(cursor.createdAt); values.cursorId = String(cursor.id || "");
    } else {
      cursorWhere = "WHERE scheduled_at > @cursorScheduled OR (scheduled_at = @cursorScheduled AND id > @cursorId)";
      values.cursorScheduled = Number(cursor.scheduledAt); values.cursorId = String(cursor.id || "");
    }
  }
  const orderBy = sort === "priority" ? "priority_score DESC, scheduled_at ASC, id ASC"
    : sort === "created" ? "created_at DESC, id ASC" : "scheduled_at ASC, id ASC";
  values.limit = limit + 1;
  const sql = `WITH enriched AS (
    SELECT jobs.*, channels.id AS selected_channel_id, channels.name AS channel_name, channels.active AS youtube_active,
      channels.quota_used, channels.quota_reset_at,
      instagram_accounts.username AS instagram_username, instagram_accounts.active AS instagram_active,
      facebook_pages.name AS facebook_page_name, facebook_pages.active AS facebook_active,
      CASE WHEN COALESCE(destination_control.paused, 0) = 1 THEN 0 ELSE COALESCE(channels.active, instagram_accounts.active, facebook_pages.active, 0) END AS destination_active,
      ${scoreExpression} AS priority_score,
      (SELECT action_type FROM orchestrator_actions a WHERE a.job_id = jobs.id ORDER BY a.created_at DESC LIMIT 1) AS latest_action_type,
      (SELECT reason FROM orchestrator_actions a WHERE a.job_id = jobs.id ORDER BY a.created_at DESC LIMIT 1) AS latest_action_reason,
      (SELECT current_step FROM job_workflow_state w WHERE w.job_id = jobs.id LIMIT 1) AS workflow_step
      , (SELECT workflow_id FROM job_workflow_state w WHERE w.job_id = jobs.id LIMIT 1) AS workflow_id
    FROM jobs
      LEFT JOIN channels ON channels.id = COALESCE(jobs.channel_id, CASE WHEN jobs.platform = 'youtube' THEN
        (SELECT c2.id FROM channels c2 LEFT JOIN orchestrator_channel_controls cc ON cc.platform = 'youtube' AND cc.channel_id = c2.id
          WHERE c2.active = 1 AND COALESCE(cc.paused, 0) = 0 AND
            (c2.quota_reset_at <= @now OR c2.quota_used + @uploadCost <= @quotaLimit)
          ORDER BY CASE WHEN c2.quota_reset_at <= @now THEN 0 ELSE c2.quota_used END ASC, c2.last_used_at ASC LIMIT 1)
        ELSE NULL END)
      LEFT JOIN instagram_accounts ON instagram_accounts.id = jobs.instagram_account_id
      LEFT JOIN facebook_pages ON facebook_pages.id = jobs.facebook_page_id
      LEFT JOIN orchestrator_channel_controls destination_control ON destination_control.platform = jobs.platform
        AND destination_control.channel_id = COALESCE(channels.id, instagram_accounts.id, facebook_pages.id)
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
  ) SELECT * FROM enriched ${cursorWhere} ORDER BY ${orderBy} LIMIT @limit`;
  const found = await db.prepare(sql).all(values);
  const hasMore = found.length > limit;
  const pageRows = hasMore ? found.slice(0, limit) : found;
  const quotaLimit = values.quotaLimit;
  const tasks = pageRows.map((row) => {
    row.file_exists = safeFileExists(row.filename) ? 1 : 0;
    const platform = row.platform || "youtube";
    const destinationActive = Number(row.destination_active) === 1;
    const currentQuotaUsed = Number(row.quota_reset_at || 0) <= now ? 0 : Number(row.quota_used || 0);
    const remainingQuota = platform === "youtube" ? Math.max(0, quotaLimit - currentQuotaUsed) : null;
    const risk = calculateRisk(row, now, quotaLimit);
    const base = 100 - Math.min(100, Math.max(0, Number(row.priority || 0)) * settings.weights.basePriority);
    let urgency = 0;
    if (Number(row.scheduled_at) <= now) urgency = settings.weights.deadline;
    else if (Number(row.scheduled_at) <= now + 3600) urgency = settings.weights.deadline * 0.8;
    else if (Number(row.scheduled_at) <= now + 86400) urgency = settings.weights.deadline * 0.5;
    const quotaFit = platform === "youtube" && remainingQuota >= appConfig.quota.uploadCost ? settings.weights.quotaFit : 0;
    const health = destinationActive ? settings.weights.channelHealth : 0;
    const preference = Math.max(0, (settings.platformOrder || []).length - (settings.platformOrder || []).indexOf(platform)) * 2;
    const overQuota = platform === "youtube" && remainingQuota < appConfig.quota.uploadCost;
    const priorityPenalty = (Number(row.retry_count || 0) * settings.weights.retryPenalty)
      + (!destinationActive ? settings.weights.quotaRisk : 0)
      + (overQuota ? settings.weights.quotaRisk : 0)
      + (!row.file_exists ? settings.weights.quotaRisk : 0);
    const priorityScore = clampScore(base + urgency + quotaFit + health + preference + (row.campaign_id ? settings.weights.campaignContinuity : 0) - priorityPenalty);
    let suggestedWindow;
    if (!destinationActive) suggestedWindow = "Reconnect destination first";
    else if (!row.file_exists) suggestedWindow = "Restore the media file first";
    else if (platform === "youtube" && remainingQuota < appConfig.quota.uploadCost) suggestedWindow = new Date(Math.max(now, Number(row.quota_reset_at || now) * 1000)).toISOString();
    else if (Number(row.scheduled_at) > now) suggestedWindow = new Date(Number(row.scheduled_at) * 1000).toISOString();
    else suggestedWindow = "Ready when the upload worker is available";
    const destinationName = platform === "instagram" ? (row.instagram_username ? `@${row.instagram_username}` : "Instagram account")
      : platform === "facebook" ? (row.facebook_page_name || "Facebook Page") : (row.channel_name || "YouTube channel");
    return {
      id: row.id, title: row.title, description: row.description, tags: row.tags, privacy: row.privacy,
      filename: row.filename, platform, format: row.format,
      status: row.status === "pending" && row.orchestrator_approval_status === "waiting" ? "waiting_approval" : row.status,
      approvalStatus: row.orchestrator_approval_status || "approved", selectedAt: Number(row.orchestrator_selected_at || 0),
      channelId: row.channel_id || row.selected_channel_id || row.instagram_account_id || row.facebook_page_id,
      channelName: destinationName, destinationActive, scheduledAt: Number(row.scheduled_at),
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), priority: Number(row.priority || 0),
      priorityScore, priorityBreakdown: { base, urgency, quotaFit, channelHealth: health, platformPreference: preference,
        campaignContinuity: row.campaign_id ? settings.weights.campaignContinuity : 0, penalties: priorityPenalty },
      riskScore: risk.score, riskFactors: risk.factors,
      estimatedQuotaCost: platform === "youtube" ? appConfig.quota.uploadCost : null,
      remainingQuota, quotaResetAt: Number(row.quota_reset_at || 0),
      retryCount: Number(row.retry_count || 0), lastError: row.last_error || "",
      fileExists: Boolean(row.file_exists), campaignId: row.campaign_id || null,
      workflowStep: row.workflow_step == null ? null : Number(row.workflow_step),
      workflowId: row.workflow_id || null,
      suggestedWindow,
      latestAction: row.latest_action_type ? { type: row.latest_action_type, reason: row.latest_action_reason || "" } : null,
    };
  });
  const last = pageRows.at(-1);
  const nextCursor = hasMore && last ? encodeCursor(sort === "priority"
    ? { score: Number(last.priority_score), scheduledAt: Number(last.scheduled_at), id: last.id }
    : sort === "created" ? { createdAt: Number(last.created_at), id: last.id }
      : { scheduledAt: Number(last.scheduled_at), id: last.id }) : null;
  return { tasks, nextCursor, sort, limit };
}

router.get("/state", async (_req, res) => {
  try {
    const row = await runtime();
    const summary = await db.prepare(`SELECT
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'uploading' THEN 1 ELSE 0 END) AS uploading,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status = 'exhausted' THEN 1 ELSE 0 END) AS exhausted,
      SUM(CASE WHEN status = 'pending' AND orchestrator_approval_status = 'waiting' THEN 1 ELSE 0 END) AS waiting_approval,
      SUM(CASE WHEN status = 'pending' AND orchestrator_selected_at IS NOT NULL THEN 1 ELSE 0 END) AS selected
      FROM jobs WHERE status <> 'deleted'`).get();
    res.json({ mode: row.mode, state: row.state, lastCycleAt: row.last_cycle_at ? Number(row.last_cycle_at) : null,
      config: row.config, summary: Object.fromEntries(Object.entries(summary || {}).map(([key, value]) => [key, Number(value || 0)])) });
  } catch (error) { res.status(500).json({ error: error.message || "Could not load task viewer state" }); }
});

router.get("/tasks", async (req, res) => {
  try {
    const result = await queryTasks(req.query);
    res.json({ ...result, generatedAt: nowSec() });
  } catch (error) { res.status(error.status || 500).json({ error: error.message || "Could not query tasks" }); }
});

router.get("/channels", async (_req, res) => {
  try {
    const [channels, instagram, facebook, controls] = await Promise.all([
      db.prepare(`SELECT id, name, active, quota_used, quota_reset_at FROM channels ORDER BY name`).all(),
      db.prepare(`SELECT id, username AS name, active FROM instagram_accounts ORDER BY username`).all(),
      db.prepare(`SELECT id, name, active FROM facebook_pages ORDER BY name`).all(),
      db.prepare(`SELECT platform, channel_id, paused, reason, updated_at FROM orchestrator_channel_controls`).all(),
    ]);
    const controlMap = new Map(controls.map((item) => [`${item.platform}:${item.channel_id}`, item]));
    const limit = Math.floor(appConfig.quota.defaultDaily * appConfig.quota.burnFraction);
    const youtubeRows = channels.map((channel) => {
      const control = controlMap.get(`youtube:${channel.id}`);
      const used = Number(channel.quota_reset_at) <= nowSec() ? 0 : Number(channel.quota_used || 0);
      return { platform: "youtube", id: channel.id, name: channel.name, active: Boolean(channel.active), paused: Number(control?.paused) === 1,
        reason: control?.reason || "", quotaUsed: used, quotaLimit: limit, quotaRemaining: Math.max(0, limit - used), quotaResetAt: Number(channel.quota_reset_at || 0), sharedUnitsRemaining: null };
    });
    const otherRows = [...instagram.map((item) => ({ ...item, platform: "instagram" })), ...facebook.map((item) => ({ ...item, platform: "facebook" }))].map((item) => {
      const control = controlMap.get(`${item.platform}:${item.id}`);
      return { ...item, active: Boolean(item.active), paused: Number(control?.paused) === 1, reason: control?.reason || "", quotaUsed: null, quotaLimit: null, quotaRemaining: null, quotaResetAt: null, sharedUnitsRemaining: null };
    });
    res.json([...youtubeRows, ...otherRows]);
  } catch (error) { res.status(500).json({ error: error.message || "Could not load channel controls" }); }
});

router.post("/channels/:platform/:id/:action", async (req, res) => {
  const { platform, id, action } = req.params;
  if (!["youtube", "instagram", "facebook"].includes(platform) || !["pause", "resume"].includes(action)) {
    return res.status(400).json({ error: "Unsupported channel control" });
  }
  try {
    const paused = action === "pause" ? 1 : 0;
    const reason = paused ? String(req.body?.reason || "Paused by operator").slice(0, 300) : null;
    const now = nowSec();
    await db.prepare(`INSERT INTO orchestrator_channel_controls (platform, channel_id, paused, reason, updated_at)
      VALUES (@platform, @id, @paused, @reason, @now) ON CONFLICT(platform, channel_id) DO UPDATE SET
      paused = excluded.paused, reason = excluded.reason, updated_at = excluded.updated_at`)
      .run({ platform, id, paused, reason, now });
    await writeAction({ actionType: paused ? "channel_paused" : "channel_resumed", actor: "operator", result: "success",
      reason: reason || `Resumed ${platform} destination`, details: { platform, channelId: id } });
    res.json({ success: true, platform, channelId: id, paused: Boolean(paused) });
  } catch (error) { res.status(500).json({ error: error.message || "Could not update channel control" }); }
});

router.get("/workflows", async (_req, res) => {
  try {
    const rows = await db.prepare("SELECT * FROM orchestrator_workflows ORDER BY name").all();
    res.json(rows.map((row) => ({ ...row, active: Boolean(row.active), definition: (() => { try { return JSON.parse(row.definition); } catch { return []; } })() })));
  } catch (error) { res.status(500).json({ error: error.message || "Could not load workflows" }); }
});

router.post("/workflows", async (req, res) => {
  const name = String(req.body?.name || "").trim().slice(0, 120);
  const definition = req.body?.definition;
  if (!name || !Array.isArray(definition) || definition.length > 20 || definition.some((step) => !step || typeof step !== "object" || !WORKFLOW_ACTIONS.has(step.action))) {
    return res.status(400).json({ error: "Workflow needs a name and up to 20 supported steps: validate, upload, wait_processing, set_visibility, cross_post, reschedule, or playlist" });
  }
  try {
    const now = nowSec(), id = randomUUID();
    await db.prepare(`INSERT INTO orchestrator_workflows (id, name, definition, active, created_at, updated_at)
      VALUES (@id, @name, @definition, 1, @now, @now)`).run({ id, name, definition: JSON.stringify(definition), now });
    await writeAction({ actionType: "workflow_created", actor: "operator", result: "success", reason: `Workflow ${name} created`, details: { workflowId: id } });
    res.status(201).json({ id, name, definition, active: true });
  } catch (error) { res.status(500).json({ error: error.message || "Could not save workflow" }); }
});

router.patch("/workflows/:id", async (req, res) => {
  try {
    const current = await db.prepare("SELECT * FROM orchestrator_workflows WHERE id = @id").get({ id: req.params.id });
    if (!current) return res.status(404).json({ error: "Workflow not found" });
    const name = req.body?.name == null ? current.name : String(req.body.name).trim().slice(0, 120);
    const definition = req.body?.definition == null ? JSON.parse(current.definition || "[]") : req.body.definition;
    if (!name || !Array.isArray(definition) || definition.length > 20 || definition.some((step) => !step || typeof step !== "object" || !WORKFLOW_ACTIONS.has(step.action))) {
      return res.status(400).json({ error: "Workflow needs a name and up to 20 supported steps: validate, upload, wait_processing, set_visibility, cross_post, reschedule, or playlist" });
    }
    const active = req.body?.active == null ? Number(current.active) : (req.body.active ? 1 : 0);
    await db.prepare("UPDATE orchestrator_workflows SET name = @name, definition = @definition, active = @active, updated_at = @now WHERE id = @id")
      .run({ id: req.params.id, name, definition: JSON.stringify(definition), active, now: nowSec() });
    await writeAction({ actionType: "workflow_updated", actor: "operator", result: "success", reason: `Workflow ${name} updated`, details: { workflowId: req.params.id } });
    res.json({ id: req.params.id, name, definition, active: Boolean(active) });
  } catch (error) { res.status(500).json({ error: error.message || "Could not update workflow" }); }
});

router.delete("/workflows/:id", async (req, res) => {
  try {
    const result = await db.prepare("DELETE FROM orchestrator_workflows WHERE id = @id").run({ id: req.params.id });
    if (!result.changes) return res.status(404).json({ error: "Workflow not found" });
    await writeAction({ actionType: "workflow_deleted", actor: "operator", result: "success", reason: "Workflow deleted", details: { workflowId: req.params.id } });
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message || "Could not delete workflow" }); }
});

router.get("/metrics", async (_req, res) => {
  try {
    const now = nowSec();
    const rows = await db.prepare("SELECT action_type, actor, result, details FROM orchestrator_actions WHERE created_at >= @since")
      .all({ since: now - 86400 });
    const counts = {};
    let cycleDurationMs = 0, cycleCount = 0, humanActions = 0;
    for (const row of rows) {
      counts[row.action_type] = (counts[row.action_type] || 0) + 1;
      if (row.actor === "operator") humanActions++;
      if (row.action_type === "cycle_completed") {
        try { cycleDurationMs += Number(JSON.parse(row.details || "{}").durationMs || 0); cycleCount++; } catch { /* malformed historical entry */ }
      }
    }
    const channels = await db.prepare("SELECT id, name, quota_used, quota_reset_at FROM channels WHERE active = 1 ORDER BY name").all();
    const quotaLimit = Math.floor(appConfig.quota.defaultDaily * appConfig.quota.burnFraction);
    res.json({ windowHours: 24, cycles: counts.cycle_completed || 0, selected: counts.selected || 0,
      executed: counts.executed || 0, deferred: counts.deferred || 0, failed: counts.execution_failed || 0,
      averageSelectionDurationMs: cycleCount ? Math.round(cycleDurationMs / cycleCount) : 0,
      humanInterventions: humanActions, humanInterventionRate: rows.length ? humanActions / rows.length : 0,
      quota: channels.map((channel) => {
        const used = Number(channel.quota_reset_at) <= now ? 0 : Number(channel.quota_used || 0);
        return { channelId: channel.id, channel: channel.name, used, limit: quotaLimit, remaining: Math.max(0, quotaLimit - used), resetsAt: Number(channel.quota_reset_at || 0) };
      }) });
  } catch (error) { res.status(500).json({ error: error.message || "Could not load orchestrator metrics" }); }
});

router.patch("/tasks/:id/priority", async (req, res) => {
  const priority = Number(req.body?.priority);
  if (!Number.isInteger(priority) || priority < 0 || priority > 100) return res.status(400).json({ error: "Priority must be an integer from 0 to 100" });
  try {
    const result = await db.prepare("UPDATE jobs SET priority = @priority, updated_at = @now WHERE id = @id AND status IN ('pending','failed','exhausted')")
      .run({ id: req.params.id, priority, now: nowSec() });
    if (!result.changes) return res.status(404).json({ error: "Task not found or its status cannot be reprioritized" });
    await writeAction({ jobId: req.params.id, actionType: "priority_overridden", actor: "operator", reason: `Base priority changed to ${priority}`, details: { priority } });
    res.json({ success: true, id: req.params.id, priority });
  } catch (error) { res.status(500).json({ error: error.message || "Could not update priority" }); }
});

router.patch("/tasks/:id/workflow", async (req, res) => {
  const workflowId = req.body?.workflowId ? String(req.body.workflowId) : "";
  try {
    const task = await db.prepare("SELECT id, status FROM jobs WHERE id = @id").get({ id: req.params.id });
    if (!task) return res.status(404).json({ error: "Task not found" });
    if (!workflowId) {
      await db.prepare("DELETE FROM job_workflow_state WHERE job_id = @jobId").run({ jobId: task.id });
      await writeAction({ jobId: task.id, actionType: "workflow_unassigned", actor: "operator", result: "success", reason: "Workflow unassigned from task" });
      return res.json({ success: true, jobId: task.id, workflowId: null });
    }
    const workflow = await db.prepare("SELECT id, name, active FROM orchestrator_workflows WHERE id = @id").get({ id: workflowId });
    if (!workflow || !workflow.active) return res.status(404).json({ error: "Active workflow not found" });
    const now = nowSec();
    await db.prepare(`INSERT INTO job_workflow_state (job_id, workflow_id, current_step, status, updated_at)
      VALUES (@jobId, @workflowId, 0, 'pending', @now) ON CONFLICT(job_id) DO UPDATE SET
      workflow_id = excluded.workflow_id, current_step = 0, status = 'pending', updated_at = excluded.updated_at`)
      .run({ jobId: task.id, workflowId, now });
    await writeAction({ jobId: task.id, actionType: "workflow_assigned", actor: "operator", result: "success",
      reason: `Workflow ${workflow.name} assigned to task`, details: { workflowId, workflowName: workflow.name } });
    res.json({ success: true, jobId: task.id, workflowId, currentStep: 0 });
  } catch (error) { res.status(500).json({ error: error.message || "Could not assign workflow" }); }
});

router.post("/tasks/:id/skip", async (req, res) => {
  try {
    const result = await db.prepare("UPDATE jobs SET status = 'deleted', updated_at = @now WHERE id = @id AND status = 'pending'")
      .run({ id: req.params.id, now: nowSec() });
    if (!result.changes) return res.status(409).json({ error: "Only pending tasks can be skipped" });
    await writeAction({ jobId: req.params.id, actionType: "cancelled", actor: "operator", reason: "Cancelled by operator", result: "cancelled" });
    res.json({ success: true, id: req.params.id, status: "deleted" });
  } catch (error) { res.status(500).json({ error: error.message || "Could not skip task" }); }
});

router.post("/tasks/:id/approve", async (req, res) => {
  try {
    const result = await db.prepare(`UPDATE jobs SET orchestrator_approval_status = 'approved', orchestrator_selected_at = @now,
      updated_at = @now WHERE id = @id AND status = 'pending' AND orchestrator_approval_status = 'waiting'`)
      .run({ id: req.params.id, now: nowSec() });
    if (!result.changes) return res.status(409).json({ error: "Task is not waiting for approval" });
    await writeAction({ jobId: req.params.id, actionType: "approved", actor: "operator", result: "approved", reason: "Task approved for the existing upload worker" });
    res.json({ success: true, id: req.params.id, approvalStatus: "approved" });
  } catch (error) { res.status(500).json({ error: error.message || "Could not approve task" }); }
});

router.post("/tasks/:id/reject", async (req, res) => {
  try {
    const reason = String(req.body?.reason || "Rejected by operator").slice(0, 500);
    const result = await db.prepare(`UPDATE jobs SET status = 'deleted', orchestrator_approval_status = 'rejected', updated_at = @now
      WHERE id = @id AND status = 'pending' AND orchestrator_approval_status = 'waiting'`).run({ id: req.params.id, now: nowSec() });
    if (!result.changes) return res.status(409).json({ error: "Task is not waiting for approval" });
    await writeAction({ jobId: req.params.id, actionType: "rejected", actor: "operator", result: "rejected", reason });
    res.json({ success: true, id: req.params.id, status: "deleted" });
  } catch (error) { res.status(500).json({ error: error.message || "Could not reject task" }); }
});

router.post("/tasks/:id/defer", async (req, res) => {
  try {
    const scheduledAt = parseDate(req.body?.deferUntil, "deferUntil");
    if (!scheduledAt || scheduledAt <= nowSec()) return res.status(400).json({ error: "Choose a future defer time" });
    const result = await db.prepare(`UPDATE jobs SET scheduled_at = @scheduledAt, next_retry_at = @scheduledAt,
      orchestrator_deferred_until = @scheduledAt, updated_at = @now WHERE id = @id AND status = 'pending'`)
      .run({ id: req.params.id, scheduledAt, now: nowSec() });
    if (!result.changes) return res.status(409).json({ error: "Only pending tasks can be deferred" });
    await writeAction({ jobId: req.params.id, actionType: "deferred_by_operator", actor: "operator", result: "deferred",
      reason: `Deferred until ${new Date(scheduledAt * 1000).toISOString()}`, details: { deferUntil: scheduledAt } });
    res.json({ success: true, id: req.params.id, scheduledAt });
  } catch (error) { res.status(error.status || 500).json({ error: error.message || "Could not defer task" }); }
});

router.post("/tasks/:id/force", async (req, res) => {
  try {
    const now = nowSec();
    const result = await db.prepare(`UPDATE jobs SET scheduled_at = @now, next_retry_at = @now,
      orchestrator_approval_status = 'approved', orchestrator_selected_at = @now,
      orchestrator_deferred_until = NULL, updated_at = @now WHERE id = @id AND status = 'pending'`).run({ id: req.params.id, now });
    if (!result.changes) return res.status(409).json({ error: "Only pending tasks can be force-executed" });
    await writeAction({ jobId: req.params.id, actionType: "force_execute", actor: "operator", result: "queued",
      reason: "Operator moved task to the front of the existing worker queue" });
    res.json({ success: true, id: req.params.id, scheduledAt: now });
  } catch (error) { res.status(500).json({ error: error.message || "Could not force task execution" }); }
});

router.patch("/config", async (req, res) => {
  try {
    const before = await runtime();
    const candidate = parseConfig({ ...before.config, ...(req.body || {}), weights: { ...before.config.weights, ...(req.body?.weights || {}) } });
    const mode = req.body?.mode || before.mode;
    if (!["monitor", "assisted", "automatic"].includes(mode)) return res.status(400).json({ error: "Mode must be monitor, assisted, or automatic" });
    if (mode === "automatic" && before.mode !== "automatic" && req.body?.confirmAutomatic !== true) {
      return res.status(409).json({ error: "Confirm automatic mode before enabling scheduled uploads through the orchestrator." });
    }
    const now = nowSec();
    await db.prepare("UPDATE orchestrator_runtime SET mode = @mode, config = @config, last_cycle_at = NULL, updated_at = @now WHERE workspace_id = @id")
      .run({ id: WORKSPACE_ID, mode, config: JSON.stringify(candidate), now });
    if (before.mode === "assisted" && mode !== "assisted") {
      await db.prepare(`UPDATE jobs SET orchestrator_approval_status = 'approved', orchestrator_selected_at = NULL
        WHERE status = 'pending' AND orchestrator_approval_status = 'waiting'`).run();
    } else if (mode === "assisted" && before.mode !== "assisted") {
      await db.prepare(`UPDATE jobs SET orchestrator_approval_status = 'waiting', orchestrator_selected_at = NULL
        WHERE status = 'pending'`).run();
    } else if (mode === "automatic" && before.mode !== "automatic") {
      await db.prepare(`UPDATE jobs SET orchestrator_approval_status = 'approved', orchestrator_selected_at = NULL
        WHERE status = 'pending'`).run();
    } else if (mode === "monitor" && before.mode !== "monitor") {
      await db.prepare(`UPDATE jobs SET orchestrator_approval_status = 'approved', orchestrator_selected_at = NULL
        WHERE status = 'pending'`).run();
    }
    await writeAction({ actionType: mode === before.mode ? "configuration_updated" : "mode_changed", actor: "operator", result: "success",
      reason: mode === before.mode ? "Task viewer rules changed" : `Operating mode changed from ${before.mode} to ${mode}`, details: { ...candidate, mode } });
    res.json({ mode, state: before.state, config: candidate });
  } catch (error) { res.status(error.status || 400).json({ error: error.message || "Could not update task viewer settings" }); }
});

router.post("/pause", async (_req, res) => setState("paused", res));
router.post("/resume", async (_req, res) => setState("monitoring", res));
async function setState(state, res) {
  try {
    const now = nowSec();
    await runtime();
    await db.prepare("UPDATE orchestrator_runtime SET state = @state, updated_at = @now WHERE workspace_id = @id")
      .run({ id: WORKSPACE_ID, state, now });
    await writeAction({ actionType: state === "paused" ? "paused" : "resumed", actor: "operator", result: "success", reason: `Orchestrator ${state}` });
    res.json({ state, message: `Orchestrator ${state}. The upload worker will honor this state on its next scheduling tick.` });
  } catch (error) { res.status(500).json({ error: error.message || "Could not change task viewer state" }); }
}

router.post("/cycle", async (_req, res) => {
  try {
    const result = await runOrchestratorCycle({ force: true, allowMonitorPreview: true });
    res.json(result);
  } catch (error) { res.status(error.status || 500).json({ error: error.message || "Selection preview failed" }); }
});

router.get("/actions", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 25));
    const cursor = decodeCursor(req.query.cursor);
    const where = ["a.workspace_id = @workspaceId"];
    const values = { workspaceId: WORKSPACE_ID, limit: limit + 1 };
    if (req.query.jobId) { where.push("a.job_id = @jobId"); values.jobId = String(req.query.jobId).slice(0, 200); }
    if (req.query.actionType) { where.push("a.action_type = @actionType"); values.actionType = String(req.query.actionType).slice(0, 80); }
    if (req.query.platform && ["youtube", "instagram", "facebook"].includes(req.query.platform)) {
      where.push("j.platform = @platform"); values.platform = req.query.platform;
    }
    if (req.query.channelId) {
      where.push("(j.channel_id = @channelId OR j.instagram_account_id = @channelId OR j.facebook_page_id = @channelId)");
      values.channelId = String(req.query.channelId).slice(0, 200);
    }
    const from = parseDate(req.query.from, "from");
    const to = parseDate(req.query.to, "to", true);
    if (from !== null) { where.push("a.created_at >= @from"); values.from = from; }
    if (to !== null) { where.push("a.created_at <= @to"); values.to = to; }
    if (from !== null && to !== null && from > to) throw Object.assign(new Error("from must not be after to"), { status: 400 });
    if (cursor) { where.push("(a.created_at < @createdAt OR (a.created_at = @createdAt AND a.id < @id))"); values.createdAt = Number(cursor.createdAt); values.id = String(cursor.id); }
    const rows = await db.prepare(`SELECT a.id, a.job_id, a.action_type, a.reason, a.details, a.created_at
      , a.actor, a.result
      FROM orchestrator_actions a LEFT JOIN jobs j ON j.id = a.job_id
      WHERE ${where.join(" AND ")} ORDER BY a.created_at DESC, a.id DESC LIMIT @limit`).all(values);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    res.json({ items: page.map((row) => ({ id: row.id, jobId: row.job_id, actionType: row.action_type, actor: row.actor, result: row.result, reason: row.reason,
      details: (() => { try { return JSON.parse(row.details || "{}"); } catch { return {}; } })(), createdAt: Number(row.created_at) })),
      nextCursor: hasMore && page.length ? encodeCursor({ createdAt: Number(page.at(-1).created_at), id: page.at(-1).id }) : null });
  } catch (error) { res.status(error.status || 500).json({ error: error.message || "Could not load action history" }); }
});

export default router;
