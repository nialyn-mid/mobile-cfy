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

test('prompt routing follows the workflow node 155 rule', () => {
  assert.equal(promptTarget({ promptEnhance: true, imageCount: 0 }), 'enhanced');
  assert.equal(promptTarget({ promptEnhance: false, imageCount: 0 }), 'raw');
  assert.equal(promptTarget({ promptEnhance: true, imageCount: 1 }), 'raw');
  assert.equal(promptTarget({ promptEnhance: false, imageCount: 4 }), 'raw');
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

test('an attached image forces node 44 even when enhance is on', () => {
  const wf = buildRunPayload(WORKFLOW, B, {
    prompt: 'a cat',
    promptEnhance: true,
    images: ['ref_a.png'],
  });
  assert.equal(wf['44'].inputs.value, 'a cat');
  assert.equal(wf['176'].inputs.cond, false, 'the enhancer must not run for an image job');
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
  assert.equal(wf['9'].inputs.megapixels, 1.5);
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
  // It feeds the text encoder, not the output size.
  assert.deepEqual(WORKFLOW['5'].inputs.resolution, ['204', 0]);
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

test('the SaveText node is fed by the same switch the text encoder reads', () => {
  // This is the whole basis for labelling the capture honest: if 181 tapped a
  // different wire we would be showing a prompt the image was never made from.
  assert.deepEqual(WORKFLOW['181'].inputs.text, ['178', 0]);
  assert.deepEqual(WORKFLOW['5'].inputs.prompt, ['178', 0]);
  assert.equal(WORKFLOW['181'].class_type, 'SaveText');
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