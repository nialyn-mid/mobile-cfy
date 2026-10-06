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

/** Where does the prompt text go? Mirrors the workflow's own routing. */
export function promptTarget({ promptEnhance = true } = {}) {
  return promptEnhance ? 'enhanced' : 'raw';
}

/**
 * The aspect ratios node 9 "Resolution Selector" accepts, exactly as spelled in
 * its own dropdown. The node is a COMBO, so an unrecognised string makes ComfyUI
 * fall back to the first entry - which is why the value is validated, not trusted.
 */
export const ASPECT_RATIOS = [
  '1:1 (Square)',
  '2:3 (Portrait Photo)',
  '3:2 (Photo)',
  '3:4 (Portrait Standard)',
  '4:3 (Standard)',
  '9:16 (Portrait Widescreen)',
  '16:9 (Widescreen)',
  '21:9 (Ultrawide)',
];

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
  const target = promptTarget({ promptEnhance });

  // --- prompt + gates ------------------------------------------------------
  // Node 176 picks tt_value (59, the enhancer chain) or ff_value (44, the raw
  // text), and its output feeds node 229's text encoder AND node 181's SaveText.
  // The enhancer takes the reference images itself (226 "Image 1..4"), so images
  // no longer force the raw branch - a prompt with references is enhanced too.
  const promptBinding = target === 'raw' ? b.promptRaw : b.promptEnhanced;
  setBinding(wf, promptBinding, run.prompt);
  setBinding(wf, b.enhanceSwitch, promptEnhance);
  setBinding(wf, b.imageCount, imageCount);

  // --- postprompt ----------------------------------------------------------
  // Node 257 joins node 176's output (enhanced or raw) with node 256
  // "Postprompt" using `delimiter: ""`, and 257's output is what reaches both
  // the text encoder (229) and SaveText (181). So this is not a comment on the
  // prompt: it is read by the model, and it shows up in the captured text
  // without anything special being done to capture it.
  //
  // Written only when non-blank, so an empty box leaves the workflow's own value
  // alone (it ships as "\n"), and deliberately NOT trimmed: with no delimiter, a
  // postprompt that starts with a blank line is exactly how you separate it
  // from the prompt above it, and trimming would eat that.
  if (typeof run.postprompt === 'string' && run.postprompt.trim() !== '') {
    setBinding(wf, b.postprompt, run.postprompt);
  }

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
  // Node 232 "Input Megapixels" is a float now, and feeds node 9 and the
  // enhancer's "Target Megapixels" from one place.
  if (run.megapixels !== null && run.megapixels !== undefined) {
    setBinding(wf, b.megapixels, run.megapixels);
  }
  // Aspect: with 233 on, the enhancer's suggestion wins (nodes 240/241, picked by
  // 234/235) and node 9's combo is ignored. Without the enhancer there is nothing
  // to suggest, so 233 is forced off however the request was phrased - otherwise
  // the run silently keeps whatever the editor last had.
  const useSuggested = promptEnhance && run.useSuggestedAspect === true;
  setBinding(wf, b.useSuggestedAspect, useSuggested);
  if (run.aspectRatio !== null && run.aspectRatio !== undefined && run.aspectRatio !== '') {
    setBinding(wf, b.aspectRatio, run.aspectRatio);
  }
  // Text-encoder input resolution. Blank in the UI means "leave the workflow's
  // own value alone", so this has to be a no-op when unset - writing 0 here
  // would ask the encoder for a 0px input.
  if (run.inputResolution !== null && run.inputResolution !== undefined) {
    setBinding(wf, b.inputResolution, run.inputResolution);
  }
  // Consistency LoRA. null = leave node 207 as the workflow has it.
  if (run.consistency !== null && run.consistency !== undefined) {
    setBinding(wf, b.consistencyLora, run.consistency === true);
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

/**
 * Pull text entries out of a /history outputs object, from SaveText-style nodes.
 * promptTextNodes: [] captures nothing; a list keeps only those node ids.
 *
 * Node 181 "Save Text" is wired to node 178 "Switch (Any)" - the very node the
 * text encoder (5) reads - so its contents are the prompt the image was ACTUALLY
 * made from. That is the whole point: when the enhancer is on, the file holds the
 * enhanced wording; when it was bypassed (no references, or enhance toggled off)
 * the file holds the raw prompt instead, and the UI says so.
 *
 * Unlike collectImages, an EMPTY list means OFF, not "all".
 */
export function collectText(outputs, promptTextNodes = []) {
  // NB: the opposite default to collectImages. There, [] means "every SaveImage",
  // because there are only two of them. Here, [] means OFF: a workflow can grow
  // arbitrary text outputs, and silently reading all of them would fetch files
  // nobody asked for.
  const want = new Set((promptTextNodes ?? []).map(id));
  if (want.size === 0) return [];
  const out = [];
  for (const [nodeId, val] of Object.entries(outputs ?? {})) {
    if (!want.has(id(nodeId))) continue;
    // SaveText's history output is shaped { text: ["the string"], files: [{filename,
    // subfolder, type}] } - the text itself is inlined, the file descriptor is a
    // separate key. Older/other text nodes can instead give objects in `text`,
    // so accept both and normalise to strings.
    const strings = [];
    for (const t of val?.text ?? []) {
      if (typeof t === 'string') strings.push(t);
      else if (t && typeof t.text === 'string') strings.push(t.text);
    }
    const files = (val?.files ?? []).filter((f) => f?.filename);
    if (!strings.length && !files.length) continue;
    out.push({ node: id(nodeId), texts: strings, files });
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

  // Free text, but it is written into a PrimitiveStringMultiline and joined onto
  // the prompt, so a non-string from a bad client is refused rather than
  // stringified into the literal "[object Object]". Blank is legitimate: it means
  // "leave node 256 as the workflow has it", and it is NOT trimmed, because the
  // leading newlines are how you separate the postprompt from the prompt above it.
  if (input?.postprompt !== null && input?.postprompt !== undefined
      && typeof input.postprompt !== 'string') {
    errors.push('postprompt must be text');
  }
  const postprompt = typeof input?.postprompt === 'string' ? input.postprompt : '';

  const megapixels = Number(input?.megapixels);
  if (!(Number.isFinite(megapixels) && megapixels > 0)) {
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
  // null/undefined means "leave the workflow's own node 204 value alone".
  // Anything else has to be a sane pixel size or the text encoder will choke.
  let inputResolution = input?.inputResolution;
  if (typeof inputResolution === 'string' && inputResolution.trim() === '') inputResolution = null;
  if (inputResolution !== null && inputResolution !== undefined) {
    if (!Number.isInteger(inputResolution) || inputResolution < 64 || inputResolution > 8192) {
      errors.push('inputResolution must be blank or an integer between 64 and 8192');
      inputResolution = null;
    }
  } else {
    inputResolution = null;
  }

  // Aspect. Node 9's combo only lists these eight strings and ComfyUI silently
  // falls back to the first one on a miss, so an unknown value is rejected here
  // rather than quietly producing square images.
  const promptEnhance = input?.promptEnhance !== false;
  const aspectRatio = input?.aspectRatio ?? '1:1 (Square)';
  if (!ASPECT_RATIOS.includes(aspectRatio)) {
    errors.push(`aspectRatio must be one of: ${ASPECT_RATIOS.join(', ')}`);
  }
  // The suggested aspect is produced by the enhancer, so asking for it without
  // the enhancer is not an error - it is quietly downgraded to the dropdown.
  const useSuggestedAspect = promptEnhance && input?.useSuggestedAspect === true;

  // null = leave node 207 alone. Anything truthy turns the LoRA on.
  const consistency = input?.consistency === null || input?.consistency === undefined
    ? null
    : input.consistency === true;

  // null = roll a fresh seed per run, which is what happened before the field
  // existed. A pinned seed makes a job reproducible, so every run of it gets
  // the SAME seed - with batch > 1 that means identical images, which is why the
  // page warns about it rather than the API refusing.
  const seed = parseSeed(input?.seed, errors);

  // Count with the same normaliser the runner uses, so a 5th image is reported
  // as a 400 instead of being silently dropped at staging time.
  const normalized = normalizeSlots(input, maxImages + 1);
  const filled = normalized.filter(Boolean).length;
  if (filled > maxImages) errors.push(`at most ${maxImages} images`);

  return {
    ok: errors.length === 0,
    errors,
    prompt,
    postprompt,
    megapixels,
    refresh,
    inputResolution,
    promptEnhance,
    useSuggestedAspect,
    aspectRatio,
    consistency,
    seed,
    slots: normalized.slice(0, maxImages),
  };
}

/**
 * Seed rule, shared by both workflows: blank (or missing) = roll a fresh one,
 * anything else must be a whole number of at least 0. Junk is reported and
 * treated as blank rather than aborting the run with a NaN in the payload.
 */
function parseSeed(value, errors) {
  let seed = value;
  if (typeof seed === 'string') seed = seed.trim() === '' ? null : Number(seed);
  if (seed === null || seed === undefined) return null;
  if (!Number.isSafeInteger(seed) || seed < 0) {
    errors.push('seed must be blank or a whole number of at least 0');
    return null;
  }
  return seed;
}

// ------------------------------------------------------------------- upscale

/**
 * The Upscale tab runs a SECOND workflow (upscale_api.json, see
 * `upscaleWorkflowFile`) with its own bindings: one image in, one image out.
 * These two mirror validateJob / buildRunPayload for it and are deliberately
 * separate rather than parameterised - the two graphs share no inputs, and a
 * merged version would carry flags for features the other half does not have.
 */

/** Widest useful multiplier. Nodes 502/503 also cap the to-dim factor at 4. */
const SCALE_MAX = 16;

/** Target width/height bounds. Node 506 encodes at these numbers. */
const DIM_MIN = 64;
const DIM_MAX = 8192;

/**
 * Node 506's `batch_size` is the number of latents the upscale samples in one
 * pass, and every one of them is held in VRAM at once at the target size - so
 * this is capped well below the Generate tab's unbounded batch.
 */
const UP_BATCH_MAX = 8;

export function validateUpscale(input, { maxImages = 4 } = {}) {
  const errors = [];

  // The graph has ONE LoadImage, so a second reference has nowhere to go. Say so
  // instead of quietly using the first and dropping the rest.
  const slots = normalizeSlots(input, maxImages + 1);
  const filled = slots.filter(Boolean).length;
  if (filled === 0) errors.push('an image to upscale is required');
  else if (filled > 1) errors.push('one image at a time - the upscale workflow has a single image input');

  // A boolean is a number in JavaScript (`Number(true) === 1`), which would turn a
  // stray `true` in a hand-written request into "upscale by 1" instead of an
  // error. The page sends a string or a number; nothing else means a real scale.
  let scale = input?.scale === null || input?.scale === undefined || input.scale === '' ? 2 : Number(input.scale);
  if (typeof input?.scale === 'boolean' || !(Number.isFinite(scale) && scale > 0 && scale <= SCALE_MAX)) {
    errors.push(`scale must be a number above 0 and at most ${SCALE_MAX}`);
    scale = 2;
  }

  const scaleToDim = input?.scaleToDim === true;

  // The target size is only READ when the switch is on: 527/530 then take 502/503,
  // which fold both numbers into one factor k = min(4, sqrt(W*H / (w*h))) and
  // scale by it. Off means "width x scale, height x scale", so the two numbers are
  // ignored rather than reported - they are not a mistake, just unused.
  let targetWidth = null;
  let targetHeight = null;
  if (scaleToDim) {
    for (const key of ['targetWidth', 'targetHeight']) {
      const raw = input?.[key];
      const n = typeof raw === 'string' && raw.trim() === '' ? NaN : Number(raw);
      if (!Number.isInteger(n) || n < DIM_MIN || n > DIM_MAX) {
        errors.push(`${key} must be a whole number between ${DIM_MIN} and ${DIM_MAX}`);
      } else if (key === 'targetWidth') targetWidth = n;
      else targetHeight = n;
    }
  }

  // Node 543 concatenates the workflow's own "Upscale Prompt" (522) with this,
  // so the box ADDS to that fixed instruction rather than replacing it.
  const guidance = typeof input?.guidance === 'string' ? input.guidance.trim() : '';

  // One graph pass, N images out of it (node 506 `batch_size`). Blank means one,
  // the way a blank multiplier means 2. A boolean is refused for the same reason
  // `scale` refuses one: `Number(true) === 1` would quietly mean "one image".
  const rawBatch = typeof input?.batch === 'string' && input.batch.trim() === '' ? 1 : Number(input?.batch ?? 1);
  let batch = 1;
  if (typeof input?.batch === 'boolean' || !(Number.isInteger(rawBatch) && rawBatch >= 1 && rawBatch <= UP_BATCH_MAX)) {
    errors.push(`batch must be a whole number between 1 and ${UP_BATCH_MAX}`);
  } else {
    batch = rawBatch;
  }

  const seed = parseSeed(input?.seed, errors);

  return {
    ok: errors.length === 0,
    errors,
    scale,
    scaleToDim,
    targetWidth,
    targetHeight,
    guidance,
    batch,
    seed,
    slots: slots.slice(0, maxImages),
  };
}

/**
 * `run` needs { image, scale, scaleToDim, targetWidth, targetHeight, guidance,
 * seed }, where `image` is the name ComfyUI knows the file by - the runner has
 * already uploaded it by the time this runs.
 */
export function buildUpscalePayload(workflow, bindings, run) {
  const wf = structuredClone(workflow);
  const b = bindings ?? {};
  const toDim = run.scaleToDim === true;

  setBinding(wf, b.scale, run.scale);
  setBinding(wf, b.scaleToDim, toDim);
  // 530 is the height half of the same switch and ships wired to a hard `false`.
  // Leaving it would scale the height by the plain multiplier while the width
  // came from the target - a shape nobody asked for. Both follow the one toggle.
  setBinding(wf, b.scaleToDimHeight, toDim);
  if (toDim) {
    if (run.targetWidth !== null && run.targetWidth !== undefined) setBinding(wf, b.targetWidth, run.targetWidth);
    if (run.targetHeight !== null && run.targetHeight !== undefined) setBinding(wf, b.targetHeight, run.targetHeight);
  }
  // Blank guidance = no extra instructions, and the editor's own text is left
  // alone rather than overwritten with an empty string. Trimmed here too, so a
  // direct caller cannot write a box of spaces into the graph.
  const guidance = typeof run.guidance === 'string' ? run.guidance.trim() : '';
  if (guidance) setBinding(wf, b.guidance, guidance);
  setBinding(wf, b.seed, run.seed ?? newSeed());
  if (run.image) setBinding(wf, b.image, run.image);
  // 506's batch_size IS the latent size (its output 2 feeds 541), so this is the
  // only place the count has to go - there is no RepeatLatentBatch in the graph.
  setBinding(wf, b.batch, run.batch ?? 1);

  return wf;
}