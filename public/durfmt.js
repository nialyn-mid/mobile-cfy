/**
 * Run timers, in the one file that can be tested without a browser.
 *
 * Two reasons this is not inline in app.js:
 *
 *  - The format is a promise ("2:05, not 125s"), and a promise nobody checks is
 *    not one. `app.js` boots everything at module scope, so testing it means
 *    building a DOM stub - the thing that was tried and abandoned.
 *  - The app ticks these on its own clock. Formatting is the part that must not
 *    drift or change shape, so it lives on its own.
 *
 * The app still decides *whether* to show a timer: a run handed to ComfyUI but not
 * yet picked up has no `startedAt`, and gets no timer at all rather than a
 * wrong one.
 */

/**
 * 0 -> "0:00", 95_000 -> "1:35", 3_725_000 -> "1:02:05".
 *
 * Rounded to the nearest second, never negative, never "NaN".
 */
export function fmtDuration(ms) {
  const n = Number(ms);
  const total = Math.max(0, Math.round((Number.isFinite(n) ? n : 0) / 1000));
  const pad = (v) => String(v).padStart(2, '0');
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * One run's timer text, or '' when it has not started.
 *
 * `endedAt` freezes it: a finished run's timer stops for good instead of counting
 * up forever, which is what makes a 1s tick in the page safe.
 */
export function durationBetween(startedAt, endedAt, now = Date.now()) {
  if (!startedAt) return '';
  const from = Date.parse(startedAt);
  if (!Number.isFinite(from)) return '';
  const to = endedAt ? Date.parse(endedAt) : now;
  if (!Number.isFinite(to)) return '';
  return fmtDuration(to - from);
}