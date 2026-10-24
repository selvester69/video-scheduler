/**
 * Scheduler integration test (dry-run mode).
 *
 * Spins up a fresh temp SQLite DB + two fake channels, schedules videos, and
 * drives worker ticks until jobs finish. A second scenario forces a rate limit
 * on the first attempt to prove backoff + retry + channel rotation works.
 *
 * Uses only Node's built-in test runner (no extra deps). Uses the SQLite
 * driver (default) — the same query surface as PostgreSQL.
 */
import { mkdirSync, writeFileSync } from "fs";
import { rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { test, after } from "node:test";
import assert from "node:assert/strict";

const tmp = join(tmpdir(), `yt-sched-test-${process.pid}`);
mkdirSync(tmp, { recursive: true });
const storage = join(tmp, "storage");
mkdirSync(storage, { recursive: true });

// A tiny dummy file so the dry-run path is happy (dry-run skips ffmpeg).
writeFileSync(join(storage, "clip.mp4"), Buffer.alloc(16));

// Set EVERY env var BEFORE importing app modules so config.js picks them up.
process.env.NODE_ENV = "test";
process.env.DB_PATH = join(tmp, "test.db");
process.env.STORAGE_ROOT = storage;
process.env.DRY_RUN = "true";
process.env.MAX_CONCURRENT_UPLOADS = "2";
process.env.PER_CHANNEL_MAX_CONCURRENT = "1";
process.env.BACKOFF_BASE = "1";
process.env.BACKOFF_MAX = "3";
process.env.MAX_RETRIES = "6";
process.env.DEFAULT_DAILY_QUOTA = "10000";
process.env.UPLOAD_QUOTA_COST = "1600";
process.env.QUOTA_BURN_FRACTION = "0.85";

const { initDb, queries, nowSec, getDb } = await import("../src/db.js");
const { runTick, concurrencySnapshot } = await import("../src/services/scheduler.js");
const { config } = await import("../src/config.js");

async function reset() {
  await initDb();
  await getDb().exec("DELETE FROM uploads; DELETE FROM jobs; DELETE FROM channels;");
}

function seedChannel(id, name, quotaUsed = 0) {
  const now = nowSec();
  return getDb().prepare(
    `INSERT INTO channels (id, name, google_client_id, google_client_secret,
     refresh_token, quota_reset_at, quota_used, last_used_at, active)
     VALUES (@id, @name, 'c', 's', 'r', @reset, @quotaUsed, @now, 1)`
  ).run({ id, name, reset: now + 86400, quotaUsed, now });
}

function seedJob(over = {}) {
  const id = crypto.randomUUID();
  const now = nowSec();
  return queries.insertJob.run({
    id,
    channelId: over.channelId ?? null,
    filename: "clip.mp4",
    title: over.title || "Test video",
    description: "A test",
    hashtags: over.hashtags || "#test #demo",
    tags: "test,demo",
    category: null,
    privacy: "private",
    scheduledAt: now,
    priority: 0,
    nextRetryAt: now,
    status: "pending",
    created: now,
    updated: now,
  });
}

async function jobIdOfLast() {
  const row = await getDb().prepare("SELECT id FROM jobs ORDER BY created_at DESC LIMIT 1").get();
  return row?.id;
}

async function waitUntilDone(id, ms = 25000, tickMs = config.worker.tickMs) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await runTick();
    const job = await queries.findJob.get({ id });
    if (job.status === "done" || job.status === "failed" || job.status === "exhausted") return job;
    await new Promise((r) => setTimeout(r, tickMs));
  }
  throw new Error("timed out waiting for job to finish");
}

test("happy path: scheduled job uploads and becomes done", async () => {
  await reset();
  await seedChannel("chan-1", "Channel One");
  await seedChannel("chan-2", "Channel Two");
  await seedJob();

  const jobId = await jobIdOfLast();
  const job = await waitUntilDone(jobId);
  assert.equal(job.status, "done", `job should be done: ${job.last_error}`);

  const uploads = await getDb().prepare("SELECT * FROM uploads WHERE job_id=@id").all({ id: jobId });
  assert.equal(uploads.length, 1, "one upload row recorded");
  assert.match(uploads[0].youtube_url, /^https:\/\/youtu.be\//);
  const listedJob = (await queries.listJobs.all()).find((item) => item.id === jobId);
  assert.equal(listedJob.youtube_url, uploads[0].youtube_url, "job history includes the published video URL");

  const ch = await getDb().prepare("SELECT id, quota_used FROM channels ORDER BY id").all();
  console.log("  quota after:", JSON.stringify(ch));
  console.log("  concurrency end:", concurrencySnapshot());
});

test("backoff path: rate-limit on attempt 1 -> retries -> eventually done", async () => {
  await reset();
  await seedChannel("chan-1", "Channel One");
  await seedChannel("chan-2", "Channel Two");
  process.env.DRY_RUN_FAIL_FIRST_N = "1";
  process.env.DRY_RUN_RETRY_AFTER = "2";
  await seedJob({ title: "Backoff video" });

  const jobId = await jobIdOfLast();
  const job = await waitUntilDone(jobId, 30000, 500);
  delete process.env.DRY_RUN_FAIL_FIRST_N;
  delete process.env.DRY_RUN_RETRY_AFTER;
  assert.equal(job.status, "done", `job should recover after backoff: ${job.last_error}`);
  assert.ok(job.retry_count >= 1, "job was retried at least once");
  console.log(`  backoff job done after ${job.retry_count} retries`);
});

test("rotation: channel that's over quota is skipped, other channel used", async () => {
  await reset();
  const now = nowSec();
  await getDb().prepare(
    `INSERT INTO channels (id, name, google_client_id, google_client_secret,
     refresh_token, quota_reset_at, quota_used, last_used_at, active)
     VALUES ('full', 'Full Channel', 'c', 's', 'r', @r, 8500, @now, 1)`
  ).run({ r: now + 86400, now });
  await seedChannel("spare", "Spare Channel");
  await seedJob();

  const jobId = await jobIdOfLast();
  const job = await waitUntilDone(jobId, 15000);
  assert.equal(job.status, "done", `job should finish: ${job.last_error}`);
  const up = await getDb().prepare("SELECT channel_id FROM uploads WHERE job_id=@id").get({ id: jobId });
  assert.equal(up.channel_id, "spare", "uploaded via the channel with spare quota, not the over-budget one");
});

after(async () => {
  try { const d = getDb(); if (d?.close) await d.close(); } catch {}
  try { await rm(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});
