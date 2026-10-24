/**
 * Timezone-aware scheduling-slot computation for rotation rules.
 *
 * A rule has a `frequency` (daily / every_n_days / weekdays), a wall-clock
 * `time_of_day` ("HH:mm"), a `timezone` (IANA, e.g. "America/New_York"), and a
 * `start_date` (epoch seconds). We must turn that into UTC epoch-second slot
 * times — correctly crossing DST boundaries.
 *
 * We use only Node's built-in `Intl.DateTimeFormat` (full-icu is present in
 * the linux/arm64 image). No external dependency.
 *
 * Wall-time -> epoch trick: interpret "date H:M in TZ" by treating H:M as UTC
 * (Date.UTC), reading the TZ's UTC offset AT that candidate instant, then
 * subtracting the offset. Re-reading the offset at the candidate instant makes
 * it DST-correct (the offset used is the one in effect at that wall time).
 */
const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

// Format a UTC epoch-ms to wall-clock parts IN a timezone (one Intl call).
function wallParts(ms, tz) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  });
  const o = {};
  for (const p of f.formatToParts(ms)) {
    if (p.type !== "literal" && p.type !== "relatedYear") o[p.type] = p.value;
  }
  return o;
}

// UTC offset (minutes) of `tz` at instant `ms` (DST-aware).
function offsetMinutes(ms, tz) {
  const t = wallParts(ms, tz).timeZoneName || ""; // "GMT-04:00" | "GMT+05:30" | "GMT+00:00" | "GMT"
  if (!t.startsWith("GMT")) return 0;
  const body = t.slice(3); // "" | "+05:30" | "-04:00" | "+00:00" | "+0"
  if (!body || body === "+0" || body === "-0" || !/[+-]/.test(body)) return 0; // literal "GMT"
  const sign = body[0] === "-" ? -1 : 1;
  const [h, m] = body.slice(1).split(":").map(Number);
  return sign * (Number(h) * 60 + Number(m));
}

// Epoch-ms of the wall-clock instant (y,mo,d,H,M) interpreted IN tz.
function wallToEpochMs(y, mo /*0-11*/, d, H, M, tz) {
  const candidate = Date.UTC(y, mo, d, H, M); // treat the wall time as UTC first
  const off = offsetMinutes(candidate, tz); // offset AT that instant
  return candidate - off * 60_000; // true UTC instant whose tz wall-clock is H:M
}

// Calendar date {y,mo,d} of a UTC epoch-ms as seen in tz.
function dateInTz(ms, tz) {
  const o = wallParts(ms, tz);
  return { y: Number(o.year), mo: Number(o.month) - 1, d: Number(o.day), H: Number(o.hour), M: Number(o.minute) };
}

// Epoch-ms of "HH:MM today (in tz)"; if `ms` is already past HH:MM today, use today anyway
// (caller decides whether to advance).
function epochForDayAt(H, M, tz, ms) {
  const { y, mo, d } = dateInTz(ms, tz);
  return wallToEpochMs(y, mo, d, H, M, tz);
}

// Epoch-ms of midnight (00:00) on the NEXT calendar day in tz.
function nextDayStartMs(ms, tz) {
  const { y, mo, d } = dateInTz(ms, tz);
  return wallToEpochMs(y, mo, d + 1, 0, 0, tz);
}

export function parseTimeOfDay(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ""));
  if (!m) throw new Error(`invalid timeOfDay: ${s}`);
  const H = Number(m[1]),
    M = Number(m[2]);
  if (H > 23 || M > 59) throw new Error(`invalid timeOfDay: ${s}`);
  return { H, M };
}

/**
 * Next `count` scheduled slot epoch-seconds for a rule, at/after `fromSec`,
 * honoring timezone + DST. Slots before `rule.start_date` are skipped.
 *
 * @param {object} rule  { frequency, interval_n, weekdays, time_of_day, timezone, start_date }
 * @param {number} fromSec
 * @param {number} [count=8]
 * @returns {number[]} epoch seconds, ascending
 */
export function nextSlots(rule, fromSec, count = 8) {
  const tz = rule.timezone || "UTC";
  const { H, M } = parseTimeOfDay(rule.time_of_day || "00:00");
  const from = Math.max(0, Math.floor(fromSec));
  const startLimit = Number(rule.start_date) || 0; // epoch seconds
  const startMs = Math.max(from, startLimit) * 1000;

  const wanted = new Set(
    String(rule.weekdays || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
  // doc weekday numbering is Mon=0..Sun=6.
  const docDayOfWeek = (ms) => {
    const { y, mo, d } = dateInTz(ms, tz);
    const jsDay = new Date(Date.UTC(y, mo, d, 12)).getUTCDay(); // noonday avoids date edges
    return (jsDay + 6) % 7; // Sun=0 ->6, Mon=0, ..., Sat=5
  };

  const out = [];
  let dayMs = epochForDayAt(H, M, tz, startMs);
  if (dayMs < startMs) dayMs = epochForDayAt(H, M, tz, nextDayStartMs(dayMs, tz));

  let i = 0; // index among candidate daily slots (used for every_n_days cadence)
  while (out.length < count) {
    let take = false;
    if (rule.frequency === "daily") take = true;
    else if (rule.frequency === "every_n_days") {
      const n = Math.max(1, Number(rule.interval_n) || 1);
      take = i % n === 0;
    } else if (rule.frequency === "weekdays") {
      take = wanted.has(String(docDayOfWeek(dayMs)));
    }
    if (take) out.push(Math.floor(dayMs / 1000));
    i++;
    dayMs = epochForDayAt(H, M, tz, nextDayStartMs(dayMs, tz));
  }
  return out;
}

export function nextSlot(rule, fromSec) {
  return nextSlots(rule, fromSec, 1)[0];
}

// Exposed for tests.
export const _test = { offsetMinutes, wallToEpochMs, parseTimeOfDay };
