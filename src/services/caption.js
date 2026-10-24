/**
 * Caption-template rendering for rotation rules (Section 9).
 *
 *   {filename}  — the source file's name without extension
 *   {index}     — the channel's running count (1, 2, 3, ...)
 *   {date}      — the scheduled date, YYYY-MM-DD
 *
 * Returns "" when no template is set (video-only valid for some platforms).
 */
export function renderCaption(template, ctx = {}) {
  if (template == null) return "";
  const { filename = "", index = 0, date = null } = ctx;
  const stem = String(filename).replace(/\.[^.]+$/, "");
  const when =
    date == null
      ? new Date().toISOString().slice(0, 10)
      : date instanceof Date
        ? date.toISOString().slice(0, 10)
        : new Date(date).toISOString().slice(0, 10);
  return String(template)
    .replace(/\{filename\}/g, stem)
    .replace(/\{index\}/g, String(index))
    .replace(/\{date\}/g, when);
}
