/**
 * The scheduler worker (see README "How it avoids rate limiting").
 *
 * Runs as its own process (`npm run worker`) — separate from the API so long
 * uploads never block request handling, and it can scale to multiple instances
 * (each grabs DB row locks via claimJob). All DB access is async & unified across
 * the SQLite (host/tests) and PostgreSQL (Docker) drivers.
 */
import { config } from "../config.js";
import { queries, nowSec, getDb } from "../db.js";
import { uploadJob } from "./youtube-upload.js";
import { publishReel } from "./instagram.js";
import { publishFacebookVideo } from "./facebook.js";
import { RateLimitError, AuthError, FatalUploadError, SchedulerError } from "./errors.js";
import { getOrchestratorRuntime, runOrchestratorCycle, channelIsPaused, recordOrchestratorAction } from "./task-orchestrator.js";
import { access, realpath, stat } from "fs/promises";
import { constants as fsConstants } from "fs";
import { basename, resolve, sep } from "path";

const state = {
  active: new Set(), // { id, channelId, promise }
  byChannel: new Map(), // channelId -> in-flight count
  running: false,
};

export function concurrencySnapshot() {
  const by = {};
  for (const [k, v] of state.byChannel) by[k] = v;
  return { active: state.active.size, max: config.worker.maxConcurrent, byChannel: by };
}

function inFlight(channelId) {
  return state.byChannel.get(channelId) || 0;
}

function canRunAnother() {
  return state.active.size < config.worker.maxConcurrent;
}

function hasBudget(channel) {
  const now = nowSec();
  if (channel.quota_reset_at <= now) return true;
  const budget = config.quota.defaultDaily * config.quota.burnFraction;
  return channel.quota_used + config.quota.uploadCost <= budget;
}

/** Refresh daily quota budgets for channels whose reset time has passed. */
export async function refreshBudgets() {
  const now = nowSec();
  await queries.tickAllBudgets.run({ reset: now + 86400, now });
}

/** Pick a channel with budget AND a free per-channel slot. Returns null if none. */
async function resolveChannel(job) {
  if (job.platform === "instagram") {
    if (await channelIsPaused("instagram", job.instagram_account_id)) return null;
    const account = await queries.findInstagramAccount.get({ id: job.instagram_account_id });
    if (!account?.active) return null;
    if (inFlight(`instagram:${account.id}`) >= config.worker.perChannelMaxConcurrent) return null;
    return account;
  }
  if (job.platform === "facebook") {
    if (await channelIsPaused("facebook", job.facebook_page_id)) return null;
    const page = await queries.findFacebookPage.get({ id: job.facebook_page_id });
    if (!page?.active) return null;
    if (inFlight(`facebook:${page.id}`) >= config.worker.perChannelMaxConcurrent) return null;
    return page;
  }
  const channels = await queries.listActiveChannels.all();
  for (const ch of channels) {
    if (job.channel_id && ch.id !== job.channel_id) continue;
    if (await channelIsPaused("youtube", ch.id)) continue;
    if (!hasBudget(ch)) continue;
    if (inFlight(ch.id) >= config.worker.perChannelMaxConcurrent) continue;
    return ch;
  }
  return null;
}

function backoffFor(retryCount) {
  const base = config.quota.backoffBase;
  const exp = Math.min(config.quota.backoffMax, base * Math.pow(2, retryCount));
  const jitter = Math.floor(Math.random() * Math.min(base, 10));
  return Math.round(exp) + jitter;
}

/** Claim a job (optimistic lock) and start its upload fire-and-forget. */
async function dispatch(job, channel) {
  const claimed = await queries.claimJob.get({ id: job.id, now: nowSec() });
  if (!claimed) return { skipped: true }; // lost the race to another tick/worker

  const key = job.platform === "instagram" ? `instagram:${channel.id}`
    : job.platform === "facebook" ? `facebook:${channel.id}` : channel.id;
  const entry = { id: claimed.id, channelKey: key, promise: null };
  state.active.add(entry);
  state.byChannel.set(key, inFlight(key) + 1);

  const cleanup = () => {
    state.active.delete(entry);
    const remaining = inFlight(key) - 1;
    if (remaining <= 0) state.byChannel.delete(key);
    else state.byChannel.set(key, remaining);
  };

  entry.promise = runUpload(claimed, channel).finally(cleanup);
  return { dispatched: claimed.id };
}

async function runUpload(job, channel) {
  const now = nowSec();
  const audit = (actionType, result, reason, details = {}) => recordOrchestratorAction({ jobId: job.id, actionType, actor: "worker", result, reason, details }).catch((error) => console.error("[audit] failed to record upload action:", error));
  try {
    const validationErrors = await validateClaimedJob(job);
    if (validationErrors.length) {
      const reason = validationErrors.join("; ");
      await queries.setJobStatus.run({ id: job.id, status: "failed", retryCount: job.retry_count || 0,
        nextRetryAt: null, lastError: reason, updatedAt: nowSec() });
      await audit("execution_failed", "validation_failed", reason, { platform: job.platform || "youtube", validationErrors });
      console.warn(`[validation] ${job.id}: ${reason}`);
      return;
    }
    if (job.platform === "instagram") {
      const result = await publishReel(job, channel);
      await queries.insertInstagramUpload.run({
        id: crypto.randomUUID(),
        jobId: job.id,
        mediaId: result.mediaId,
        permalink: result.permalink,
        created: now,
      });
      await queries.markDone.run({ id: job.id, retryCount: job.retry_count, updatedAt: now });
      await audit("executed", "published", "Instagram Reel published", { platform: "instagram", destinationId: channel.id });
      console.log(`[ready] Instagram Reel "${job.title}" published for @${channel.username}`);
      return;
    }
    if (job.platform === "facebook") {
      const result = await publishFacebookVideo(job, channel);
      await queries.insertFacebookUpload.run({
        id: crypto.randomUUID(),
        jobId: job.id,
        videoId: result.videoId,
        permalink: result.permalink,
        created: now,
      });
      await queries.markDone.run({ id: job.id, retryCount: job.retry_count, updatedAt: now });
      await audit("executed", "published", "Facebook video published", { platform: "facebook", destinationId: channel.id });
      console.log(`[ready] Facebook video "${job.title}" published for ${channel.name}`);
      return;
    }

    const result = await uploadJob(job, channel);
    await getDb().prepare(
      `INSERT INTO uploads (id, job_id, channel_id, youtube_id, youtube_url, etag, quota_cost, created_at)
       VALUES (@id, @jobId, @channelId, @youtubeId, @youtubeUrl, @etag, @quotaCost, @created)`
    ).run({
      id: crypto.randomUUID(),
      jobId: job.id,
      channelId: channel.id,
      youtubeId: result.youtubeId,
      youtubeUrl: result.url,
      etag: result.etag,
      quotaCost: result.quotaCost,
      created: now,
    });
    await queries.spendQuota.run({ id: channel.id, cost: result.quotaCost, now });
    await queries.markDone.run({ id: job.id, retryCount: job.retry_count, updatedAt: now });
    await audit("executed", "published", "YouTube video published", { platform: "youtube", destinationId: channel.id, quotaCost: result.quotaCost });
    console.log(`[ready] ${job.title} -> ${result.url} (channel ${channel.name})`);
  } catch (err) {
    await handleFailure(job, channel, err);
    await audit("execution_failed", "failed", err.message || "Upload failed", { platform: job.platform || "youtube", retryCount: Number(job.retry_count || 0) });
  }
}

async function validateClaimedJob(job) {
  const errors = [];
  const filename = String(job.filename || "");
  const extension = filename.split(".").at(-1)?.toLowerCase();
  if (!filename || basename(filename) !== filename) errors.push("Source filename is missing or invalid");
  if (!new Set(["mp4", "mov", "webm"]).has(extension)) errors.push("Video format must be MP4, MOV, or WebM");
  if (!String(job.title || "").trim()) errors.push("Title or caption is required");
  if (job.platform === "youtube") {
    if (String(job.title || "").length > 100) errors.push("YouTube title exceeds 100 characters");
    if (String(job.description || "").length > 5000) errors.push("YouTube description exceeds 5,000 characters");
  } else if (job.platform === "instagram" && String(job.description || "").length > 2200) {
    errors.push("Instagram caption exceeds 2,200 characters");
  }
  if (!errors.length) {
    try {
      const root = await realpath(config.storageRoot);
      const path = await realpath(resolve(root, filename));
      if (!path.startsWith(`${root}${sep}`)) errors.push("Source file is outside the managed media directory");
      else {
        await access(path, fsConstants.R_OK);
        const info = await stat(path);
        if (!info.isFile()) errors.push("Source path is not a regular file");
        else if (info.size <= 0) errors.push("Source video is empty");
        else if (info.size > config.upload.maxFileSize) errors.push("Source video exceeds the configured maximum file size");
      }
    } catch { errors.push("Source video is missing or unreadable"); }
  }
  return errors;
}

/** Decide what to do after an upload error. */
async function handleFailure(job, channel, err) {
  const now = nowSec();
  const kind = err instanceof SchedulerError ? err.kind : "transient";

  if (kind === "auth") {
    if (job.platform === "instagram") {
      console.warn(`[auth] disabling Instagram account ${channel.id} (@${channel.username}): ${err.message}`);
      await queries.deactivateInstagramAccount.run({ id: channel.id, updatedAt: now });
      await queries.setJobStatus.run({
        id: job.id, status: "failed", retryCount: job.retry_count,
        nextRetryAt: null, lastError: err.message, updatedAt: now,
      });
      return;
    }
    if (job.platform === "facebook") {
      console.warn(`[auth] disabling Facebook Page ${channel.id} (${channel.name}): ${err.message}`);
      await queries.deactivateFacebookPage.run({ id: channel.id, updatedAt: now });
      await queries.setJobStatus.run({
        id: job.id, status: "failed", retryCount: job.retry_count,
        nextRetryAt: null, lastError: err.message, updatedAt: now,
      });
      return;
    }
    console.warn(`[auth] disabling channel ${channel.id} (${channel.name}): ${err.message}`);
    await queries.deactivateChannel.run({ id: channel.id });
    // Re-queue on ANY channel so a revoked token doesn't block the job.
    const retriesLeft = config.quota.maxRetries - (job.retry_count || 0);
    if (retriesLeft > 0) {
      await queries.requeueJob.run({
        id: job.id, channelId: null, nextRetryAt: now,
        lastError: `auth: ${err.message} (channel ${channel.id} disabled)`, updatedAt: now,
      });
    } else {
      await queries.setJobStatus.run({
        id: job.id, status: "exhausted", retryCount: job.retry_count,
        nextRetryAt: null, lastError: err.message, updatedAt: now,
      });
    }
    return;
  }

  if (kind === "fatal") {
    await queries.setJobStatus.run({
      id: job.id, status: "failed", retryCount: job.retry_count,
      nextRetryAt: null, lastError: err.message, updatedAt: now,
    });
    console.log(`[failed] ${job.title}: ${err.message}`);
    return;
  }

  // rate_limit / transient -> exponential backoff
  const retryCount = (job.retry_count || 0) + 1;
  if (retryCount >= config.quota.maxRetries) {
    await queries.setJobStatus.run({
      id: job.id, status: "exhausted", retryCount,
      nextRetryAt: null, lastError: err.message, updatedAt: now,
    });
    console.log(`[exhausted] ${job.title}: ${err.message}`);
    return;
  }
  let backoff = backoffFor(retryCount - 1);
  if (err instanceof RateLimitError && err.retryAfterSec && err.retryAfterSec > backoff) {
    backoff = err.retryAfterSec;
  }
  await queries.requeueJob.run({
    id: job.id, channelId: null, nextRetryAt: now + backoff,
    lastError: err.message, updatedAt: now,
  });
  console.log(`[backoff] ${job.title}: retrying in ${backoff}s (${err.message})`);
}

/** One scheduling pass. Returns a summary object. */
export async function runTick() {
  await refreshBudgets();

  const orchestration = await getOrchestratorRuntime();
  if (orchestration.state === "paused") {
    return { tickAt: new Date().toISOString(), due: 0, dispatched: 0, skipped: 0, stalled: 0, paused: true, active: concurrencySnapshot() };
  }
  if (orchestration.mode === "assisted") {
    // Gate work created since the previous pass before looking for due jobs.
    await getDb().prepare(`UPDATE jobs SET orchestrator_approval_status = 'waiting'
      WHERE status = 'pending' AND orchestrator_approval_status = 'approved' AND orchestrator_selected_at IS NULL`).run();
  }
  if (["assisted", "automatic"].includes(orchestration.mode)) {
    await runOrchestratorCycle();
  }

  const now = nowSec();
  const due = await (orchestration.mode === "automatic" ? queries.dueJobsSelected : queries.dueJobs).all({ now });
  let dispatched = 0, skipped = 0, stalled = 0;

  for (const job of due) {
    if (!canRunAnother()) break;
    const resolved = await resolveChannel(job);
    if (!resolved) {
      if (job.platform === "instagram") {
        const account = await queries.findInstagramAccount.get({ id: job.instagram_account_id });
        if (!account?.active) {
          await queries.setJobStatus.run({
            id: job.id, status: "failed", retryCount: job.retry_count,
            nextRetryAt: null, lastError: "Instagram account is disconnected or inactive", updatedAt: now,
          });
        } else {
          stalled++;
        }
      } else if (job.platform === "facebook") {
        const page = await queries.findFacebookPage.get({ id: job.facebook_page_id });
        if (!page?.active) {
          await queries.setJobStatus.run({
            id: job.id, status: "failed", retryCount: job.retry_count,
            nextRetryAt: null, lastError: "Facebook Page is disconnected or inactive", updatedAt: now,
          });
        } else {
          stalled++;
        }
      } else {
        stalled++;
      }
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const r = await dispatch(job, resolved);
    if (r.dispatched) dispatched++;
    else if (r.skipped) skipped++;
  }

  return {
    tickAt: new Date().toISOString(),
    due: due.length,
    dispatched,
    skipped,
    stalled,
    active: concurrencySnapshot(),
  };
}

let timer = null;
export function start(intervalMs = config.worker.tickMs) {
  if (state.running) return;
  state.running = true;
  console.log(`[scheduler] worker started (tick every ${intervalMs}ms)`);
  const loop = async () => {
    try {
      const summary = await runTick();
      if (summary.dispatched + summary.skipped + summary.stalled > 0) {
        console.log(`[scheduler] tick: ${JSON.stringify(summary)}`);
      }
    } catch (e) {
      console.error("[scheduler] tick error:", e);
    } finally {
      timer = setTimeout(loop, intervalMs);
    }
  };
  loop();
}

export function stop() {
  state.running = false;
  if (timer) clearTimeout(timer);
  console.log("[scheduler] worker stopped");
}

export default { runTick, start, stop, concurrencySnapshot };
