import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { startFakeComfyUI, PNG, sleep, waitFor, dropRoot } from './helpers/fakeComfy.js';
import { DEFAULTS, init } from '../lib/config.js';
import { validateSprite, buildSpritePayload } from '../lib/payload.js';
import { readCounter, claimCounter, resetCounterForTests } from '../lib/spritecounter.js';

/**
 * The Sprite tab's surface: sprite_api.json, its own binding map, and the
 * Filename Counter that stops two jobs from writing the same eight files.
 *
 * Three things are pinned here because each failure is silent in production:
 *   1. the bindings must point at THIS graph (a stale id would be refused by
 *      bindingGuard, but a wrong-but-present node would write into the wrong
 *      place),
 *   2. the counter must be claimed at enqueue and persisted - the alternative
 *      is two queued sprite jobs handing out the same number and the second
 *      overwriting the first's files in ComfyUI's output/Sprite/ folder, and
 *        3. downloads must land in the `sprite` subfolder, not the flat one,
 *      where they would be indistinguishable from generations.
 *
 * Port 3081 is the live instance; 3082-3085 belong to the other server test
 * files, so this one takes 3087.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3087;
const base = `http://127.0.0.1:${PORT}`;

const get = async (p) => (await fetch(base + p)).json();
const send = async (method, p, body, headers = {}) => {
  const res = await fetch(base + p, {
    method,
    headers: body && typeof body === 'string' ? { 'Content-Type': 'application/json', ...headers } : headers,
    body: typeof body === 'string' ? body : undefined,
  });
  return { status: res.status, body: await res.json() };
};
const post = async (p, body) => send('POST', p, JSON.stringify(body ?? {}));

const SPRITE = JSON.parse(fs.readFileSync(path.join(ROOT, 'sprite_api.json'), 'utf8'));
const SB = DEFAULTS.spriteBindings;

let tmp;
let log = '';

/** Boot the fourth server. `sprite` is written verbatim into config.json. */
async function boot(t, comfyPort, { sprite } = {}) {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcfy-sprite-'));
  for (const file of ['workflow_api.json', 'workflow_api_enhanceless.json', 'upscale_api.json', 'sprite_api.json']) {
    fs.copyFileSync(path.join(ROOT, file), path.join(tmp, file));
  }
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
    server: { host: '127.0.0.1', port: PORT },
    comfy: { host: '127.0.0.1', port: comfyPort, timeoutMs: 5000 },
    downloadDir: path.join(tmp, 'downloads'),
    dataDir: path.join(tmp, 'data'),
    ...(sprite ? { spriteBindings: sprite } : {}),
  }, null, 2));

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, MOBILE_CFY_ROOT: tmp },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  t.after(async () => {
    child.stdout.destroy();
    child.stderr.destroy();
    const exited = new Promise((r) => child.once('exit', r));
    child.kill();
    await exited;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  for (let i = 0; i < 60; i++) {
    try { await fetch(`${base}/api/health`); return; } catch { await sleep(100); }
  }
  throw new Error(`the test server never came up on ${PORT}:\n${log}`);
}

/** One real upload, so hydration finds it the way the tab's uploads do. */
async function uploadOne() {
  const fd = new FormData();
  fd.append('file', new Blob([PNG], { type: 'image/png' }), 'tiny.png');
  const up = await fetch(`${base}/api/uploads`, { method: 'POST', body: fd }).then((r) => r.json());
  assert.equal(up.uploads.length, 1, `the upload must land: ${JSON.stringify(up)}`);
  return up.uploads[0].id;
}

// ------------------------------------------------------------------- unit

test('every default sprite binding points at a real node and a real input', () => {
  for (const [key, b] of Object.entries(SB)) {
    const node = SPRITE[String(b.node)];
    assert.ok(node, `sprite binding ${key}: node ${b.node} missing from sprite_api.json`);
    assert.ok(
      Object.prototype.hasOwnProperty.call(node.inputs ?? {}, b.input),
      `sprite binding ${key}: node ${b.node} (${node.class_type}) has no input "${b.input}"`,
    );
  }
});

test('the sprite bindings are the nodes the graph is actually built from', () => {
  // By title, not by id: a re-export that renumbers everything should fail here
  // with "this binding now points at something else" instead of quietly writing
  // a personality into an unrelated text box.
  const title = (b) => SPRITE[String(b.node)]?._meta?.title;
  assert.equal(title(SB.personalityPrompt), 'Personality Prompt');
  assert.equal(title(SB.image), 'Load Image');
  assert.equal(title(SB.seed), 'Seed');
  assert.equal(title(SB.filenameCounter), 'Filename Counter');
  assert.equal(SPRITE[String(SB.image.node)].class_type, 'LoadImage');
  assert.equal(SPRITE[String(SB.seed.node)].class_type, 'SeedNode');

  // The counter is part of EVERY view's filename prefix: node 50 feeds 52
  // (Convert to String) which feeds 51 ("Sprite/" + n), and each SaveImage
  // reads its filename_prefix from a concat downstream of that.
  assert.deepEqual(SPRITE['52'].inputs.input1, ['50', 0], 'node 50 feeds the counter concat');
  assert.equal(SPRITE['51'].inputs.string_a, 'Sprite/', "the graph's own prefix names the folder the downloads use");
  const views = ['49', '56', '226', '236', '275', '285', '295', '305'];
  for (const id of views) {
    assert.equal(SPRITE[id]?.class_type, 'SaveImage', `node ${id} is one of the eight expression views`);
    assert.ok(Array.isArray(SPRITE[id].inputs.filename_prefix),
      `node ${id} reads its prefix from the chain, not a literal`);
  }
  const saves = Object.values(SPRITE).filter((n) => n?.class_type === 'SaveImage').length;
  assert.ok(saves >= views.length, `the graph may grow more views (found ${saves})`);
});

test('the sprite form needs a personality AND an image, one image at a time', () => {
  const none = validateSprite({});
  assert.equal(none.ok, false);
  assert.match(none.errors.join('; '), /a personality prompt is required/);
  assert.match(none.errors.join('; '), /an image is required/);

  const noImage = validateSprite({ personality: 'brave' });
  assert.equal(noImage.ok, false);
  assert.match(noImage.errors.join('; '), /an image is required/);

  const noPersonality = validateSprite({ slots: [{ ref: 'a' }] });
  assert.equal(noPersonality.ok, false);
  assert.match(noPersonality.errors.join('; '), /a personality prompt is required/);

  // The graph has ONE LoadImage: a second picture has nowhere to go, so it is
  // named rather than silently dropped.
  const two = validateSprite({ personality: 'brave', slots: [{ ref: 'a' }, { ref: 'b' }] });
  assert.equal(two.ok, false);
  assert.match(two.errors.join('; '), /one image at a time - the sprite workflow has a single image input/);

  const ok = validateSprite({ personality: '  brave  ', slots: [{ ref: 'a' }], seed: ' 4242 ' });
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.equal(ok.personality, 'brave', 'the prompt is trimmed before it reaches the graph');
  assert.equal(ok.seed, 4242, 'the page sends a string');
  assert.equal(ok.collectImages, true, 'saving is on by default');
  assert.equal(ok.slots.length, 1, 'only one slot survives');
  assert.equal(validateSprite({ personality: 'x', slots: [{ ref: 'a' }], collectImages: false }).collectImages, false);

  const blankSeed = validateSprite({ personality: 'x', slots: [{ ref: 'a' }], seed: '' });
  assert.equal(blankSeed.seed, null, 'a blank seed means roll a fresh one');

  const junkSeed = validateSprite({ personality: 'x', slots: [{ ref: 'a' }], seed: 'lots' });
  assert.equal(junkSeed.ok, false);
  assert.match(junkSeed.errors.join('; '), /seed must be blank or a whole number of at least 0/);
  assert.equal(junkSeed.seed, null, 'and it falls back to a roll rather than a NaN in the graph');
});

test('the sprite payload writes personality, image and seed through their bindings', () => {
  const wf = buildSpritePayload(SPRITE, SB, {
    personality: '  cheerful, curious  ',
    image: 'mobilecfy_ref.png',
    seed: 4242,
    counter: 7,
  });
  assert.equal(wf['5'].inputs.value, 'cheerful, curious', 'trimmed on the way in');
  assert.equal(wf['7'].inputs.image, 'mobilecfy_ref.png', 'LoadImage takes the staged upload name');
  assert.equal(wf['22'].inputs.seed, 4242, 'one seed pins all nine samplers');
  assert.equal(wf['50'].inputs.value, 7, 'the claimed counter names the files');
  // The source graph is never mutated - every later job reads the shipped one.
  assert.equal(SPRITE['5'].inputs.value !== 'cheerful, curious', true, 'the shipped graph is left alone');
  assert.equal(SPRITE['50'].inputs.value !== 7, true, 'including the counter node');

  // No image written = node 7 keeps whatever the graph shipped; a blank
  // personality = node 5 keeps its default. Neither is ever overwritten empty.
  const untouched = buildSpritePayload(SPRITE, SB, { personality: '   ', image: null, seed: 1 });
  assert.equal(untouched['7'].inputs.image, SPRITE['7'].inputs.image);
  assert.equal(untouched['5'].inputs.value, SPRITE['5'].inputs.value);

  // Seed null means roll: the graph must receive a real number, never null.
  const rolled = buildSpritePayload(SPRITE, SB, { personality: 'x', image: 'a.png', seed: null });
  assert.equal(typeof rolled['22'].inputs.seed, 'number');
});

test('the filename counter only reaches the graph when a real one was claimed', () => {
  const base = { personality: 'x', image: 'a.png', seed: 1 };
  const shippedValue = SPRITE['50'].inputs.value;

  const noCounter = buildSpritePayload(SPRITE, SB, base);
  assert.equal(noCounter['50'].inputs.value, shippedValue, 'an unclaimed number is never invented');

  const claimed = buildSpritePayload(SPRITE, SB, { ...base, counter: 7 });
  assert.equal(claimed['50'].inputs.value, 7);

  // The claim path only ever produces integers >= 1; anything else arriving
  // here is a caller bug and must NOT name files.
  for (const bad of [3.5, '7', NaN, Infinity, null]) {
    const wf = buildSpritePayload(SPRITE, SB, { ...base, counter: bad });
    assert.equal(wf['50'].inputs.value, shippedValue,
      `counter=${JSON.stringify(bad)} must not name files`);
  }
});

test('the filename counter claims once per job and starts over at 1 when unreadable', () => {
  // counterFile() resolves through paths(), so the config must point at a root
  // of its own - otherwise this test would spend the repo's real numbers.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcfy-spritecnt-'));
  init(root);
  try {
    assert.equal(readCounter(), 1, 'a fresh root starts at 1: 0 is a plausible editor value in the graph');
    assert.equal(claimCounter(), 1, 'the first job gets 1');
    assert.equal(readCounter(), 2, 'the claim is on disk before it is read again');
    assert.equal(claimCounter(), 2);
    const file = path.join(root, 'data', 'sprite-counter.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { next: 3 }, 'persisted as {next}');

    fs.writeFileSync(file, 'not json at all');
    assert.equal(readCounter(), 1, 'a corrupt file means a fresh start, not a crash');

    // Hand-edited values are clamped into the non-colliding range rather than
    // refused: the alternative is refusing every sprite job over one typo.
    fs.writeFileSync(file, JSON.stringify({ next: 0 }));
    assert.equal(readCounter(), 1, '0 would collide with whatever the graph itself already made');
    fs.writeFileSync(file, JSON.stringify({ next: -3 }));
    assert.equal(readCounter(), 1);
    fs.writeFileSync(file, JSON.stringify({ next: 12.9 }));
    assert.equal(readCounter(), 12, 'a fraction is floored, not rejected');

    resetCounterForTests(5);
    assert.equal(readCounter(), 5, 'the test seam writes through the same path');
  } finally {
    dropRoot(root);
  }
});

// ------------------------------------------------------------------- http

test('the sprite counter advances per job, and a peek never spends one', async (t) => {
  await boot(t, 9);
  await post('/api/queue/pause'); // held, so nothing runs while we count

  assert.deepEqual(await get('/api/sprite/counter'), { next: 1 });
  assert.deepEqual(await get('/api/sprite/counter'), { next: 1 }, 'the GET is a peek, not a reservation');

  const uploadId = await uploadOne();
  const first = await post('/api/sprite', { personality: 'brave explorer', slots: [{ uploadId }] });
  assert.equal(first.status, 202, `${JSON.stringify(first.body)}\n${log}`);
  assert.equal(first.body.kind, 'sprite');
  assert.equal(first.body.spec.counter, 1, 'the first job of a fresh root claims 1');
  assert.equal(first.body.spec.prompt, 'brave explorer');
  assert.equal(first.body.spec.batch, 1, 'one run makes all eight views');
  assert.equal(first.body.runs.length, 1);
  assert.deepEqual(await get('/api/sprite/counter'), { next: 2 }, 'the claim is remembered immediately');

  const second = await post('/api/sprite', { personality: 'grumpy goblin', slots: [{ uploadId }], seed: '909' });
  assert.equal(second.status, 202, `${JSON.stringify(second.body)}\n${log}`);
  assert.equal(second.body.spec.counter, 2, 'a different number, or the files would overwrite each other');
  assert.equal(second.body.spec.seed, 909);
  assert.deepEqual(await get('/api/sprite/counter'), { next: 3 });

  const { jobs } = await get('/api/jobs');
  assert.equal(jobs.length, 2, 'both were queued');
  assert.ok(jobs.every((j) => j.kind === 'sprite'), 'and both are sprite jobs');
});

test('a sprite request that cannot run is refused WITHOUT spending a number', async (t) => {
  await boot(t, 9);
  await post('/api/queue/pause');
  const uploadId = await uploadOne();

  const noPrompt = await post('/api/sprite', { slots: [{ uploadId }] });
  assert.equal(noPrompt.status, 400, JSON.stringify(noPrompt.body));
  assert.match(noPrompt.body.error, /a personality prompt is required/);

  const noImage = await post('/api/sprite', { personality: 'brave' });
  assert.equal(noImage.status, 400, JSON.stringify(noImage.body));
  assert.match(noImage.body.error, /an image is required/);

  const two = await post('/api/sprite', { personality: 'brave', slots: [{ uploadId }, { uploadId }] });
  assert.equal(two.status, 400, JSON.stringify(two.body));
  assert.match(two.body.error, /one image at a time/);

  assert.equal((await get('/api/jobs')).jobs.length, 0, 'nothing was queued');
  assert.deepEqual(await get('/api/sprite/counter'), { next: 1 },
    'three refused requests and the number has not moved');
});

test('a broken sprite binding is refused, and does not block a generate', async (t) => {
  await boot(t, 9, {
    // Half right, like a graph that was re-exported: the name is known, the
    // node id is not in this file.
    sprite: { personalityPrompt: { node: '9999', input: 'value' } },
  });
  await post('/api/queue/pause');

  const check = await post('/api/config/validate', { kind: 'sprite' });
  assert.equal(check.body.kind, 'sprite');
  assert.equal(check.body.ok, false, 'the broken row is reported');
  assert.deepEqual(check.body.bindings.filter((b) => !b.ok).map((b) => b.binding), ['personalityPrompt']);

  // The generate map is untouched by a sprite problem - the graphs share no
  // node ids, so neither one's mistakes are the other's.
  const gen = await post('/api/config/validate', { kind: 'generate' });
  assert.equal(gen.body.ok, true, JSON.stringify(gen.body.bindings));

  const res = await post('/api/sprite', { personality: 'brave', slots: [{ uploadId: 'x' }] });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.match(res.body.error, /binding problem/);
  assert.match(res.body.error, /personalityPrompt/, 'the error names the setting to fix');
  assert.ok(Array.isArray(res.body.bindings), 'the same per-binding detail the other routes send');
  assert.equal((await get('/api/jobs')).jobs.length, 0, 'nothing was queued');
  assert.deepEqual(await get('/api/sprite/counter'), { next: 1 },
    'the guard runs before the claim, so even a refused job spends nothing');

  // A way back: reset restores the shipped map, and only that map.
  const reset = await post('/api/config/bindings/reset', { kind: 'sprite' });
  assert.equal(reset.body.kind, 'sprite');
  assert.equal(reset.body.ok, true, JSON.stringify(reset.body.bindings));
  assert.equal(reset.body.bindings.length, 4, 'all four sprite bindings validated against sprite_api.json');
  assert.deepEqual(reset.body.config.spriteBindings.personalityPrompt, { node: '5', input: 'value' });
  assert.deepEqual(reset.body.config.bindings.seed, { node: '37', input: 'seed' },
    'the generate map is left alone');
  assert.equal((await post('/api/config/validate', { kind: 'sprite' })).body.ok, true, 'and now the sprite kind passes');
});

test('the sprite workflow can be read and replaced on its own', async (t) => {
  await boot(t, 9);

  const read = await get('/api/sprite/workflow');
  assert.ok(read.path.endsWith('sprite_api.json'), read.path);
  assert.equal(read.workflow['50']._meta.title, 'Filename Counter');
  assert.equal(read.workflow['5'].class_type, 'PrimitiveStringMultiline');
  assert.equal(read.workflow['49'].class_type, 'SaveImage');

  // The generate graph is a different file and must not be disturbed.
  const gen = await get('/api/workflow');
  assert.ok(gen.path.endsWith('workflow_api.json'), gen.path);
  assert.equal(gen.workflow['41']._meta.title, 'Input Prompt');

  const tiny = { 50: { class_type: 'PrimitiveInt', inputs: { value: 1 }, _meta: { title: 'Filename Counter' } } };
  const put = await send('PUT', '/api/sprite/workflow', JSON.stringify({ workflow: tiny }));
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.nodes, 1);
  assert.deepEqual((await get('/api/sprite/workflow')).workflow, tiny);
  assert.equal(fs.existsSync(path.join(tmp, 'sprite_api.json.tmp')), false,
    'the temp file is renamed, not left behind');

  // The other two files were not disturbed.
  const normal = JSON.parse(fs.readFileSync(path.join(tmp, 'workflow_api.json'), 'utf8'));
  assert.equal(normal['41'] !== undefined, true, 'the generate file still has its input prompt');
  assert.equal(fs.existsSync(path.join(tmp, 'upscale_api.json')), true, 'and the upscale file is still there');

  const junk = await send('PUT', '/api/sprite/workflow', JSON.stringify({ workflow: [1, 2, 3] }));
  assert.equal(junk.status, 400, 'an array is not a graph');
});

test('a sprite job runs the sprite graph, saves into the sprite folder, and remembers its number', async (t) => {
  const comfy = await startFakeComfyUI({ mode: 'instant', saveNode: 49, textNode: null });
  t.after(() => comfy.close());
  await boot(t, comfy.port);

  const uploadId = await uploadOne();
  const job = await post('/api/sprite', {
    personality: '  cheerful, curious  ',
    slots: [{ uploadId }],
    seed: '909',
  });
  assert.equal(job.status, 202, `${JSON.stringify(job.body)}\n${log}`);
  assert.equal(job.body.kind, 'sprite');
  assert.equal(job.body.spec.counter, 1);
  assert.equal(job.body.spec.prompt, 'cheerful, curious', 'the queue row shows the personality');
  assert.equal(job.body.spec.seed, 909);

  // All four bindings really reached the graph that was submitted.
  await waitFor(() => comfy.state.prompts.length >= 1, 'the sprite prompt to reach ComfyUI');
  const wf = comfy.state.prompts[0].payload;
  assert.equal(wf['5'].inputs.value, 'cheerful, curious', 'node 5 got the personality');
  assert.equal(wf['7'].inputs.image, comfy.state.uploads[0], 'node 7 got the staged upload');
  assert.equal(wf['22'].inputs.seed, 909, 'node 22 got the pinned seed');
  assert.equal(wf['50'].inputs.value, 1, 'node 50 got the claimed counter');

  let status = '';
  for (let i = 0; i < 150 && status !== 'done'; i++) {
    status = (await get(`/api/jobs/${job.body.id}`)).status;
    if (status !== 'done') await sleep(100);
  }
  assert.equal(status, 'done', `the job finished against the fake ComfyUI:\n${log}`);

  // Downloads went into the `sprite` subfolder, and ONLY there - a sprite file
  // in the flat folder would be indistinguishable from a generation.
  const flatDir = path.join(tmp, 'downloads');
  const spriteDir = path.join(flatDir, 'sprite');
  assert.equal(fs.existsSync(spriteDir), true, 'the sprite folder is created');
  const spriteFiles = fs.readdirSync(spriteDir).filter((f) => f.endsWith('.png'));
  assert.ok(spriteFiles.length >= 1, `expected a download, got ${JSON.stringify(spriteFiles)}`);
  const flatPngs = fs.existsSync(flatDir) ? fs.readdirSync(flatDir).filter((f) => f.endsWith('.png')) : [];
  assert.deepEqual(flatPngs, [], 'sprite files never land in the flat folder');

  // History and gallery both know what this was.
  const history = await get('/api/history?limit=10');
  const row = history.entries.find((e) => e.jobId === job.body.id);
  assert.equal(row.settings.kind, 'sprite');
  assert.equal(row.settings.counter, 1, 'the row remembers the number, so a restore explains a new one');
  assert.equal(row.settings.seed, 909);
  assert.equal(row.status, 'done');
  const gallery = await get('/api/gallery?limit=10');
  const entry = gallery.images.find((e) => e.jobId === job.body.id);
  assert.equal(entry.kind, 'sprite');
  assert.equal(path.basename(path.dirname(entry.localPath)), 'sprite', 'the entry knows its subfolder');
  assert.ok(entry.bytes > 0, 'the download really happened');

  // The next job numbers its files differently - the whole point of the counter.
  const second = await post('/api/sprite', { personality: 'grumpy goblin', slots: [{ uploadId }] });
  assert.equal(second.status, 202, `${JSON.stringify(second.body)}\n${log}`);
  assert.equal(second.body.spec.counter, 2);
  await waitFor(() => comfy.state.prompts.length >= 2, 'the second prompt');
  const wf2 = comfy.state.prompts[1].payload;
  assert.equal(wf2['50'].inputs.value, 2, 'the second graph carries its own counter');
  assert.equal(wf2['5'].inputs.value, 'grumpy goblin');
  assert.equal(typeof wf2['22'].inputs.seed, 'number', 'a blank seed rolled a fresh one');

  for (let i = 0; i < 150 && status !== 'done'; i++) {
    status = (await get(`/api/jobs/${second.body.id}`)).status;
    if (status !== 'done') await sleep(100);
  }
  assert.equal(status, 'done', `the second job finished too:\n${log}`);
  const history2 = await get('/api/history?limit=10');
  const row2 = history2.entries.find((e) => e.jobId === second.body.id);
  assert.equal(row2.settings.counter, 2);
  assert.equal(row2.settings.seed, null, 'a blank seed stays blank in settings');
  assert.equal(typeof row2.seeds?.[0], 'number',
    'the rolled seed is remembered in seeds[], so a repeat can pin it');
});
