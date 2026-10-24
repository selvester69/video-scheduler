/**
 * Folder-import + rotation-rule tests (Phase 1).
 *
 * Spins up a fresh temp SQLite DB + temp "watched" directories, boots the real
 * Express routers (same as the running app), logs in, and exercises:
 *   - gating (401 without auth),
 *   - folder add + initial scan (counts + sha256 dedup),
 *   - invalid / duplicate folder handling,
 *   - rescan (new file, duplicate-content file across folders -> app-wide dedup),
 *   - rotation rule CRUD + validation,
 *   - assignments preview (empty until Phase 2 planner ships).
 *
 * Offline only: no Google API calls. Same pattern as auth.test.js.
 */
import { mkdirSync, writeFileSync } from "fs";
import { rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import express from "express";

const tmp = join(tmpdir(), `yt-sched-folders-test-${process.pid}`);
mkdirSync(tmp, { recursive: true });
const storage = join(tmp, "storage");
mkdirSync(storage, { recursive: true });

// Env before imports.
process.env.NODE_ENV = "test";
process.env.DB_DRIVER = "sqlite";
process.env.DB_PATH = join(tmp, "test.db");
process.env.STORAGE_ROOT = storage;
process.env.DRY_RUN = "true";
process.env.JWT_SECRET = "test-secret";

const { initDb, getDb, queries, nowSec } = await import("../src/db.js");
const { config } = await import("../src/config.js");
const { hashPassword } = await import("../src/services/auth.js");
const { default: sessionRouter } = await import("../src/routes/session.js");
const { default: authRouter } = await import("../src/routes/auth.js");
const { foldersRouter, rulesRouter, rotationRouter } = await import("../src/routes/folders.js");
const { scanFolder } = await import("../src/services/scanner.js");
const { plan, previewSlots, cleanOrphanedMedia } = await import("../src/services/rotation-planner.js");
const { refreshFolderStatus } = await import("../src/services/watcher.js");
const { existsSync } = await import("node:fs");

const COOKIE = config.auth.cookieName;
let app, server, base, authJar;

before(async () => {
  await initDb();
  // One real channel so rotation-rule validation passes.
  await queries.insertChannel.run({
    id: "chan-1",
    name: "Test Channel",
    clientId: "c",
    clientSecret: "s",
    refreshToken: "r",
    quotaResetAt: nowSec() + 86400,
  });
  // Second channel for shared-pool / dedicated cross-channel tests.
  await queries.insertChannel.run({
    id: "chan-2",
    name: "Second Channel",
    clientId: "c2",
    clientSecret: "s2",
    refreshToken: "r2",
    quotaResetAt: nowSec() + 86400,
  });

  app = express();
  app.use(express.json());
  app.use("/api/auth", sessionRouter);
  app.use("/api/auth", authRouter);
  app.use("/auth", authRouter);
  app.use("/api/folders", foldersRouter);
  app.use("/api/rules", rulesRouter);
  app.use("/api/rotation", rotationRouter);
  app.use((_req, res) => res.status(404).json({ error: "not found" }));
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;

  // Register + capture an auth cookie for the gated endpoints.
  const r = await request("/api/auth/register", {
    method: "POST",
    json: { name: "Folders", email: "folders@example.com", password: "s3cret" },
  });
  assert.equal(r.status, 201, "register must succeed for test setup");
  authJar = authCookie(r.setCookies);
});

after(async () => {
  try { server?.close?.(); } catch {}
  try { await getDb()?.close?.(); } catch {}
  try { await rm(tmp, { recursive: true, force: true }); } catch {}
});

/* ---- helpers (copied from auth.test.js to stay self-contained) ---- */
async function request(path, { method = "GET", json, cookie } = {}) {
  const headers = {};
  if (json !== undefined) headers["Content-Type"] = "application/json";
  if (cookie) headers["Cookie"] = cookie;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: json !== undefined ? JSON.stringify(json) : undefined,
    redirect: "manual",
  });
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const text = await res.text();
  return { status: res.status, setCookies, text, header: (n) => res.headers.get(n) };
}
function cookieValue(setCookies, name) {
  for (const c of setCookies) if (c.startsWith(name + "=")) return c.split(";")[0].slice(name.length + 1);
  throw new Error(`cookie ${name} not set`);
}
function authCookie(setCookies) {
  return `${COOKIE}=${cookieValue(setCookies, COOKIE)}`;
}
const UUID = /[a-f0-9-]{36}/;
const SHA = /^[a-f0-9]{64}$/;

function makeVideo(dir, name, content) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content);
  return join(dir, name);
}
function freshDir(tag) {
  return join(tmp, tag, `watch-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

describe("folder import / rotation (Phase 1)", () => {
  test("GET /api/folders is gated (401 without auth)", async () => {
    const r = await request("/api/folders");
    assert.equal(r.status, 401);
  });

  test("POST /api/folders scans a watched dir and counts video files", async () => {
    const dir = freshDir("f1");
    makeVideo(dir, "alpha.mp4", Buffer.from("video alpha bytes"));
    makeVideo(dir, "beta.mp4", Buffer.from("video beta bytes"));
    const r = await request("/api/folders", { method: "POST", json: { path: dir }, cookie: authJar });
    assert.equal(r.status, 201);
    const body = JSON.parse(r.text);
    assert.match(body.id, UUID);
    assert.equal(body.scan.added, 2);
    assert.equal(body.scan.scanned, 2);
  });

  test("POST /api/folders rejects relative / nonexistent paths", async () => {
    const r1 = await request("/api/folders", { method: "POST", json: { path: "./relative" }, cookie: authJar });
    assert.equal(r1.status, 400);
    const r2 = await request("/api/folders", {
      method: "POST",
      json: { path: "/no/such/path/here" },
      cookie: authJar,
    });
    assert.equal(r2.status, 400);
  });

  test("POST /api/folders duplicate path -> 409 with existing id", async () => {
    const dir = freshDir("dup");
    makeVideo(dir, "only.mp4", Buffer.from("x"));
    const first = await request("/api/folders", { method: "POST", json: { path: dir }, cookie: authJar });
    assert.equal(first.status, 201);
    const second = await request("/api/folders", { method: "POST", json: { path: dir }, cookie: authJar });
    assert.equal(second.status, 409);
    assert.equal(JSON.parse(second.text).id, JSON.parse(first.text).id);
  });

  test("GET /:id/items lists files with sha256 + size + status", async () => {
    const dir = freshDir("items");
    makeVideo(dir, "clip1.mp4", Buffer.from("clip one"));
    makeVideo(dir, "clip2.mov", Buffer.from("clip two")); // different ext, still a video
    const created = await request("/api/folders", { method: "POST", json: { path: dir }, cookie: authJar });
    const id = JSON.parse(created.text).id;
    const r = await request(`/api/folders/${id}/items`, { cookie: authJar });
    assert.equal(r.status, 200);
    const items = JSON.parse(r.text);
    assert.equal(items.length, 2);
    const names = items.map((i) => i.filename).sort();
    assert.deepEqual(names, ["clip1.mp4", "clip2.mov"]);
    for (const it of items) {
      assert.match(it.sha256, SHA);
      assert.ok(it.sizeBytes > 0);
      assert.equal(it.status, "new");
    }
  });

  test("rescan adds new files and detects cross-folder duplicates (FR-ROT-06)", async () => {
    const dirA = freshDir("raA");
    makeVideo(dirA, "a-file.mp4", Buffer.from("identical content"));
    const fb = await request("/api/folders", { method: "POST", json: { path: dirA }, cookie: authJar });
    const idA = JSON.parse(fb.text).id;

    // New file in the same folder -> added on rescan.
    makeVideo(dirA, "a-file-2.mp4", Buffer.from("a second file"));
    const rescan1 = await request(`/api/folders/${idA}/rescan`, { method: "POST", cookie: authJar });
    assert.equal(rescan1.status, 200);
    assert.equal(JSON.parse(rescan1.text).added, 1);

    // Second folder with an IDENTICAL-content file -> deduped app-wide.
    const dirB = freshDir("raB");
    makeVideo(dirB, "b-copy.mp4", Buffer.from("identical content"));
    const fb2 = await request("/api/folders", { method: "POST", json: { path: dirB }, cookie: authJar });
    const scan2 = JSON.parse(fb2.text).scan;
    assert.equal(scan2.scanned, 1);
    assert.equal(scan2.added, 0);
    assert.equal(scan2.duplicates, 1);
  });

  test("POST :id/rules validates inputs (channel, frequency, timeOfDay)", async () => {
    const dir = freshDir("rules");
    makeVideo(dir, "r.mp4", Buffer.from("r"));
    const fb = await request("/api/folders", { method: "POST", json: { path: dir }, cookie: authJar });
    const id = JSON.parse(fb.text).id;

    const badChannel = await request(`/api/folders/${id}/rules`, {
      method: "POST",
      json: { channelId: "nope", frequency: "daily", timeOfDay: "09:00", startDate: "2024-01-01" },
      cookie: authJar,
    });
    assert.equal(badChannel.status, 400);

    const badFreq = await request(`/api/folders/${id}/rules`, {
      method: "POST",
      json: { channelId: "chan-1", frequency: "weekly", timeOfDay: "09:00", startDate: "2024-01-01" },
      cookie: authJar,
    });
    assert.equal(badFreq.status, 400);

    const badTime = await request(`/api/folders/${id}/rules`, {
      method: "POST",
      json: { channelId: "chan-1", frequency: "daily", timeOfDay: "9am", startDate: "2024-01-01" },
      cookie: authJar,
    });
    assert.equal(badTime.status, 400);
  });

  test("POST :id/rules creates a rule with valid inputs", async () => {
    const dir = freshDir("ruleOk");
    makeVideo(dir, "ok.mp4", Buffer.from("ok"));
    const fb = await request("/api/folders", { method: "POST", json: { path: dir }, cookie: authJar });
    const id = JSON.parse(fb.text).id;
    const r = await request(`/api/folders/${id}/rules`, {
      method: "POST",
      json: {
        channelId: "chan-1",
        frequency: "every_n_days",
        intervalN: 2,
        timeOfDay: "14:30",
        timezone: "America/New_York",
        startDate: "2024-01-01",
        poolMode: "shared",
        captionTemplate: "Drop #{index}: {filename}",
      },
      cookie: authJar,
    });
    assert.equal(r.status, 201);
    const rule = JSON.parse(r.text);
    assert.match(rule.id, UUID);
    assert.equal(rule.frequency, "every_n_days");
    assert.equal(rule.intervalN, 2);
    assert.equal(rule.timeOfDay, "14:30");
    assert.equal(rule.timezone, "America/New_York");
    assert.equal(rule.poolMode, "shared");
    assert.equal(rule.captionTemplate, "Drop #{index}: {filename}");
  });

  test("PATCH /api/rules/:id updates fields", async () => {
    const dir = freshDir("patch");
    makeVideo(dir, "p.mp4", Buffer.from("p"));
    const fb = await request("/api/folders", { method: "POST", json: { path: dir }, cookie: authJar });
    const id = JSON.parse(fb.text).id;
    const created = await request(`/api/folders/${id}/rules`, {
      method: "POST",
      json: { channelId: "chan-1", frequency: "daily", timeOfDay: "09:00", startDate: "2024-01-01" },
      cookie: authJar,
    });
    const ruleId = JSON.parse(created.text).id;

    const patched = await request(`/api/rules/${ruleId}`, {
      method: "PATCH",
      json: { poolMode: "dedicated", frequency: "weekdays", weekdays: "1,3,5", captionTemplate: "{filename}" },
      cookie: authJar,
    });
    assert.equal(patched.status, 200);
    const rule = JSON.parse(patched.text);
    assert.equal(rule.poolMode, "dedicated");
    assert.equal(rule.frequency, "weekdays");
    assert.equal(rule.weekdays, "1,3,5");
    assert.equal(rule.captionTemplate, "{filename}");
  });

  test("DELETE /api/rules/:id stops the rule (keeps jobs)", async () => {
    const dir = freshDir("del");
    makeVideo(dir, "d.mp4", Buffer.from("d"));
    const fb = await request("/api/folders", { method: "POST", json: { path: dir }, cookie: authJar });
    const id = JSON.parse(fb.text).id;
    const created = await request(`/api/folders/${id}/rules`, {
      method: "POST",
      json: { channelId: "chan-1", frequency: "daily", timeOfDay: "09:00", startDate: "2024-01-01" },
      cookie: authJar,
    });
    const ruleId = JSON.parse(created.text).id;

    const d = await request(`/api/rules/${ruleId}`, { method: "DELETE", cookie: authJar });
    assert.equal(d.status, 200);
    assert.equal(JSON.parse(d.text).ok, true);

    // assignments gone (cascade), rule itself gone
    assert.equal((await request(`/api/rules/${ruleId}/assignments`, { cookie: authJar })).status, 404);
    const gone = await queries.findRule.get({ id: ruleId });
    assert.equal(gone, undefined, "rule row removed");
  });

  test("GET /api/rules/:id/assignments is empty until Phase 2 planner ships", async () => {
    const dir = freshDir("asmt");
    makeVideo(dir, "a.mp4", Buffer.from("a"));
    const fb = await request("/api/folders", { method: "POST", json: { path: dir }, cookie: authJar });
    const id = JSON.parse(fb.text).id;
    const created = await request(`/api/folders/${id}/rules`, {
      method: "POST",
      json: { channelId: "chan-1", frequency: "daily", timeOfDay: "09:00", startDate: "2024-01-01" },
      cookie: authJar,
    });
    const ruleId = JSON.parse(created.text).id;
    const r = await request(`/api/rules/${ruleId}/assignments`, { cookie: authJar });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.text), []);
  });
});

describe("rotation planner (Phase 2 core)", () => {
  // Each planner test must start from a clean rotation slate: Phase-1 tests leave
  // leftover rules/items/jobs in the shared SQLite DB, and plan() processes every
  // active rule, so without isolation the scheduled-job counts drift.
  beforeEach(async () => {
    const db = getDb();
    for (const t of ["rotation_assignments", "rotation_rules", "source_items", "source_folders", "media_assets"]) {
      await db.prepare(`DELETE FROM ${t}`).run({});
    }
    await db.prepare("DELETE FROM jobs WHERE source = 'rotation'").run({});
  });

  // Fixed "now" so slot math is deterministic (2024-01-02 00:00 UTC).
  // Rule start_date 2024-01-01 -> first daily 09:00 slot = 2024-01-02 09:00 UTC.
  const FROM = 1704153600; // 2024-01-02 00:00 UTC
  const SLOT_09 = 1704186000; // 2024-01-02 09:00 UTC
  const SLOT_10 = SLOT_09 + 3600; // 2024-01-02 10:00 UTC

  async function makeFolder(dir, files) {
    for (const [name, content] of Object.entries(files)) makeVideo(dir, name, Buffer.from(content));
    const fb = await request("/api/folders", { method: "POST", json: { path: dir }, cookie: authJar });
    assert.equal(fb.status, 201, fb.text);
    return JSON.parse(fb.text).id;
  }
  async function makeRule(folderId, body) {
    const r = await request(`/api/folders/${folderId}/rules`, { method: "POST", json: body, cookie: authJar });
    return JSON.parse(r.text);
  }
  function rotationJobs() {
    return getDb().prepare("SELECT * FROM jobs WHERE source = 'rotation' ORDER BY created_at ASC").all({});
  }
  function assignments(ruleId) {
    return getDb()
      .prepare("SELECT * FROM rotation_assignments WHERE rule_id = @ruleId ORDER BY created_at ASC")
      .all({ ruleId });
  }

  test("plan creates a scheduled job within the 72h horizon (shared pool, 1 item)", async () => {
    const dir = freshDir("plan1");
    const folderId = await makeFolder(dir, { "alpha.mp4": "plan1-alpha bytes" });
    const rule = await makeRule(folderId, {
      channelId: "chan-1", frequency: "daily", timeOfDay: "09:00", startDate: "2024-01-01",
      poolMode: "shared", captionTemplate: "Drop #{index}: {filename}",
    });

    const res = await plan({ fromSec: FROM, horizonHours: 72 });
    assert.equal(res.scheduled, 1);
    assert.equal(res.jobs, 1);
    assert.equal(res.planned, 0);
    assert.equal(res.skipped, 0);

    const job = (await rotationJobs())[0];
    assert.equal(job.source, "rotation");
    assert.equal(job.status, "pending");
    assert.equal(job.channel_id, "chan-1");
    assert.equal(job.scheduled_at, SLOT_09);
    assert.ok(job.media_asset_id, "job references a media_asset");
    assert.match(job.filename, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.mp4$/);
    assert.match(job.title, /Drop #1: alpha/); // caption template rendered
    assert.ok(existsSync(join(config.storageRoot, job.filename)), "media file was copied into the store");

    const a = (await assignments(rule.id))[0];
    assert.equal(a.status, "scheduled");
    assert.equal(a.job_id, job.id);
    assert.equal(a.scheduled_at, SLOT_09);

    const item = await getDb().prepare("SELECT status FROM source_items WHERE filename = 'alpha.mp4'").get({});
    assert.equal(item.status, "used");
  });

  test("plan is idempotent: a filled slot is not double-booked", async () => {
    const dir = freshDir("plan2");
    const folderId = await makeFolder(dir, { "alpha.mp4": "plan2-alpha bytes" });
    const rule = await makeRule(folderId, {
      channelId: "chan-1", frequency: "daily", timeOfDay: "09:00", startDate: "2024-01-01", poolMode: "shared",
    });

    await plan({ fromSec: FROM, horizonHours: 72 });
    const before = (await rotationJobs()).length;
    const beforeAs = (await assignments(rule.id)).length;

    // Re-run with the SAME "now": the 09:00 slot is already assigned, and the
    // only item is already used by this rule -> "no_media", no new job.
    const res2 = await plan({ fromSec: FROM, horizonHours: 72 });
    assert.equal(res2.scheduled, 0);
    assert.equal(res2.jobs, 0);
    assert.equal(res2.skipped, 1);
    assert.equal((await rotationJobs()).length, before, "no extra job created");
    assert.equal((await assignments(rule.id)).length, beforeAs, "no extra assignment created");
  });

  test("dedicated pool: a rule cannot steal an item already assigned to another rule", async () => {
    const dir = freshDir("plan3");
    const folderId = await makeFolder(dir, { "alpha.mp4": "plan3-alpha", "beta.mp4": "plan3-beta" });
    // Two dedicated rules (one channel each), different times so order is stable.
    const r1 = await makeRule(folderId, {
      channelId: "chan-1", frequency: "daily", timeOfDay: "09:00", startDate: "2024-01-01", poolMode: "dedicated",
    });
    const r2 = await makeRule(folderId, {
      channelId: "chan-2", frequency: "daily", timeOfDay: "10:00", startDate: "2024-01-01", poolMode: "dedicated",
    });

    const res = await plan({ fromSec: FROM, horizonHours: 72 });
    assert.equal(res.scheduled, 2);
    assert.equal(res.jobs, 2);

    const j1 = (await getDb().prepare("SELECT * FROM jobs WHERE source='rotation' AND scheduled_at=@s").get({ s: SLOT_09 }));
    const j2 = (await getDb().prepare("SELECT * FROM jobs WHERE source='rotation' AND scheduled_at=@s").get({ s: SLOT_10 }));
    assert.ok(j1, "job at 09:00 slot exists");
    assert.ok(j2, "job at 10:00 slot exists");
    // r1 (09:00) got alpha; r2 (10:00) got beta — distinct items, no stealing.
    const a1 = (await assignments(r1.id))[0];
    const a2 = (await assignments(r2.id))[0];
    assert.notEqual(a1.item_id, a2.item_id, "dedicated rules got distinct items");
  });

  test("shared pool: one media_asset copied once, reused across two channels", async () => {
    const dir = freshDir("plan4");
    const folderId = await makeFolder(dir, { "alpha.mp4": "plan4-alpha bytes" });
    const r1 = await makeRule(folderId, {
      channelId: "chan-1", frequency: "daily", timeOfDay: "09:00", startDate: "2024-01-01", poolMode: "shared",
    });
    const r2 = await makeRule(folderId, {
      channelId: "chan-2", frequency: "daily", timeOfDay: "09:00", startDate: "2024-01-01", poolMode: "shared",
    });

    const res = await plan({ fromSec: FROM, horizonHours: 72 });
    assert.equal(res.scheduled, 2);
    assert.equal(res.jobs, 2);

    const jobs = await getDb().prepare("SELECT * FROM jobs WHERE source='rotation'").all({});
    assert.equal(jobs.length, 2);
    // Both jobs point at the SAME media_asset (and the same file path).
    const mediaIds = new Set(jobs.map((j) => j.media_asset_id));
    assert.equal(mediaIds.size, 1, "one media_asset reused by both channels");
    const paths = new Set(jobs.map((j) => j.filename));
    assert.equal(paths.size, 1, "both jobs upload the same copied file");
    assert.ok(existsSync(join(config.storageRoot, jobs[0].filename)), "shared media file exists on disk");
  });

  test("GET /api/rules/:id/slots previews upcoming slots (open vs assigned)", async () => {
    const dir = freshDir("plan5");
    const folderId = await makeFolder(dir, { "alpha.mp4": "plan5-alpha bytes" });
    const rule = await makeRule(folderId, {
      channelId: "chan-1", frequency: "daily", timeOfDay: "09:00", startDate: "2024-01-01", poolMode: "shared",
    });

    // Before planning: first slot is open.
    const preview = await request(`/api/rules/${rule.id}/slots?from=${FROM}&count=3`, { cookie: authJar });
    assert.equal(preview.status, 200);
    const pv = JSON.parse(preview.text);
    assert.equal(pv.horizonHours, 72);
    assert.equal(pv.slots.length, 3);
    assert.equal(pv.slots[0].slot, SLOT_09);
    assert.equal(pv.slots[0].status, "open");

    await plan({ fromSec: FROM, horizonHours: 72 });
    const preview2 = await request(`/api/rules/${rule.id}/slots?from=${FROM}&count=3`, { cookie: authJar });
    const pv2 = JSON.parse(preview2.text);
    assert.equal(pv2.slots[0].status, "scheduled");
    assert.equal(pv2.slots[0].assigned, true);
    assert.equal(pv2.slots[1].status, "open");
  });

  test("refreshFolderStatus marks reachable / unreachable by path", async () => {
    const good = freshDir("watch-ok");
    mkdirSync(good, { recursive: true });
    const bad = "/no/such/watched/dir/xyz";
    const now = nowSec();
    const goodId = crypto.randomUUID();
    const badId = crypto.randomUUID();
    await queries.insertFolder.run({ id: goodId, path: good, active: 1, scanInterval: 300, lastScanAt: null, created: now, updated: now });
    await queries.insertFolder.run({ id: badId, path: bad, active: 1, scanInterval: 300, lastScanAt: null, created: now, updated: now });

    await refreshFolderStatus({ id: goodId, path: good });
    await refreshFolderStatus({ id: badId, path: bad });

    const g = await queries.findFolder.get({ id: goodId });
    const b = await queries.findFolder.get({ id: badId });
    assert.equal(g.status, "reachable");
    assert.equal(b.status, "unreachable");
  });

  test("cleanOrphanedMedia removes unreferenced assets but keeps referenced ones", async () => {
    writeFileSync(join(config.storageRoot, "orphan.mp4"), Buffer.from("orphan"));
    writeFileSync(join(config.storageRoot, "ref.mp4"), Buffer.from("ref"));
    const now = nowSec();
    const orphanId = crypto.randomUUID();
    const refMediaId = crypto.randomUUID();
    const refJobId = crypto.randomUUID();
    // orphan: no job references it
    await queries.insertMediaAsset.run({ id: orphanId, sha256: "orphan-sha", path: "orphan.mp4", sizeBytes: 6, created: now, updated: now });
    // referenced: a rotation job points at it
    await queries.insertMediaAsset.run({ id: refMediaId, sha256: "ref-sha", path: "ref.mp4", sizeBytes: 3, created: now, updated: now });
    await queries.insertRotationJob.run({
      id: refJobId, channelId: "chan-1", filename: "ref.mp4", title: "ref", description: "",
      hashtags: "", tags: "", category: null, privacy: "private", scheduledAt: now, priority: 0,
      nextRetryAt: null, status: "pending", created: now, updated: now, mediaAssetId: refMediaId,
    });

    const r = await cleanOrphanedMedia();
    assert.equal(r.removed, 1);
    assert.equal(r.bytes, 6);
    assert.equal(r.errors.length, 0);
    assert.equal(existsSync(join(config.storageRoot, "orphan.mp4")), false, "orphan file removed");
    assert.equal(existsSync(join(config.storageRoot, "ref.mp4")), true, "referenced file kept");
    assert.equal((await queries.findMediaByHash.get({ sha256: "orphan-sha" })), undefined, "orphan row removed");
    assert.ok(await queries.findMediaByHash.get({ sha256: "ref-sha" }), "referenced row kept");
  });
});
