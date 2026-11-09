import { accessSync, constants } from "fs";
import { resolve, basename, sep } from "path";
import { randomUUID } from "crypto";
import { db, nowSec } from "../db.js";
import { config as appConfig } from "../config.js";

const WORKSPACE_ID = "default";
export const ORCHESTRATOR_DEFAULTS = {
  selectionIntervalSeconds: 60,
  maxTasksPerCycle: 5,
  fairness: true,
  platformOrder: ["youtube", "instagram", "facebook"],
  weights: { basePriority: 1, deadline: 30, quotaFit: 10, channelHealth: 15, retryPenalty: 5, quotaRisk: 15, campaignContinuity: 5 },
  quotaSafetyMargin: 0.1,
};

export function normalizeOrchestratorConfig(value) {
  let input = value;
  try { if (typeof input === "string") input = JSON.parse(input); } catch { input = {}; }
  const weights = { ...ORCHESTRATOR_DEFAULTS.weights, ...(input?.weights || {}) };
  for (const key of Object.keys(weights)) {
    const value = Number(weights[key]);
    weights[key] = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : ORCHESTRATOR_DEFAULTS.weights[key];
  }
  const platformOrder = Array.isArray(input?.platformOrder)
    ? input.platformOrder.filter((platform) => ["youtube", "instagram", "facebook"].includes(platform))
    : ORCHESTRATOR_DEFAULTS.platformOrder;
  const margin = Number(input?.quotaSafetyMargin ?? ORCHESTRATOR_DEFAULTS.quotaSafetyMargin);
  return {
    selectionIntervalSeconds: Math.max(15, Math.min(3600, Number(input?.selectionIntervalSeconds) || 60)),
    maxTasksPerCycle: Math.max(1, Math.min(100, Number(input?.maxTasksPerCycle) || 5)),
    fairness: input?.fairness !== false,
    platformOrder: [...new Set(platformOrder)],
    quotaSafetyMargin: Number.isFinite(margin) ? Math.max(0, Math.min(0.5, margin)) : ORCHESTRATOR_DEFAULTS.quotaSafetyMargin,
    weights,
  };
}

export async function getOrchestratorRuntime() {
  const now = nowSec();
  await db.prepare(`INSERT INTO orchestrator_runtime (workspace_id, mode, state, config, created_at, updated_at)
    VALUES (@id, 'monitor', 'monitoring', @config, @now, @now) ON CONFLICT(workspace_id) DO NOTHING`)
    .run({ id: WORKSPACE_ID, config: JSON.stringify(ORCHESTRATOR_DEFAULTS), now });
  const row = await db.prepare("SELECT * FROM orchestrator_runtime WHERE workspace_id = @id").get({ id: WORKSPACE_ID });
  return { ...row, mode: row.mode || "monitor", state: row.state || "monitoring", config: normalizeOrchestratorConfig(row.config) };
}

export async function recordOrchestratorAction({ jobId = null, actionType, actor = "orchestrator", result = "info", reason, details = {} }) {
  await db.prepare(`INSERT INTO orchestrator_actions (id, workspace_id, job_id, action_type, actor, result, reason, details, created_at)
    VALUES (@id, @workspaceId, @jobId, @actionType, @actor, @result, @reason, @details, @createdAt)`)
    .run({ id: randomUUID(), workspaceId: WORKSPACE_ID, jobId, actionType, actor, result, reason,
      details: JSON.stringify(details), createdAt: nowSec() });
}

function fileReady(filename) {
  if (!filename || basename(filename) !== filename) return false;
  const root = resolve(appConfig.storageRoot), path = resolve(root, filename);
  if (!path.startsWith(`${root}${sep}`)) return false;
  try { accessSync(path, constants.R_OK); return true; } catch { return false; }
}

function scoreTask(task, now, settings, quotaLimit) {
  const remaining = task.platform === "youtube" ? Math.max(0, quotaLimit - Number(task.quota_used || 0)) : null;
  const factors = [];
  if (!Number(task.destination_active)) factors.push("Destination is inactive");
  if (!task.file_ready) factors.push("Media file is missing or unreadable");
  if (task.platform === "youtube" && remaining < appConfig.quota.uploadCost) factors.push("Insufficient YouTube quota");
  if (Number(task.retry_count)) factors.push(`${task.retry_count} previous retries`);
  const until = Number(task.scheduled_at) - now;
  const w = settings.weights;
  const base = 100 - Math.min(100, Math.max(0, Number(task.priority || 0)) * w.basePriority);
  const deadline = until <= 0 ? w.deadline : until <= 3600 ? w.deadline * 0.8 : until <= 86400 ? w.deadline * 0.5 : 0;
  const quotaFit = task.platform === "youtube" && remaining >= appConfig.quota.uploadCost ? w.quotaFit : 0;
  const health = Number(task.destination_active) ? w.channelHealth : 0;
  const preference = Math.max(0, settings.platformOrder.length - settings.platformOrder.indexOf(task.platform)) * 2;
  const continuity = task.campaign_id ? w.campaignContinuity : 0;
  const quotaRisk = task.platform === "youtube" && remaining < appConfig.quota.uploadCost ? w.quotaRisk : 0;
  const penalty = Number(task.retry_count || 0) * w.retryPenalty + quotaRisk + (task.file_ready ? 0 : w.quotaRisk) + (Number(task.destination_active) ? 0 : w.quotaRisk);
  return { score: Math.max(0, Math.min(100, Math.round(base + deadline + quotaFit + health + preference + continuity - penalty))), remaining, factors };
}

export async function runOrchestratorCycle({ force = false, allowMonitorPreview = false } = {}) {
  const runtime = await getOrchestratorRuntime();
  const mode = runtime.mode;
  const state = runtime.state;
  if (state === "paused") throw Object.assign(new Error("Resume the orchestrator before running a cycle"), { status: 409 });
  const settings = runtime.config;
  const now = nowSec();
  if (!force && runtime.last_cycle_at && now - Number(runtime.last_cycle_at) < settings.selectionIntervalSeconds) {
    return { skipped: true, reason: "Selection interval has not elapsed", selected: [], deferred: 0, considered: 0, executed: 0 };
  }
  if (mode === "monitor" && !allowMonitorPreview) return { skipped: true, reason: "Monitor-only mode does not select tasks for execution", selected: [], deferred: 0, considered: 0, executed: 0 };
  const started = Date.now();
  const quotaLimit = Math.floor(appConfig.quota.defaultDaily * appConfig.quota.burnFraction * (1 - settings.quotaSafetyMargin));
  const rows = await db.prepare(`SELECT j.*, COALESCE(c.name, ia.username, fp.name) AS destination_name,
    CASE WHEN COALESCE(ctl.paused, 0) = 1 THEN 0 ELSE COALESCE(c.active, ia.active, fp.active, 0) END AS destination_active,
    CASE WHEN COALESCE(c.quota_reset_at, 0) <= @now THEN 0 ELSE COALESCE(c.quota_used, 0) END AS quota_used, c.quota_reset_at,
    COALESCE(c.id, ia.id, fp.id) AS target_channel_id
    FROM jobs j
    LEFT JOIN channels c ON c.id = COALESCE(j.channel_id, CASE WHEN j.platform = 'youtube' THEN
      (SELECT c2.id FROM channels c2 LEFT JOIN orchestrator_channel_controls cc ON cc.platform = 'youtube' AND cc.channel_id = c2.id
        WHERE c2.active = 1 AND COALESCE(cc.paused, 0) = 0 AND
          (c2.quota_reset_at <= @now OR c2.quota_used + @uploadCost <= @quotaLimit)
        ORDER BY CASE WHEN c2.quota_reset_at <= @now THEN 0 ELSE c2.quota_used END ASC, c2.last_used_at ASC LIMIT 1)
      ELSE NULL END)
    LEFT JOIN instagram_accounts ia ON ia.id = j.instagram_account_id
    LEFT JOIN facebook_pages fp ON fp.id = j.facebook_page_id
    LEFT JOIN orchestrator_channel_controls ctl ON ctl.platform = j.platform AND ctl.channel_id = COALESCE(c.id, ia.id, fp.id)
    WHERE j.status = 'pending' AND j.scheduled_at <= @end
      AND (j.orchestrator_deferred_until IS NULL OR j.orchestrator_deferred_until <= @now)`)
    .all({ now, end: now + 30 * 86400, uploadCost: appConfig.quota.uploadCost, quotaLimit });
  const tasks = rows.map((row) => {
    row.file_ready = fileReady(row.filename) ? 1 : 0;
    const calculated = scoreTask(row, now, settings, quotaLimit);
    return { ...row, ...calculated, channelId: row.target_channel_id || row.platform };
  }).sort((a, b) => b.score - a.score || Number(a.scheduled_at) - Number(b.scheduled_at) || String(a.id).localeCompare(String(b.id)));
  const deferredTasks = tasks.filter((task) => !Number(task.destination_active) || !task.file_ready ||
    (task.platform === "youtube" && task.remaining < appConfig.quota.uploadCost));
  const eligible = tasks.filter((task) => !deferredTasks.includes(task));
  const selected = [];
  const usageByChannel = new Map();
  if (settings.fairness) {
    const queues = new Map();
    for (const task of eligible) {
      const queue = queues.get(task.channelId) || [];
      queue.push(task); queues.set(task.channelId, queue);
    }
    while (selected.length < settings.maxTasksPerCycle && queues.size) {
      let advanced = false;
      for (const [channelId, queue] of [...queues]) {
        if (selected.length >= settings.maxTasksPerCycle) break;
        const task = queue.shift();
        if (!queue.length) queues.delete(channelId);
        if (!task) continue;
        const used = usageByChannel.get(channelId) || 0;
        if (task.platform === "youtube" && used + appConfig.quota.uploadCost > task.remaining) {
          deferredTasks.push({ ...task, deferReason: "Selected tasks would exceed remaining channel quota" });
          continue;
        }
        if (task.platform === "youtube") usageByChannel.set(channelId, used + appConfig.quota.uploadCost);
        selected.push(task); advanced = true;
      }
      if (!advanced) break;
    }
  } else {
    for (const task of eligible) {
      if (selected.length >= settings.maxTasksPerCycle) break;
      const used = usageByChannel.get(task.channelId) || 0;
      if (task.platform === "youtube" && used + appConfig.quota.uploadCost > task.remaining) {
        deferredTasks.push({ ...task, deferReason: "Selected tasks would exceed remaining channel quota" }); continue;
      }
      if (task.platform === "youtube") usageByChannel.set(task.channelId, used + appConfig.quota.uploadCost);
      selected.push(task);
    }
  }
  const actual = mode !== "monitor";
  if (mode === "assisted") {
    // Newly created work is gated before the worker's due-job query. Previously approved tasks remain approved.
    await db.prepare(`UPDATE jobs SET orchestrator_approval_status = 'waiting'
      WHERE status = 'pending' AND orchestrator_approval_status = 'approved' AND orchestrator_selected_at IS NULL`).run();
  }
  if (mode === "automatic") await db.prepare("UPDATE jobs SET orchestrator_selected_at = NULL WHERE status = 'pending'").run();
  for (const task of selected) {
    if (actual) await db.prepare(`UPDATE jobs SET orchestrator_selected_at = @now,
      orchestrator_approval_status = CASE WHEN @mode = 'assisted' AND orchestrator_approval_status <> 'approved' THEN 'waiting' ELSE orchestrator_approval_status END
      WHERE id = @id AND status = 'pending'`).run({ id: task.id, now, mode });
    await recordOrchestratorAction({ jobId: task.id, actionType: "selected", actor: "orchestrator", result: mode === "assisted" ? "approval_required" : "preview",
      reason: mode === "monitor" ? "Rule-based monitor preview; not executed" : mode === "assisted" ? "Selected and waiting for operator approval" : "Selected for the existing upload worker",
      details: { priorityScore: task.score, riskFactors: task.factors, channelId: task.channelId, mode } });
  }
  const selectedIds = new Set(selected.map((task) => task.id));
  const deferredIds = new Set(deferredTasks.map((task) => task.id));
  const excluded = eligible.filter((task) => !selectedIds.has(task.id) && !deferredIds.has(task.id));
  for (const task of deferredTasks) await recordOrchestratorAction({ jobId: task.id, actionType: "deferred", actor: "orchestrator", result: "deferred",
    reason: task.deferReason || task.factors[0] || "Task did not pass selection guardrails", details: { priorityScore: task.score, channelId: task.channelId } });
  for (const task of excluded) await recordOrchestratorAction({ jobId: task.id, actionType: "deferred", actor: "orchestrator", result: "deferred",
    reason: "Outside the maximum tasks for this selection cycle", details: { priorityScore: task.score, channelId: task.channelId } });
  await db.prepare("UPDATE orchestrator_runtime SET last_cycle_at = @now, updated_at = @now WHERE workspace_id = @id").run({ id: WORKSPACE_ID, now });
  const durationMs = Date.now() - started;
  await recordOrchestratorAction({ actionType: "cycle_completed", actor: "orchestrator", result: "success", reason: `${mode} selection cycle completed`,
    details: { mode, considered: tasks.length, selected: selected.length, deferred: deferredTasks.length + excluded.length, durationMs } });
  return { mode, selected: selected.map((task) => ({ id: task.id, title: task.title, priorityScore: task.score, riskFactors: task.factors, channelId: task.channelId })),
    deferred: deferredTasks.length + excluded.length, considered: tasks.length, executed: 0, completedAt: now, durationMs };
}

export async function channelIsPaused(platform, channelId) {
  if (!channelId) return false;
  const row = await db.prepare("SELECT paused FROM orchestrator_channel_controls WHERE platform = @platform AND channel_id = @channelId").get({ platform, channelId });
  return Number(row?.paused) === 1;
}
