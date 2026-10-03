import crypto from 'node:crypto';

// The bash script drew a 32-bit value with `od -An -N4 -tu4 < /dev/urandom`.
// Keep the same range so seeds look and behave identically.
export function newSeed() {
  return crypto.randomInt(0, 2 ** 32);
}

const id = (n) => String(n);

/**
 * Write one value through one binding. A null/empty node id disables the
 * binding entirely, so an unused feature never reaches the payload.
 */
export function setBinding(workflow, binding, value) {
  if (!binding || binding.node === null || binding.node === undefined || binding.node === '') {
    return false;
  }
  const node = workflow[id(binding.node)];
  if (!node) throw new Error(`node ${binding.node} is not in the workflow`);
  if (!node.inputs || typeof node.inputs !== 'object') node.inputs = {};
  node.inputs[binding.input] = value;
  return true;
}

export function readBinding(workflow, binding) {
  const node = binding?.node ? workflow[id(binding.node)] : null;
  return node?.inputs?.[binding.input];
}

/**
 * shuffle groups x batch, sequential.
 *
 * `refresh` decides when the override switch (node 68) is thrown:
 *   'firstOfGroup' - only run #1 of each group refreshes, so runs 2..N reuse the
 *                    workflow's memorised enhanced prompt and vary only by seed
 *                    (the cheap, default behaviour: one enhancement, N images).
 *   'everyRun'     - every run re-enhances the prompt from scratch, which is
 *                    slower but gives each image its own wording.
 * `isFirstOfGroup` is still reported separately for grouping/display.
 */
export const REFRESH_MODES = ['firstOfGroup', 'everyRun'];

export function planRuns({ batch = 1, shuffle = 1, refresh = 'firstOfGroup' } = {}) {
  const everyRun = refresh === 'everyRun';
  const runs = [];
  for (let group = 0; group < shuffle; group++) {
    for (let i = 0; i < batch; i++) {
      runs.push({
        group,
        indexInGroup: i,
        isFirstOfGroup: i === 0,
        refreshOverride: everyRun || i === 0,
      });
    }
  }
  return runs;
}

/** Where does the prompt text go? Mirrors the workflow's own node 155 logic. */
export function promptTarget({ promptEnhance = true, imageCount = 0 } = {}) {
  return imageCount > 0 || !promptEnhance ? 'raw' : 'enhanced';
}

/**
 * Pack the chosen images into the LoadImage slots, contiguously from slot 1.
 *
 * The workflow routes by COUNT (node 158 "Image Count"), not by a per-slot switch:
 * 0 = text-to-image, N = the first N references are used. Nodes 160/164/167/169
 * gate slots 1..4 on `(count - n) >= 0`, so a gap is unrepresentable - which is
 * also why unfilled slots need no placeholder. Packing keeps payload count and
 * slot contents in agreement: `['a', null, 'c']` becomes `['a', 'c']` at count 2.
 */
export function resolveImageSlots(bindings, images) {
  const slots = Array.isArray(bindings?.images) ? bindings.images : [];
  const chosen = (Array.isArray(images) ? images : []).filter(Boolean);
  return Array.from({ length: slots.length }, (_, i) => chosen[i] ?? null);
}

/**
 * Build the payload for a single run. `workflow` is not mutated.
 *
 * run: { prompt, images[], promptEnhance, turbo, stepsOverride, megapixels,
 *        isFirstOfGroup, seed }
 */
export function buildRunPayload(workflow, bindings, run) {
  const wf = structuredClone(workflow);
  const b = bindings ?? {};
  const promptEnhance = run.promptEnhance !== false;
  const turbo = run.turbo === true;

  // --- reference images: pack first, then drive the count -------------------
  const slots = resolveImageSlots(b, run.images);
  const imageCount = slots.filter(Boolean).length;
  const target = promptTarget({ promptEnhance, imageCount });

  // --- prompt + gates ------------------------------------------------------
  // Node 165 turns imageCount > 0 into a boolean, and the workflow's node 155
  // then routes to the raw prompt, bypassing 41/43. We only choose a target.
  const promptBinding = target === 'raw' ? b.promptRaw : b.promptEnhanced;
  setBinding(wf, promptBinding, run.prompt);
  setBinding(wf, b.enhanceSwitch, promptEnhance && imageCount === 0);
  setBinding(wf, b.imageCount, imageCount);

  // --- shuffle / turbo switches -------------------------------------------
  // `refreshOverride` is the actual override value; fall back to the older
  // `isFirstOfGroup` shape so a hand-built run object still behaves sensibly.
  const refresh = run.refreshOverride ?? run.isFirstOfGroup ?? true;
  const sh = b.shuffleSwitch;
  if (sh?.activeValue !== undefined || sh?.inactiveValue !== undefined) {
    setBinding(wf, sh, refresh ? (sh.activeValue ?? true) : (sh.inactiveValue ?? false));
  } else {
    setBinding(wf, sh, refresh);
  }
  const tu = b.turboSwitch;
  if (tu?.turboValue !== undefined || tu?.normalValue !== undefined) {
    setBinding(wf, tu, turbo ? (tu.turboValue ?? true) : (tu.normalValue ?? false));
  } else {
    setBinding(wf, tu, turbo);
  }

  // --- steps ---------------------------------------------------------------
  if (run.stepsOverride !== null && run.stepsOverride !== undefined) {
    setBinding(wf, b.stepsTurbo, run.stepsOverride);
    setBinding(wf, b.stepsFull, run.stepsOverride);
  }

  // --- resolution + seed ---------------------------------------------------
  if (run.megapixels !== null && run.megapixels !== undefined) {
    setBinding(wf, b.megapixels, run.megapixels);
  }
  setBinding(wf, b.seed, run.seed ?? newSeed());

  // --- reference images ----------------------------------------------------
  // Only the first `imageCount` slots are read by the workflow, so the tail is
  // left at the workflow's own default and never needs a placeholder.
  slots.forEach((name, i) => {
    if (name) setBinding(wf, b.images?.[i], name);
  });

  return wf;
}

/**
 * Pull image entries out of a /history outputs object.
 * collectNodes: [] keeps every node; a list keeps only those node ids.
 */
export function collectImages(outputs, collectNodes = []) {
  const want = new Set((collectNodes ?? []).map(id));
  const all = Array.isArray(collectNodes) && collectNodes.length === 0;
  const out = [];
  for (const [nodeId, val] of Object.entries(outputs ?? {})) {
    if (!all && !want.has(id(nodeId))) continue;
    for (const img of val?.images ?? []) {
      if (img?.filename) out.push({ node: id(nodeId), ...img });
    }
  }
  return out;
}

// --------------------------------------------------------------- validation

/**
 * Accept every slot shape a client might send and normalise to a sparse array of
 * `{uploadId}` / `{ref}` descriptors. Shared with the runner so validation and
 * staging can never disagree about how many images a request really has.
 *
 * Accepted forms, in precedence order: `slots` (array), `uploadIds`, `imageRefs`.
 */
export function normalizeSlots(input, maxImages = 4) {
  const raw = [
    ...(Array.isArray(input?.slots) ? input.slots : []),
    ...(Array.isArray(input?.uploadIds) ? input.uploadIds : []),
    ...(Array.isArray(input?.imageRefs) ? input.imageRefs : []),
  ];

  const slots = new Array(maxImages).fill(null);
  raw.forEach((v, i) => {
    if (i >= maxImages) return;
    if (v === null || v === undefined || v === '') return;
    if (typeof v === 'string') slots[i] = { uploadId: v };
    else if (v.uploadId) slots[i] = { uploadId: v.uploadId };
    else if (v.ref) slots[i] = { ref: v.ref };
  });
  return slots;
}

export function validateJob(input, { maxImages = 4 } = {}) {
  const errors = [];
  const prompt = typeof input?.prompt === 'string' ? input.prompt.trim() : '';
  if (!prompt) errors.push('prompt is required');

  const megapixels = input?.megapixels;
  if (!(typeof megapixels === 'number' && Number.isFinite(megapixels) && megapixels > 0)) {
    errors.push('megapixels must be a positive number');
  }
  for (const [key, min] of [['batch', 1], ['shuffle', 1]]) {
    const v = input?.[key];
    if (!(Number.isInteger(v) && v >= min)) errors.push(`${key} must be an integer >= ${min}`);
  }
  const refresh = input?.refresh ?? 'firstOfGroup';
  if (!REFRESH_MODES.includes(refresh)) {
    errors.push(`refresh must be one of ${REFRESH_MODES.join(', ')}`);
  }
  const steps = input?.stepsOverride;
  if (steps !== null && steps !== undefined && !(Number.isInteger(steps) && steps >= 1)) {
    errors.push('stepsOverride must be null or an integer >= 1');
  }

  // Count with the same normaliser the runner uses, so a 5th image is reported
  // as a 400 instead of being silently dropped at staging time.
  const normalized = normalizeSlots(input, maxImages + 1);
  const filled = normalized.filter(Boolean).length;
  if (filled > maxImages) errors.push(`at most ${maxImages} images`);

  return { ok: errors.length === 0, errors, prompt, megapixels, refresh, slots: normalized.slice(0, maxImages) };
}