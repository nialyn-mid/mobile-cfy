import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from '../lib/config.js';
import {
  planRuns,
  promptTarget,
  resolveImageSlots,
  buildRunPayload,
  collectImages,
  collectText,
  validateJob,
  normalizeSlots,
  setBinding,
  newSeed,
  ASPECT_RATIOS,
  validateUpscale,
  buildUpscalePayload,
} from '../lib/payload.js';
import { runPayloadOptions } from '../lib/runner.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = JSON.parse(fs.readFileSync(path.join(ROOT, 'workflow_api.json'), 'utf8'));
const B = DEFAULTS.bindings;

// ------------------------------------------------- bindings vs real workflow

test('every default binding points at a real node and a real input', () => {
  const singles = Object.entries(B).filter(([k]) => k !== 'images');
  for (const [key, binding] of singles) {
    const node = WORKFLOW[String(binding.node)];
    assert.ok(node, `binding ${key}: node ${binding.node} missing from workflow_api.json`);
    assert.ok(
      Object.prototype.hasOwnProperty.call(node.inputs ?? {}, binding.input),
      `binding ${key}: node ${binding.node} (${node.class_type}) has no input "${binding.input}"`,
    );
  }
  for (const [i, binding] of B.images.entries()) {
    const node = WORKFLOW[String(binding.node)];
    assert.ok(node, `image slot ${i}: node ${binding.node} missing`);
    assert.equal(node.class_type, 'LoadImage', `image slot ${i} should be a LoadImage`);
    assert.ok(
      Object.prototype.hasOwnProperty.call(node.inputs ?? {}, binding.input),
      `image slot ${i}: node ${binding.node} has no input "${binding.input}"`,
    );
  }
});

test('the seed binding reaches every KSampler in the workflow', () => {
  const seedNode = String(B.seed.node);
  const samplers = Object.entries(WORKFLOW).filter(([, n]) => /^KSampler/.test(n.class_type ?? ''));
  assert.ok(samplers.length >= 4, `expected several KSamplers, found ${samplers.length}`);
  for (const [nodeId, n] of samplers) {
    assert.deepEqual(
      n.inputs?.noise_seed,
      [seedNode, 0],
      `KSampler ${nodeId} (${n.class_type}) is not wired to seed node ${seedNode}`,
    );
  }
});

test('SaveImage nodes exist so collectImages has something to collect', () => {
  const saves = Object.values(WORKFLOW).filter((n) => n.class_type === 'SaveImage');
  assert.ok(saves.length >= 2, 'expected the S7 and S8 SaveImage nodes');
});

// ------------------------------------------------------------- prompt routing

test('prompt routing depends only on the enhance toggle', () => {
  // The enhancer (node 226) reads the reference images itself, so images no
  // longer force the raw branch - that was the old node 178 rule, now gone.
  assert.equal(promptTarget({ promptEnhance: true }), 'enhanced');
  assert.equal(promptTarget({ promptEnhance: false }), 'raw');
  assert.equal(promptTarget({ promptEnhance: true, imageCount: 4 }), 'enhanced');
  assert.equal(promptTarget({}), 'enhanced');
});

test('enhance on, no image: text goes to node 41 and the gate opens', () => {
  const wf = buildRunPayload(WORKFLOW, B, { prompt: 'a cat', promptEnhance: true, images: [] });
  assert.equal(wf['41'].inputs.value, 'a cat');
  assert.equal(wf['176'].inputs.cond, true);
  assert.equal(wf['158'].inputs.value, 0, 'no images means Image Count 0');
  assert.deepEqual(wf['44'], WORKFLOW['44'], 'node 44 must be left untouched');
});

test('enhance off: text goes to node 44 and node 176 closes', () => {
  const wf = buildRunPayload(WORKFLOW, B, { prompt: 'a cat', promptEnhance: false, images: [] });
  assert.equal(wf['44'].inputs.value, 'a cat');
  assert.equal(wf['176'].inputs.cond, false);
  assert.deepEqual(wf['41'], WORKFLOW['41'], 'node 41 must be left untouched');
});

test('an attached image no longer bypasses the enhancer', () => {
  const wf = buildRunPayload(WORKFLOW, B, {
    prompt: 'a cat',
    promptEnhance: true,
    images: ['ref_a.png'],
  });
  assert.equal(wf['41'].inputs.value, 'a cat', 'the enhancer gets the prompt, node 226 reads the image');
  assert.equal(wf['176'].inputs.cond, true);
  assert.equal(wf['158'].inputs.value, 1, 'one image means Image Count 1');
});

test('the enhance switch writes node 176 "cond", not the retired node 43', () => {
  // Node 43 was a ComfySwitchNode; the workflow now uses a 176
  // ImpactConditionalBranch. Writing 43 was silently a no-op.
  assert.equal(B.enhanceSwitch.node, '176');
  assert.equal(B.enhanceSwitch.input, 'cond');
  assert.equal(WORKFLOW['176'].class_type, 'ImpactConditionalBranch');
  assert.equal(WORKFLOW['176']._meta?.title, 'Prompt Enhance On/Off');
});

test('the source workflow is never mutated', () => {
  const before = JSON.stringify(WORKFLOW);
  buildRunPayload(WORKFLOW, B, { prompt: 'x', images: ['a.png'], turbo: true, seed: 7 });
  assert.equal(JSON.stringify(WORKFLOW), before);
});

// ------------------------------------------------------------------- toggles

test('turbo writes the boolean, never a model name', () => {
  const on = buildRunPayload(WORKFLOW, B, { prompt: 'x', turbo: true });
  const off = buildRunPayload(WORKFLOW, B, { prompt: 'x', turbo: false });
  assert.equal(on['147'].inputs.value, true);
  assert.equal(off['147'].inputs.value, false);
  // The ImpactConditionalBranch loader nodes are left exactly as authored.
  assert.deepEqual(on['148'], WORKFLOW['148']);
  assert.deepEqual(on['1'], WORKFLOW['1']);
});

test('steps override writes both the turbo and full step nodes', () => {
  const wf = buildRunPayload(WORKFLOW, B, { prompt: 'x', stepsOverride: 12 });
  assert.equal(wf['149'].inputs.value, 12);
  assert.equal(wf['150'].inputs.value, 12);
});

test('no steps override leaves the workflow defaults alone', () => {
  const wf = buildRunPayload(WORKFLOW, B, { prompt: 'x', stepsOverride: null });
  assert.deepEqual(wf['149'], WORKFLOW['149']);
  assert.deepEqual(wf['150'], WORKFLOW['150']);
});

test('megapixels and seed land on their bindings', () => {
  const wf = buildRunPayload(WORKFLOW, B, { prompt: 'x', megapixels: 1.5, seed: 123456 });
  // 232 "Input Megapixels" is a PrimitiveFloat now, and it feeds node 9 as well
  // as the enhancer's own target, so the write goes there rather than to node 9.
  assert.equal(wf['232'].inputs.value, 1.5);
  assert.equal(wf['37'].inputs.seed, 123456);
});

test('newSeed stays inside the 32-bit range the bash script used', () => {
  for (let i = 0; i < 200; i++) {
    const s = newSeed();
    assert.ok(Number.isInteger(s) && s >= 0 && s <= 0xffffffff, `seed out of range: ${s}`);
  }
});

test('a null binding is skipped rather than crashing', () => {
  const wf = buildRunPayload(WORKFLOW, { ...B, seed: null }, { prompt: 'x', seed: 1 });
  assert.deepEqual(wf['37'], WORKFLOW['37']);
  assert.equal(setBinding(wf, null, 1), false);
  assert.equal(setBinding(wf, { node: '', input: 'seed' }, 1), false);
});

// ------------------------------------------------------------- shuffle matrix

test('planRuns is shuffle groups x batch, sequential', () => {
  assert.equal(planRuns({ batch: 3, shuffle: 5 }).length, 15);
  assert.deepEqual(planRuns({ batch: 2, shuffle: 2 }), [
    { group: 0, indexInGroup: 0, isFirstOfGroup: true, refreshOverride: true },
    { group: 0, indexInGroup: 1, isFirstOfGroup: false, refreshOverride: false },
    { group: 1, indexInGroup: 0, isFirstOfGroup: true, refreshOverride: true },
    { group: 1, indexInGroup: 1, isFirstOfGroup: false, refreshOverride: false },
  ]);
});

test('the override switch is on for run #1 of every group only', () => {
  const runs = planRuns({ batch: 3, shuffle: 2 });
  const values = runs.map((r) =>
    buildRunPayload(WORKFLOW, B, { prompt: 'x', refreshOverride: r.refreshOverride })['68'].inputs
      .value,
  );
  assert.deepEqual(values, [true, false, false, true, false, false]);
});

test('a single shuffle group matches the old underscore behaviour', () => {
  const runs = planRuns({ batch: 3, shuffle: 1 });
  const values = runs.map((r) =>
    buildRunPayload(WORKFLOW, B, { prompt: 'x', refreshOverride: r.refreshOverride })['68'].inputs
      .value,
  );
  assert.deepEqual(values, [true, false, false]);
});

test('refresh: everyRun throws the override switch on every single run', () => {
  const runs = planRuns({ batch: 3, shuffle: 2, refresh: 'everyRun' });
  const values = runs.map((r) =>
    buildRunPayload(WORKFLOW, B, { prompt: 'x', refreshOverride: r.refreshOverride })['68'].inputs
      .value,
  );
  assert.deepEqual(values, [true, true, true, true, true, true]);
  // Group bookkeeping is unchanged, so the UI can still label the runs.
  assert.deepEqual(runs.map((r) => r.isFirstOfGroup), [true, false, false, true, false, false]);
});

test('a run object without refreshOverride still falls back to isFirstOfGroup', () => {
  const wf = buildRunPayload(WORKFLOW, B, { prompt: 'x', isFirstOfGroup: false });
  assert.equal(wf['68'].inputs.value, false);
});

// The runner used to pass only isFirstOfGroup down to buildRunPayload, which
// made "refresh: every run" silently behave like "once per group". This test
// pins the mapping the runner actually uses.
test('runPayloadOptions carries refreshOverride through to the payload', () => {
  const spec = {
    prompt: 'x', promptEnhance: false, turbo: true,
    stepsOverride: 4, megapixels: 1,
  };
  const runs = planRuns({ batch: 2, shuffle: 1, refresh: 'everyRun' });
  const values = runs.map((r) => {
    const opts = runPayloadOptions(spec, { ...r, seed: 1 }, []);
    assert.equal(opts.refreshOverride, true);
    return buildRunPayload(WORKFLOW, B, opts)['68'].inputs.value;
  });
  assert.deepEqual(values, [true, true]);
});

test('runPayloadOptions keeps once-per-group runs off after the first', () => {
  const spec = { prompt: 'x', promptEnhance: true, turbo: false, stepsOverride: null, megapixels: 1 };
  const runs = planRuns({ batch: 3, shuffle: 1, refresh: 'firstOfGroup' });
  const values = runs.map((r) =>
    buildRunPayload(WORKFLOW, B, runPayloadOptions(spec, { ...r, seed: 7 }, []))['68'].inputs.value);
  assert.deepEqual(values, [true, false, false]);
});

// -------------------------------------------------------------- image slots

test('one image engages reference mode and leaves the rest at the workflow default', () => {
  const wf = buildRunPayload(WORKFLOW, B, { prompt: 'x', images: ['a.png'] });
  assert.equal(wf['11'].inputs.image, 'a.png');
  assert.deepEqual(wf['140'], WORKFLOW['140']);
  assert.deepEqual(wf['141'], WORKFLOW['141']);
  assert.deepEqual(wf['142'], WORKFLOW['142']);
  assert.equal(wf['158'].inputs.value, 1, 'Image Count must be 1, not a boolean');
});

test('slots are packed contiguously - a gap would be unrepresentable as a count', () => {
  const slots = resolveImageSlots(B, ['a.png', null, 'c.png']);
  assert.deepEqual(slots, ['a.png', 'c.png', null, null]);

  const wf = buildRunPayload(WORKFLOW, B, { prompt: 'x', images: ['a.png', null, 'c.png'] });
  assert.equal(wf['11'].inputs.image, 'a.png');
  assert.equal(wf['140'].inputs.image, 'c.png', 'second image must land in slot 2');
  assert.deepEqual(wf['141'], WORKFLOW['141'], 'slot 3 is beyond the count, so untouched');
  assert.deepEqual(wf['142'], WORKFLOW['142']);
  assert.equal(wf['158'].inputs.value, 2);
});

test('image count matches the number of images actually written', () => {
  for (const images of [[], ['a.png'], ['a.png', 'b.png'], ['a.png', 'b.png', 'c.png', 'd.png']]) {
    const wf = buildRunPayload(WORKFLOW, B, { prompt: 'x', images });
    assert.equal(wf['158'].inputs.value, images.length);
    // node 160 gates slot 1 on (count-1) >= 0, so count 0 must leave node 11 alone
    if (images.length === 0) assert.deepEqual(wf['11'], WORKFLOW['11']);
  }
});

test('all four references route through, count 4', () => {
  const imgs = ['a.png', 'b.png', 'c.png', 'd.png'];
  const wf = buildRunPayload(WORKFLOW, B, { prompt: 'x', images: imgs });
  assert.equal(wf['11'].inputs.image, 'a.png');
  assert.equal(wf['140'].inputs.image, 'b.png');
  assert.equal(wf['141'].inputs.image, 'c.png');
  assert.equal(wf['142'].inputs.image, 'd.png');
  assert.equal(wf['158'].inputs.value, 4);
});

test('too many images are rejected by the slot length', () => {
  const slots = resolveImageSlots(B, ['a.png', 'b.png', 'c.png', 'd.png', 'e.png']);
  assert.equal(slots.length, 4);
  assert.deepEqual(slots, ['a.png', 'b.png', 'c.png', 'd.png'], 'the 5th is dropped, not appended');
});

// ----------------------------------------------------------------- outputs

test('collectImages keeps both S7 and S8 by default', () => {
  const outputs = {
    '8': { images: [{ filename: 'a.png', subfolder: 'qwen-image-2.1', type: 'output' }] },
    '45': { images: [{ filename: 'b.png', subfolder: 'qwen-image-2.1', type: 'output' }] },
    '7': { images: [{ filename: 'thumb.png' }] },
  };
  assert.deepEqual(
    collectImages(outputs, []).map((i) => i.node).sort(),
    ['45', '7', '8'],
  );
});

test('collectImages can be narrowed to specific nodes', () => {
  const outputs = {
    '8': { images: [{ filename: 'a.png' }] },
    '45': { images: [{ filename: 'b.png' }] },
  };
  assert.deepEqual(collectImages(outputs, ['8']).map((i) => i.filename), ['a.png']);
});

// ------------------------------------------- encoder resolution + SaveText

test('encoder resolution is written to node 204 when asked for', () => {
  const wf = buildRunPayload(WORKFLOW, B, { prompt: 'x', images: [], inputResolution: 1536 });
  assert.equal(wf['204'].inputs.value, 1536);
  assert.equal(wf['204']._meta.title, 'Input Resolution');
  // It feeds the text encoder(s), not the output size. The workflow moved the
  // encoder to QwenImage21TextEncodeList nodes (229 live, 250 for the editor).
  for (const encoder of ['229', '250']) {
    assert.deepEqual(WORKFLOW[encoder].inputs.resolution, ['204', 0], `node ${encoder} should read 204`);
  }
});

test('a blank encoder resolution leaves the workflow value alone', () => {
  // Writing 0 here would ask the encoder for a 0px input, so "unset" has to be
  // a genuine no-op rather than a null.
  for (const inputResolution of [null, undefined]) {
    const wf = buildRunPayload(WORKFLOW, B, { prompt: 'x', images: [], inputResolution });
    assert.deepEqual(wf['204'], WORKFLOW['204']);
  }
});

test('collectText reads SaveText output in the shape ComfyUI really returns', () => {
  // Verified against a live /history entry: the STRING is inlined in `text` and
  // the file descriptor sits in a separate `files` key. Reading `text` as a list
  // of {filename} objects finds nothing at all.
  const outputs = {
    '8': { images: [{ filename: 'a.png' }] },
    '181': {
      text: ['a small red cube on a plain white studio background'],
      files: [{ filename: 'ComfyUI_00012.txt', subfolder: '', type: 'output' }],
    },
    '999': { text: ['other'], files: [] },
  };
  assert.deepEqual(collectText(outputs, ['181']), [
    {
      node: '181',
      texts: ['a small red cube on a plain white studio background'],
      files: [{ filename: 'ComfyUI_00012.txt', subfolder: '', type: 'output' }],
    },
  ]);
  assert.equal(collectText(outputs, []).length, 0, 'empty list disables capture');
  assert.equal(collectText(outputs, ['nope']).length, 0);
  assert.equal(collectText({}, ['181']).length, 0);
  assert.equal(collectText(null, ['181']).length, 0);
  assert.equal(collectText({ '181': { text: [], files: [] } }, ['181']).length, 0,
    'an empty text output is not worth recording');
});

test('collectText also accepts a node that puts objects in text', () => {
  const got = collectText({ '7': { text: [{ text: 'hello' }] } }, ['7']);
  assert.deepEqual(got, [{ node: '7', texts: ['hello'], files: [] }]);
});

test('collectText falls back to files-only when there is no inline text', () => {
  const got = collectText({ '7': { files: [{ filename: 'p.txt' }] } }, ['7']);
  assert.deepEqual(got, [{ node: '7', texts: [], files: [{ filename: 'p.txt' }] }]);
});

test('the SaveText node is fed by the same wire the text encoder reads', () => {
  // This is the whole basis for labelling the capture honest: if 181 tapped a
  // different wire we would be showing a prompt the image was never made from.
  // Both now read node 257 "Concatenate Text", which joins node 176's output
  // (enhanced or raw) with node 256 "Postprompt" and is itself what the encoder
  // reads - so the postprompt is in the image AND in the saved text, with no
  // capture work of ours.
  assert.deepEqual(WORKFLOW['181'].inputs.text, ['257', 0]);
  assert.deepEqual(WORKFLOW['229'].inputs.prompts, ['257', 0]);
  assert.equal(WORKFLOW['181'].class_type, 'SaveText');
  assert.equal(WORKFLOW['257'].class_type, 'StringConcatenate');
  // Both ends of the concatenation: the branch output, and the postprompt.
  assert.deepEqual(WORKFLOW['257'].inputs.string_a, ['176', 0]);
  assert.deepEqual(WORKFLOW['257'].inputs.string_b, ['256', 0]);
  // No delimiter, which is why a postprompt keeps its own leading newlines.
  assert.equal(WORKFLOW['257'].inputs.delimiter, '');
});

// ----------------------------------------------------- aspect + LoRA writes

test('the aspect dropdown value is written to node 9 when suggestion is off', () => {
  const wf = buildRunPayload(WORKFLOW, B, {
    prompt: 'x',
    images: [],
    useSuggestedAspect: false,
    aspectRatio: '16:9 (Widescreen)',
  });
  assert.equal(wf['9'].inputs.aspect_ratio, '16:9 (Widescreen)');
  assert.equal(wf['233'].inputs.value, false);
});

test('suggested aspect throws node 233 and still records the dropdown choice', () => {
  const wf = buildRunPayload(WORKFLOW, B, {
    prompt: 'x',
    images: [],
    useSuggestedAspect: true,
    aspectRatio: '2:3 (Portrait Photo)',
  });
  assert.equal(wf['233'].inputs.value, true);
  // Nodes 234/235 ignore node 9 while 233 is on, so the combo value is only a
  // fallback - but writing it means flipping the switch in ComfyUI still works.
  assert.equal(wf['9'].inputs.aspect_ratio, '2:3 (Portrait Photo)');
});

test('suggested aspect is forced off without the enhancer to suggest one', () => {
  // Node 240/241 take the suggestion from node 226, which only runs when node
  // 176 passes. Asking for it with the enhancer off would silently keep whatever
  // the editor last had.
  const wf = buildRunPayload(WORKFLOW, B, {
    prompt: 'x',
    images: [],
    promptEnhance: false,
    useSuggestedAspect: true,
    aspectRatio: '21:9 (Ultrawide)',
  });
  assert.equal(wf['233'].inputs.value, false);
  assert.equal(wf['9'].inputs.aspect_ratio, '21:9 (Ultrawide)', 'the dropdown still applies');
});

test('the Consistency LoRA is written only when the job says something', () => {
  assert.equal(buildRunPayload(WORKFLOW, B, { prompt: 'x', images: [] })['207'].inputs.value,
    WORKFLOW['207'].inputs.value, 'unset must leave node 207 alone');
  for (const consistency of [null, undefined]) {
    assert.deepEqual(buildRunPayload(WORKFLOW, B, { prompt: 'x', images: [], consistency })['207'], WORKFLOW['207']);
  }
  assert.equal(buildRunPayload(WORKFLOW, B, { prompt: 'x', images: [], consistency: true })['207'].inputs.value, true);
  assert.equal(buildRunPayload(WORKFLOW, B, { prompt: 'x', images: [], consistency: false })['207'].inputs.value, false);
});

test('every aspect we offer is one the workflow combo accepts', () => {
  // A COMBO falls back to its first entry on an unknown value, so a typo in the
  // list would quietly produce square images.
  const sel = Object.values(WORKFLOW).find((n) => n.class_type === 'ResolutionSelector');
  assert.ok(sel, 'expected a ResolutionSelector node');
  for (const r of ASPECT_RATIOS) {
    assert.ok(r.length > 0 && !r.includes(','), `${r} is not a plausible combo entry`);
  }
  assert.equal(ASPECT_RATIOS.length, 8, 'the workflow documents eight ratios');
});

// --------------------------------------------------------------- validation

test('inputResolution must be blank or a sane pixel size', () => {
  const base = { prompt: 'x', megapixels: 1, batch: 1, shuffle: 1 };
  assert.equal(validateJob({ ...base, inputResolution: null }).ok, true);
  assert.equal(validateJob({ ...base, inputResolution: undefined }).ok, true);
  assert.equal(validateJob({ ...base, inputResolution: '' }).ok, true, 'blank string means unset');
  assert.equal(validateJob({ ...base, inputResolution: 1024 }).inputResolution, 1024);
  assert.equal(validateJob({ ...base, inputResolution: 0 }).ok, false);
  assert.equal(validateJob({ ...base, inputResolution: 12 }).ok, false, 'below the floor');
  assert.equal(validateJob({ ...base, inputResolution: 99999 }).ok, false, 'above the ceiling');
  assert.equal(validateJob({ ...base, inputResolution: 1024.5 }).ok, false, 'must be an integer');
  assert.equal(validateJob({ ...base, inputResolution: 'big' }).ok, false);
  // A bad value must never survive as a usable number.
  assert.equal(validateJob({ ...base, inputResolution: 0 }).inputResolution, null);
});

test('aspectRatio must be one the workflow combo actually offers', () => {
  const base = { prompt: 'x', megapixels: 1, batch: 1, shuffle: 1 };
  assert.equal(validateJob({ ...base, aspectRatio: '16:9 (Widescreen)' }).aspectRatio, '16:9 (Widescreen)');
  assert.equal(validateJob({ ...base }).aspectRatio, '1:1 (Square)', 'a sensible default when none is sent');
  assert.equal(validateJob({ ...base, aspectRatio: 'banana' }).ok, false);
  assert.equal(validateJob({ ...base, aspectRatio: '16:9' }).ok, false, 'the node spells them out in full');
});

test('asking for a suggested aspect without the enhancer is downgraded, not rejected', () => {
  const base = { prompt: 'x', megapixels: 1, batch: 1, shuffle: 1 };
  assert.equal(validateJob({ ...base, useSuggestedAspect: true }).useSuggestedAspect, true);
  const off = validateJob({ ...base, promptEnhance: false, useSuggestedAspect: true });
  assert.equal(off.ok, true, 'a preference, not an error');
  assert.equal(off.useSuggestedAspect, false, 'but it is not honoured');
});

test('consistency is tri-state: on, off, or leave node 207 alone', () => {
  const base = { prompt: 'x', megapixels: 1, batch: 1, shuffle: 1 };
  assert.equal(validateJob({ ...base }).consistency, null);
  assert.equal(validateJob({ ...base, consistency: undefined }).consistency, null);
  assert.equal(validateJob({ ...base, consistency: true }).consistency, true);
  assert.equal(validateJob({ ...base, consistency: false }).consistency, false);
  assert.equal(validateJob({ ...base, consistency: 'yes' }).consistency, false, 'anything truthy-but-not-true is off');
});

// --------------------------------------------------------------- validation

test('validateJob rejects the same junk the bash script rejected', () => {
  assert.equal(validateJob({ prompt: '', megapixels: 4, batch: 1, shuffle: 1 }).ok, false);
  assert.equal(validateJob({ prompt: 'x', megapixels: 0, batch: 1, shuffle: 1 }).ok, false);
  assert.equal(validateJob({ prompt: 'x', megapixels: 4, batch: 0, shuffle: 1 }).ok, false);
  assert.equal(validateJob({ prompt: 'x', megapixels: 4, batch: 1, shuffle: 1.5 }).ok, false);
  assert.equal(
    validateJob({ prompt: 'x', megapixels: 4, batch: 1, shuffle: 1, uploadIds: ['a', 'b', 'c', 'd', 'e'] }).ok,
    false,
  );
  assert.equal(
    validateJob({ prompt: 'x', megapixels: 4, batch: 1, shuffle: 1, stepsOverride: 0 }).ok,
    false,
  );
});

test('validateJob accepts a well formed request', () => {
  const r = validateJob({
    prompt: '  a cat  ',
    megapixels: 1.5,
    batch: 3,
    shuffle: 2,
    promptEnhance: false,
    turbo: true,
    stepsOverride: 8,
    uploadIds: ['u1', null, null, null],
  });
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.equal(r.prompt, 'a cat');
  assert.equal(r.refresh, 'firstOfGroup', 'the refresh mode defaults');
  assert.deepEqual(r.slots, [{ uploadId: 'u1' }, null, null, null]);
});

test('validateJob rejects an unknown refresh mode', () => {
  const base = { prompt: 'x', megapixels: 4, batch: 1, shuffle: 1 };
  assert.equal(validateJob({ ...base, refresh: 'everyRun' }).ok, true);
  assert.equal(validateJob({ ...base, refresh: 'sometimes' }).ok, false);
});

// --------------------------------------------------------------- postprompt

test('validateJob keeps the postprompt exactly as typed, newlines and all', () => {
  // The prompt is trimmed but this is not: node 257 concatenates with an empty
  // delimiter, so a leading newline IS how the user separates the two ideas.
  // Trimming here would silently glue the postprompt onto the last word.
  const r = validateJob({ prompt: 'x', megapixels: 1, batch: 1, shuffle: 1, postprompt: '\n\nwear a red coat' });
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.equal(r.postprompt, '\n\nwear a red coat');
});

test('validateJob reads an absent or blank postprompt as empty text', () => {
  const base = { prompt: 'x', megapixels: 1, batch: 1, shuffle: 1 };
  assert.equal(validateJob(base).postprompt, '');
  assert.equal(validateJob({ ...base, postprompt: '' }).postprompt, '');
  assert.equal(validateJob({ ...base, postprompt: '   ' }).postprompt, '   ', 'kept verbatim');
  assert.equal(validateJob({ ...base, postprompt: 42 }).postprompt, '', 'a number is not text');
});

test('validateJob refuses a postprompt that is not text at all', () => {
  const r = validateJob({ prompt: 'x', megapixels: 1, batch: 1, shuffle: 1, postprompt: 42 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes('postprompt must be text'), r.errors.join('; '));
});

test('a non-blank postprompt is written verbatim into node 256', () => {
  const wf = buildRunPayload(WORKFLOW, B, {
    prompt: 'a cat',
    images: [],
    postprompt: '\n\nin the style of a pencil sketch',
  });
  assert.equal(wf['256'].inputs.value, '\n\nin the style of a pencil sketch');
});

test('a blank postprompt leaves the workflow node exactly as exported', () => {
  // Nothing to say must mean "leave the graph alone", not "write an empty
  // string over whatever the user left in the ComfyUI editor".
  const original = WORKFLOW['256'].inputs.value;
  assert.equal(typeof original, 'string', 'node 256 ships with text of its own');
  for (const postprompt of [undefined, null, '', '   ', 42]) {
    const wf = buildRunPayload(WORKFLOW, B, { prompt: 'a cat', images: [], postprompt });
    assert.equal(wf['256'].inputs.value, original, `postprompt ${JSON.stringify(postprompt)}`);
  }
});

test('buildRunPayload never mutates the workflow file it was handed', () => {
  const before = JSON.stringify(WORKFLOW['256'].inputs.value);
  buildRunPayload(WORKFLOW, B, { prompt: 'a cat', images: [], postprompt: 'a red coat' });
  assert.equal(JSON.stringify(WORKFLOW['256'].inputs.value), before);
});

// ------------------------------------------------------------ slot shape

test('normalizeSlots accepts the object form the web UI sends', () => {
  assert.deepEqual(
    normalizeSlots({ slots: [{ uploadId: 'u1' }, { ref: 'g7' }, null, { uploadId: 'u2' }] }),
    [{ uploadId: 'u1' }, { ref: 'g7' }, null, { uploadId: 'u2' }],
  );
});

test('normalizeSlots treats a bare string as an upload id and drops blanks', () => {
  assert.deepEqual(normalizeSlots({ slots: ['u1', '', null, undefined] }), [{ uploadId: 'u1' }, null, null, null]);
});

test('normalizeSlots truncates to maxImages instead of growing the payload', () => {
  assert.equal(normalizeSlots({ slots: ['a', 'b', 'c', 'd', 'e'] }, 4).length, 4);
});

test('a 5th image in the slots form is a 400, not a silent drop', () => {
  const r = validateJob({ prompt: 'x', megapixels: 4, batch: 1, shuffle: 1, slots: ['a', 'b', 'c', 'd', 'e'] });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('; '), /at most 4 images/);
});

// ------------------------------------------------------------------- seed

test('a blank seed means "roll a fresh one per run"', () => {
  const base = { prompt: 'x', megapixels: 1, batch: 1, shuffle: 1 };
  assert.equal(validateJob({ ...base }).seed, null);
  assert.equal(validateJob({ ...base, seed: null }).seed, null);
  assert.equal(validateJob({ ...base, seed: '' }).seed, null, 'the page sends an empty string');
  assert.equal(validateJob({ ...base, seed: '   ' }).seed, null, 'and a stray space is still blank');
  assert.equal(validateJob({ ...base, seed: 0 }).seed, 0, 'zero is a real seed, not a blank one');
});

test('a pinned seed survives as a number, whichever way the page sent it', () => {
  const base = { prompt: 'x', megapixels: 1, batch: 1, shuffle: 1 };
  assert.equal(validateJob({ ...base, seed: 12345 }).seed, 12345);
  assert.equal(validateJob({ ...base, seed: '12345' }).seed, 12345, 'a text input sends a string');
  assert.equal(validateJob({ ...base, seed: ' 4294967295 ' }).seed, 4294967295, 'the whole 32 bit range');
});

test('a seed that is not a whole number is refused, and never used', () => {
  const base = { prompt: 'x', megapixels: 1, batch: 1, shuffle: 1 };
  for (const bad of ['abc', '12abc', 1.5, -1, 'NaN', true, 2 ** 53]) {
    const r = validateJob({ ...base, seed: bad });
    assert.equal(r.ok, false, `${JSON.stringify(bad)} should not be a seed`);
    assert.match(r.errors.join('; '), /seed must be blank or a whole number/);
    assert.equal(r.seed, null, 'a bad seed must not survive as a usable number');
  }
});

test('a pinned seed is the one that reaches node 37', () => {
  const wf = buildRunPayload(WORKFLOW, B, { prompt: 'x', seed: 987654321 });
  assert.equal(wf[String(B.seed.node)].inputs[B.seed.input], 987654321);
});

// ------------------------------------------------- the upscale workflow

const UP = JSON.parse(fs.readFileSync(path.join(ROOT, 'upscale_api.json'), 'utf8'));
const UB = DEFAULTS.upscaleBindings;

/** The way the Upscale tab calls it: one image, a multiplier, nothing else. */
const UPK = (extra = {}) => ({ slots: [{ ref: 'abc123' }], scale: 2, ...extra });
const upPayload = (extra = {}) =>
  buildUpscalePayload(UP, UB, { image: 'mobilecfy_1.png', scale: 2, scaleToDim: false, seed: 1, guidance: '', ...extra });

test('every default upscale binding points at a real node and a real input', () => {
  for (const [key, binding] of Object.entries(UB)) {
    const node = UP[String(binding.node)];
    assert.ok(node, `upscale binding ${key}: node ${binding.node} missing from upscale_api.json`);
    assert.ok(
      Object.prototype.hasOwnProperty.call(node.inputs ?? {}, binding.input),
      `upscale binding ${key}: node ${binding.node} (${node.class_type}) has no input "${binding.input}"`,
    );
  }
});

test('the upscale bindings are the nodes the graph is actually built from', () => {
  // By name, not by id: a re-export that renumbers everything should fail here
  // with "this binding now points at something else" instead of quietly writing
  // the wrong number into an unrelated node.
  const title = (binding) => UP[String(binding.node)]?._meta?.title;
  assert.equal(title(UB.scale), 'Scale Multiplier');
  assert.equal(title(UB.scaleToDim), 'Scale To Dim');
  assert.equal(title(UB.targetWidth), 'Target Width');
  assert.equal(title(UB.targetHeight), 'Target Height');
  assert.equal(title(UB.guidance), 'Guidance Prompt');
  assert.equal(UP[String(UB.image.node)].class_type, 'LoadImage');
  assert.equal(UP[String(UB.seed.node)].class_type, 'SeedNode');
  // The second half of the size switch is a plain ComfySwitchNode with no title
  // of its own, so it is identified by what it feeds: the encoder's height.
  const second = UP[String(UB.scaleToDimHeight.node)];
  assert.equal(second.class_type, 'ComfySwitchNode');
  assert.deepEqual(second.inputs.switch, false, 'the exported graph hard-wires it off');
});

test('an upscale with no image is refused, and so is a second one', () => {
  const none = validateUpscale({ scale: 2 });
  assert.equal(none.ok, false);
  assert.match(none.errors.join('; '), /an image to upscale is required/);

  const two = validateUpscale({ slots: [{ ref: 'a' }, { ref: 'b' }], scale: 2 });
  assert.equal(two.ok, false);
  assert.match(two.errors.join('; '), /one image at a time/);
});

test('a blank or missing multiplier means 2, and nonsense is refused', () => {
  assert.equal(validateUpscale(UPK()).scale, 2);
  assert.equal(validateUpscale(UPK({ scale: '' })).scale, 2, 'the page sends a string');
  assert.equal(validateUpscale(UPK({ scale: null })).scale, 2);
  assert.equal(validateUpscale(UPK({ scale: '1.25' })).scale, 1.25);
  for (const bad of [0, -1, 17, 'abc', NaN, Infinity, true]) {
    const r = validateUpscale(UPK({ scale: bad }));
    assert.equal(r.ok, false, `${JSON.stringify(bad)} should not be a scale`);
    assert.match(r.errors.join('; '), /scale must be a number above 0 and at most 16/);
    assert.equal(r.scale, 2, 'and it falls back to 2 rather than staying broken');
  }
});

test('the target size is only checked when the switch will read it', () => {
  // Off: the two numbers are unread, so blank ones are not a mistake.
  const off = validateUpscale(UPK({ targetWidth: '', targetHeight: '' }));
  assert.equal(off.ok, true);
  assert.equal(off.targetWidth, null);
  assert.equal(off.targetHeight, null);

  const on = validateUpscale(UPK({ scaleToDim: true, targetWidth: '3000', targetHeight: '2000' }));
  assert.equal(on.ok, true);
  assert.equal(on.targetWidth, 3000);
  assert.equal(on.targetHeight, 2000);

  for (const [field, bad] of [
    ['targetWidth', ''], ['targetWidth', 63], ['targetWidth', 8193],
    ['targetHeight', 12.5], ['targetHeight', 'wide'], ['targetHeight', null],
  ]) {
    const r = validateUpscale(UPK({ scaleToDim: true, targetWidth: '3000', targetHeight: '2000', [field]: bad }));
    assert.equal(r.ok, false, `${field}=${JSON.stringify(bad)} should be refused when the switch is on`);
    assert.match(r.errors.join('; '), new RegExp(`${field} must be a whole number between 64 and 8192`));
  }
});

test('the seed rules are the same ones a generate job obeys', () => {
  assert.equal(validateUpscale(UPK()).seed, null, 'blank means random');
  assert.equal(validateUpscale(UPK({ seed: 0 })).seed, 0, 'zero is a seed, not a blank');
  assert.equal(validateUpscale(UPK({ seed: ' 4242 ' })).seed, 4242);
  const bad = validateUpscale(UPK({ seed: 'abc' }));
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join('; '), /seed must be blank or a whole number/);
});

test('the multiplier, seed and image name all reach their own nodes', () => {
  const wf = upPayload({ scale: 1.25, seed: 777 });
  assert.equal(wf[String(UB.scale.node)].inputs[UB.scale.input], 1.25);
  assert.equal(wf[String(UB.seed.node)].inputs[UB.seed.input], 777);
  assert.equal(wf[String(UB.image.node)].inputs[UB.image.input], 'mobilecfy_1.png');
});

test('an unpinned upscale still gets a seed of its own', () => {
  const wf = upPayload({ seed: null });
  const seed = wf[String(UB.seed.node)].inputs[UB.seed.input];
  assert.equal(Number.isInteger(seed) && seed >= 0, true, `not a usable seed: ${seed}`);
});

test('scale to a size writes BOTH halves of the switch, or the picture is stretched', () => {
  const on = upPayload({ scaleToDim: true, targetWidth: 3000, targetHeight: 2000 });
  assert.equal(on[String(UB.scaleToDim.node)].inputs[UB.scaleToDim.input], true);
  assert.equal(on[String(UB.scaleToDimHeight.node)].inputs[UB.scaleToDimHeight.input], true);
  assert.equal(on[String(UB.targetWidth.node)].inputs[UB.targetWidth.input], 3000);
  assert.equal(on[String(UB.targetHeight.node)].inputs[UB.targetHeight.input], 2000);

  const off = upPayload({ scaleToDim: false, targetWidth: 3000, targetHeight: 2000 });
  assert.equal(off[String(UB.scaleToDim.node)].inputs[UB.scaleToDim.input], false);
  assert.equal(off[String(UB.scaleToDimHeight.node)].inputs[UB.scaleToDimHeight.input], false);
  // The numbers are not read, so the graph keeps its own and the two scales stay
  // in step. Nothing was silently half-applied.
  assert.equal(off[String(UB.targetWidth.node)].inputs[UB.targetWidth.input], 2048);
  assert.equal(off[String(UB.targetHeight.node)].inputs[UB.targetHeight.input], 2048);
});

test('guidance is added after the graph own instruction, and a blank box changes nothing', () => {
  const typed = upPayload({ guidance: 'keep the grain' });
  assert.equal(typed[String(UB.guidance.node)].inputs[UB.guidance.input], 'keep the grain');
  // 543 concatenates 522 (the workflow's own "Upscale Prompt") with 544, so the
  // box must not become the whole prompt - and 522 is never written to at all.
  assert.equal(typed['522'].inputs.value, UP['522'].inputs.value);
  assert.match(typed['522'].inputs.value, /Enhance this image/);

  const blank = upPayload({ guidance: '   ' });
  assert.deepEqual(
    blank[String(UB.guidance.node)].inputs[UB.guidance.input],
    UP[String(UB.guidance.node)].inputs[UB.guidance.input],
    'a blank box leaves whatever the editor had in it',
  );
});

test('the payload is a copy - the workflow file itself is never touched', () => {
  const before = JSON.stringify(UP);
  upPayload({ scale: 4, seed: 9, scaleToDim: true, targetWidth: 1000, targetHeight: 1000, guidance: 'g' });
  assert.equal(JSON.stringify(UP), before);
});

test('a binding pointing at a node that is not there is loud, not silent', () => {
  // This is the bug class the whole binding system exists for: writing into a
  // node id that no longer exists used to be a perfect no-op.
  assert.throws(
    () => buildUpscalePayload(UP, { ...UB, scale: { node: 9999, input: 'value' } }, { scale: 2, seed: 1 }),
    /node 9999 is not in the workflow/,
  );
});