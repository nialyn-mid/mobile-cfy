/**
 * Prompt identity across a disconnection.
 *
 * When the link to ComfyUI comes back, two questions have to be answered
 * before anything is submitted: is this run's prompt already FINISHED up there
 * (then collect it, do not send it again), and is a run that never got its
 * prompt id perhaps already IN ComfyUI's queue (then adopt the id, do not send
 * it again). Both need the same thing: a way to say "this exact payload" and
 * find it again in the shapes ComfyUI reports.
 *
 * Everything here is pure - no HTTP, no state - so the shape handling (which is
 * where the guessing happens) is unit-testable against every form ComfyUI is
 * known to answer with.
 */

import crypto from 'node:crypto';

/**
 * JSON.stringify with sorted keys, recursively.
 *
 * Key order is not identity: we build the payload one way, ComfyUI may
 * re-serialize it another, and a fingerprint that changed because a dictionary
 * was rebuilt would make our own prompt look like somebody else's.
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/**
 * A short hash of a whole payload graph. Short because it is compared, not
 * displayed - 16 hex chars is 64 bits, and these are compared within one
 * ComfyUI's own queue, not across the internet.
 */
export function fingerprintOf(graph) {
  return crypto.createHash('sha256').update(stableStringify(graph)).digest('hex').slice(0, 16);
}

/** Does this look like an API-format graph? One node with a class_type is enough. */
function looksLikeGraph(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  for (const n of Object.values(v)) {
    if (n && typeof n === 'object' && typeof n.class_type === 'string') return true;
  }
  return false;
}

/**
 * The graph inside a /history entry, or null when this shape does not carry one.
 *
 * The entry's `prompt` field has come in three forms: the graph itself, the
 * legacy `[client_id, extra_data, graph]` triple, and an object wrapping the
 * graph under `.prompt`. Guessing wrong here would compare a fingerprint
 * against a tuple and never match - which degrades to "resubmit", today's
 * behavior - so each candidate is validated as a graph before being returned.
 */
export function graphFromHistoryEntry(entry) {
  const p = entry?.prompt;
  if (looksLikeGraph(p)) return p;
  if (Array.isArray(p)) {
    for (const c of [p[2], p[0]]) if (looksLikeGraph(c)) return c;
    return null;
  }
  if (p && typeof p === 'object' && looksLikeGraph(p.prompt)) return p.prompt;
  return null;
}

/**
 * The graph inside one /queue item.
 *
 * The documented positional form is `[number, prompt_id, prompt, extra_data,
 * node_errors]` - index 2 is the graph itself - but the object-wrapped form
 * (`{prompt: ...}`) appears in older builds, so both are tried and validated.
 */
export function graphFromQueueItem(item) {
  if (Array.isArray(item)) {
    if (looksLikeGraph(item[2])) return item[2];
    if (item[2] && typeof item[2] === 'object' && looksLikeGraph(item[2].prompt)) return item[2].prompt;
    return null;
  }
  if (item && typeof item === 'object') {
    if (looksLikeGraph(item.prompt)) return item.prompt;
    if (looksLikeGraph(item)) return item;
  }
  return null;
}

/**
 * The first pair whose graph hashes to `fp`. Pairs are `{id, graph}` with the
 * graph ALREADY extracted by `graphFromQueueItem` / `graphFromHistoryEntry` -
 * extraction is where the shape guessing happens, and it happens once per
 * candidate, not once per comparison.
 */
export function findByFingerprint(pairs, fp) {
  if (!fp) return null;
  for (const { id, graph } of pairs) {
    if (id && graph && fingerprintOf(graph) === fp) return { id };
  }
  return null;
}
