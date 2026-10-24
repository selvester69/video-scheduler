/**
 * Pure, deterministic tests for timezone slot computation + caption templates.
 * No DB, no network, no env — these modules only use built-in Intl.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextSlots, nextSlot, parseTimeOfDay, _test as tz } from "../src/services/timezone.js";
import { renderCaption } from "../src/services/caption.js";

const HOUR = 3600;
const DAY = 86400;

const rule = (over) => ({
  frequency: "daily",
  interval_n: null,
  weekdays: null,
  time_of_day: "09:00",
  timezone: "UTC",
  start_date: 1704067200, // 2024-01-01 00:00 UTC (Monday)
  ...over,
});

test("parseTimeOfDay accepts/validates HH:mm", () => {
  assert.deepEqual(parseTimeOfDay("09:00"), { H: 9, M: 0 });
  assert.deepEqual(parseTimeOfDay("14:30"), { H: 14, M: 30 });
  assert.throws(() => parseTimeOfDay("9am"), /invalid timeOfDay/);
  assert.throws(() => parseTimeOfDay("25:00"), /invalid timeOfDay/);
});

test("offsetMinutes is 0 for UTC", () => {
  assert.equal(tz.offsetMinutes(1704067200 * 1000, "UTC"), 0);
});

test("offsetMinutes is DST-aware (America/New_York)", () => {
  // Winter (EST, -5)
  const winter = Date.UTC(2024, 0, 15, 12, 0, 0); // 2024-01-15 12:00 UTC
  assert.equal(tz.offsetMinutes(winter, "America/New_York"), -300);
  // Summer (EDT, -4)
  const summer = Date.UTC(2024, 6, 15, 12, 0, 0); // 2024-07-15 12:00 UTC
  assert.equal(tz.offsetMinutes(summer, "America/New_York"), -240);
});

test("daily UTC slots are 24h apart at 09:00", () => {
  const from = 1704153600; // 2024-01-02 00:00 UTC
  const s = nextSlots(rule({ frequency: "daily" }), from, 4);
  assert.equal(s.length, 4);
  for (const v of s) assert.equal(v % DAY, 9 * HOUR); // 09:00 UTC every day
  for (let i = 1; i < s.length; i++) assert.equal(s[i] - s[i - 1], DAY);
  assert.ok(s[0] >= 1704186000); // 2024-01-02 09:00 UTC
});

test("every_n_days cadence with interval_n=2", () => {
  const s = nextSlots(rule({ frequency: "every_n_days", interval_n: 2 }), 1704067200, 4);
  for (const v of s) assert.equal(v % DAY, 9 * HOUR);
  for (let i = 1; i < s.length; i++) assert.equal(s[i] - s[i - 1], 2 * DAY);
  assert.equal(s[0], 1704099600); // 2024-01-01 09:00 UTC
});

test("weekdays picks only the configured days (doc Mon=0..Sun=6)", () => {
  // 2024-01-01 is Monday (doc 0). weekdays = Tue/Thu/Sat = "1,3,5"
  const s = nextSlots(rule({ frequency: "weekdays", weekdays: "1,3,5" }), 1704067200, 6);
  const wanted = new Set([1, 3, 5]);
  for (const v of s) {
    const jsDay = new Date(v * 1000).getUTCDay(); // Sun=0..Sat=6
    const docDay = (jsDay + 6) % 7; // Mon=0
    assert.ok(wanted.has(docDay), `slot ${v} lands on doc-day ${docDay}, expected in [1,3,5]`);
  }
  // first slot is the Tuesday 2024-01-02 09:00 UTC
  assert.equal(s[0], 1704186000);
});

test("timezone shifts slots off-UTC (America/New_York winter = EST -5)", () => {
  const s = nextSlots(rule({ frequency: "daily", timezone: "America/New_York" }), 1704067200, 3);
  // 2024-01-01 09:00 EST = 14:00 UTC
  assert.equal(s[0], 1704117600);
  for (const v of s) assert.equal(v % DAY, 14 * HOUR); // UTC 14:00 daily in winter
});

test("slots respect start_date (skip days before start)", () => {
  // start 2024-01-05 00:00; from now (2024-01-01). First slot must be on/after start.
  const s = nextSlots(rule({ start_date: 1704374400 }), 1704067200, 3);
  assert.ok(s[0] >= 1704374400 + 9 * HOUR);
});

test("nextSlot returns the single first slot", () => {
  assert.equal(nextSlot(rule({ frequency: "daily" }), 1704067200), 1704099600);
});

test("renderCaption substitutes filename/index/date", () => {
  const out = renderCaption("Drop #{index}: {filename}", {
    filename: "beach-clip.mp4",
    index: 4,
    date: "2024-05-01T12:00:00Z",
  });
  assert.equal(out, "Drop #4: beach-clip");
});

test("renderCaption strips extension for any video ext", () => {
  assert.equal(renderCaption("New: {filename}", { filename: "clip.mov" }), "New: clip");
});

test("renderCaption with null template -> ''", () => {
  assert.equal(renderCaption(null, { filename: "x.mp4", index: 1 }), "");
  assert.equal(renderCaption(undefined, {}), "");
});

test("renderCaption {date} formats YYYY-MM-DD", () => {
  assert.equal(renderCaption("On {date}", { date: "2024-12-31T23:59:00Z" }), "On 2024-12-31");
});
