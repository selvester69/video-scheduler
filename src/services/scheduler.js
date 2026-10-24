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
import { RateLimitError, AuthError, FatalUploadError, SchedulerError } from "./errors.js";

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
    const account = await queries.findInstagramAccount.get({ id: job.instagram_account_id });
    if (!account?.active) return null;
    if (inFlight(`instagram:${account.id}`) >= config.worker.perChannelMaxConcurrent) return null;
    return account;
  }
  const channels = await queries.listActiveChannels.all();
  for (const ch of channels) {
    if (job.channel_id && ch.id !== job.channel_id) continue;
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
  const claimed = await queries.claimJob.get({ id: job.id });
  if (!claimed) return { skipped: true }; // lost the race to another tick/worker

  const key = job.platform === "instagram" ? `instagram:${channel.id}` : channel.id;
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
  try {
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
      console.log(`[ready] Instagram Reel "${job.title}" published for @${channel.username}`);
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
    console.log(`[ready] ${job.title} -> ${result.url} (channel ${channel.name})`);
  } catch (err) {
    await handleFailure(job, channel, err);
  }
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

  const now = nowSec();
  const due = await queries.dueJobs.all({ now });
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
