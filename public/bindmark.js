/**
 * The one place that decides what a binding row shows.
 *
 * Both the row renderer and the checker ask it, so the two cannot disagree - and
 * "they disagreed" was a real bug: a row painted a tick from a stale map while the
 * summary line said "1 problem", and the eye believed the tick.
 *
 * Pure and DOM-free on purpose: this is the part worth unit testing.
 *
 * @param {null|{ok?: boolean, disabled?: boolean, title?: string|null,
 *              classType?: string, reason?: string}} rec
 *        the record from /api/config/validate, or null when it has not been
 *        checked yet
 * @param {(s: string) => string} escapeHtml
 * @returns {{html: string, bad: boolean}} the markup for the row's status line
 *          and whether the row should be highlighted
 */
export function bindingMark(rec, escapeHtml) {
  if (!rec) return { html: '<span class="ok">–</span> <b>not checked yet</b>', bad: false };
  if (rec.disabled) return { html: '<span class="ok">–</span> <b>disabled</b>', bad: false };
  if (rec.ok) {
    return {
      html: `<span class="ok">✓</span> <b>${escapeHtml(rec.title ?? '')}</b> ${escapeHtml(rec.classType ?? '')}`,
      bad: false,
    };
  }
  return { html: `<span class="no">✗</span> <b>${escapeHtml(rec.reason ?? '')}</b>`, bad: true };
}