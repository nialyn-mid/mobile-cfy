import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { startFakeComfyUI, PNG, sleep } from './helpers/fakeComfy.js';

/**
 * The Upscale tab's HTTP surface, end to end: a second server on a spare port, a
 * temp root, both workflow files copied in, and a fake ComfyUI that never
 * generates anything.
 *
 * Port 3081 is the live instance and the other server tests own 3082 and 3083;
 * this one takes 3084, and every test file needs its own fixed port because the
 * port is written into the config the child reads at boot.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3084;
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

let tmp;
let log = '';

/** Boot the second server. `bindings` is written verbatim into config.json. */
async function boot(t, comfyPort, { bindings } = {}) {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcfy-upscale-'));
  for (const file of ['workflow_api.json', 'upscale_api.json']) {
    fs.copyFileSync(path.join(ROOT, file), path.join(tmp, file));
  }
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
    server: { host: '127.0.0.1', port: PORT },
    comfy: { host: '127.0.0.1', port: comfyPort, timeoutMs: 5000 },
    downloadDir: path.join(tmp, 'downloads'),
    dataDir: path.join(tmp, 'data'),
    ...(bindings ? { upscaleBindings: bindings } : {}),
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
    // Windows needs the child gone before this process lets go of its handles.
    await exited;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  for (let i = 0; i < 60; i++) {
    try { await fetch(`${base}/api/health`); return; } catch { await sleep(100); }
  }
  throw new Error(`the test server never came up on ${PORT}:\n${log}`);
}

test('the web page is served from the app, not from the data root', async (t) => {
  // The temp root has no public/ in it, and it must not need one: the page is
  // part of the app, the workflows and history are the configurable data. A
  // server that serves the UI out of the data root 404s the whole app the moment
  // MOBILE_CFY_ROOT points anywhere but the checkout.
  await boot(t, 9);
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200, `the page must be served:\n${log}`);
  const page = await res.text();
  assert.match(page, /id="sub-upscale"/, 'Upscale is a pane of the Create page');
  assert.match(page, /id="tab-queue"/, 'the queue is its own page');
  for (const file of ['app.js', 'durfmt.js', 'zoommath.js', 'bindmark.js', 'style.css']) {
    const r = await fetch(`${base}/${file}`);
    assert.equal(r.status, 200, `${file} must be served`);
  }
});

test('an upscale is queued, tracked and cancelled like any other job', async (t) => {
  // Manual mode: the prompt stays in ComfyUI's queue instead of being finished on
  // arrival, so the job is still running when the cancel lands.
  const comfy = await startFakeComfyUI({ mode: 'manual', saveNode: 508, textNode: null });
  t.after(() => comfy.close());
  await boot(t, comfy.port);

  // A real upload, so the job carries a real image the way the tab does.
  const fd = new FormData();
  fd.append('file', new Blob([PNG], { type: 'image/png' }), 'tiny.png');
  const up = await fetch(`${base}/api/uploads`, { method: 'POST', body: fd }).then((r) => r.json());
  assert.equal(up.uploads.length, 1, `the upload must land: ${JSON.stringify(up)}`);

  const job = await post('/api/upscale', {
    slots: [{ uploadId: up.uploads[0].id }],
    scale: 1.5,
    seed: '909',
  });
  assert.equal(job.status, 202, `${JSON.stringify(job.body)}\n${log}`);
  assert.equal(job.body.kind, 'upscale');
  assert.equal(job.body.spec.seed, 909);
  assert.equal(job.body.spec.scale, 1.5);
  assert.match(job.body.spec.prompt, /^upscale .+ ×1\.5$/);
  assert.equal(job.body.runs.length, 1, 'the upscale graph has a single LoadImage, so it is one run');

  // It reached ComfyUI, uploaded under a name LoadImage can read back.
  for (let i = 0; i < 50 && comfy.state.prompts.length < 1; i++) await sleep(100);
  assert.equal(comfy.state.prompts.length, 1, `the prompt must be handed over:\n${log}`);
  assert.equal(comfy.state.uploads.length, 1);
  assert.equal(comfy.state.prompts[0].payload['538'].inputs.image, comfy.state.uploads[0]);

  const cancelled = await post(`/api/jobs/${job.body.id}/cancel`, {});
  assert.ok([200, 409].includes(cancelled.status), `cancel answer: ${JSON.stringify(cancelled.body)}`);
  // The run was already handed over and is the one being watched, so cancel stops
  // the watching: ComfyUI keeps that one prompt (it refuses to delete a prompt it
  // has begun) but this app stops tracking it and says so.
  for (let i = 0; i < 50; i++) {
    const seen = await get(`/api/jobs/${job.body.id}`);
    if (seen.status === 'cancelled') break;
    await sleep(100);
  }
  const after = await get(`/api/jobs/${job.body.id}`);
  assert.equal(after.status, 'cancelled', `the job must end cancelled:\n${log}`);

  const history = await get('/api/history?limit=10');
  const row = history.entries.find((e) => e.jobId === job.body.id);
  assert.equal(row.status, 'cancelled', 'and the history row says so too');
  assert.equal(row.settings.kind, 'upscale');
});

test('a batch of N is one prompt asking for N images, not N prompts', async (t) => {
  const comfy = await startFakeComfyUI({ mode: 'manual', saveNode: 508, textNode: null });
  t.after(() => comfy.close());
  await boot(t, comfy.port);

  const fd = new FormData();
  fd.append('file', new Blob([PNG], { type: 'image/png' }), 'tiny.png');
  const up = await fetch(`${base}/api/uploads`, { method: 'POST', body: fd }).then((r) => r.json());

  // The string is what the number input actually sends; the server parses it.
  const job = await post('/api/upscale', {
    slots: [{ uploadId: up.uploads[0].id }],
    scale: 2,
    batch: '4',
  });
  assert.equal(job.status, 202, `${JSON.stringify(job.body)}\n${log}`);
  assert.equal(job.body.spec.batch, 4);
  assert.equal(job.body.runs.length, 1, 'one pass produces the images, so there is still one run');
  assert.match(job.body.spec.prompt, /×2 ×4 images$/, 'the queue row says how many are coming');

  for (let i = 0; i < 50 && comfy.state.prompts.length < 1; i++) await sleep(100);
  assert.equal(comfy.state.prompts.length, 1, `exactly one prompt goes to ComfyUI:\n${log}`);
  assert.equal(comfy.state.prompts[0].payload['506'].inputs.batch_size, 4, 'and it is node 506 that is told');

  // Junk is refused with a message, not rounded into something the user did not ask for.
  for (const bad of [0, 9, 'lots', 1.5]) {
    const r = await post('/api/upscale', { slots: [{ uploadId: up.uploads[0].id }], scale: 2, batch: bad });
    assert.equal(r.status, 400, `batch=${JSON.stringify(bad)} must be refused: ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, /batch must be a whole number between 1 and 8/);
  }
  assert.equal((await get('/api/jobs')).jobs.length, 1, 'the four bad requests queued nothing');

  const row = (await get('/api/history?limit=10')).entries.find((e) => e.jobId === job.body.id);
  assert.equal(row.settings.batch, 4, 'history remembers it, so the row restores it');
});

test('a broken upscale binding is refused, and does not block a generate', async (t) => {
  const comfy = await startFakeComfyUI({ mode: 'manual' });
  t.after(() => comfy.close());
  await boot(t, comfy.port, {
    // Half right, like a graph that was re-exported: a real node, an input that
    // does not exist on it.
    bindings: { guidance: { node: '544', input: 'text' }, scale: { node: '9999', input: 'value' } },
  });

  const check = await post('/api/config/validate', { kind: 'upscale' });
  assert.equal(check.body.kind, 'upscale');
  assert.equal(check.body.ok, false);
  const bad = check.body.bindings.filter((b) => !b.ok).map((b) => b.binding).sort();
  assert.deepEqual(bad, ['guidance', 'scale']);

  // The generate map is untouched by an upscale problem - the two graphs share
  // no node ids, so neither one's mistakes are the other's.
  const gen = await post('/api/config/validate', { kind: 'generate' });
  assert.equal(gen.body.ok, true, JSON.stringify(gen.body.bindings));

  const res = await post('/api/upscale', { slots: [{ uploadId: 'whatever' }], scale: 2 });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.match(res.body.error, /binding problem/);
  assert.ok(Array.isArray(res.body.bindings), 'the same per-binding detail the generate route sends');
  assert.equal((await get('/api/jobs')).jobs.length, 0, 'nothing was queued');
});

test('the upscale bindings can be reset without touching the generate ones', async (t) => {
  const comfy = await startFakeComfyUI({ mode: 'manual' });
  t.after(() => comfy.close());
  await boot(t, comfy.port, { bindings: { scale: { node: '9999', input: 'value' } } });

  // A hand-edited generate binding, so "did the reset touch it?" has an answer.
  const marked = await send('PUT', '/api/config', JSON.stringify({ bindings: { seed: { node: '37', input: 'noise_seed' } } }));
  assert.equal(marked.status, 200, JSON.stringify(marked.body));

  const reset = await post('/api/config/bindings/reset', { kind: 'upscale' });
  assert.equal(reset.body.kind, 'upscale');
  assert.equal(reset.body.ok, true, JSON.stringify(reset.body.bindings));
  assert.equal(reset.body.bindings.length, 9);
  assert.deepEqual(reset.body.config.upscaleBindings.scale, { node: '517', input: 'value' });
  assert.deepEqual(reset.body.config.bindings.seed, { node: '37', input: 'noise_seed' }, 'the generate map is left alone');

  const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'));
  assert.equal('staleUpscaleBindings' in onDisk, false, 'the report is an answer, not configuration');
  assert.deepEqual(onDisk.upscaleBindings.scale, { node: '517', input: 'value' });

  // A reset with no kind still means the generate map - the old caller's shape.
  const genReset = await post('/api/config/bindings/reset', {});
  assert.equal(genReset.body.kind, 'generate');
  assert.deepEqual(genReset.body.config.upscaleBindings.scale, { node: '517', input: 'value' });
});

test('the upscale workflow can be read and replaced on its own', async (t) => {
  const comfy = await startFakeComfyUI({ mode: 'manual' });
  t.after(() => comfy.close());
  await boot(t, comfy.port);

  const read = await get('/api/upscale/workflow');
  assert.equal(read.workflow['517']._meta.title, 'Scale Multiplier');
  assert.equal(read.workflow['508'].class_type, 'SaveImage');
  assert.equal(read.path.endsWith('upscale_api.json'), true);

  // The generate graph is a different file and must not be disturbed.
  const gen = await get('/api/workflow');
  assert.equal(gen.workflow['41']._meta.title, 'Input Prompt');

  const tiny = { 517: { class_type: 'PrimitiveFloat', inputs: { value: 3 }, _meta: { title: 'Scale Multiplier' } } };
  const put = await send('PUT', '/api/upscale/workflow', JSON.stringify({ workflow: tiny }));
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.nodes, 1);
  assert.deepEqual((await get('/api/upscale/workflow')).workflow, tiny);
  // Still the same file on disk, and the other one untouched.
  assert.equal(fs.existsSync(path.join(tmp, 'upscale_api.json.tmp')), false, 'the temp file is renamed, not left behind');
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'workflow_api.json'), 'utf8'))['41'] !== undefined, true);

  const junk = await send('PUT', '/api/upscale/workflow', JSON.stringify({ workflow: [1, 2, 3] }));
  assert.equal(junk.status, 400);
});

test('the generate route cannot be talked into running the other graph', async (t) => {
  const comfy = await startFakeComfyUI({ mode: 'manual' });
  t.after(() => comfy.close());
  await boot(t, comfy.port);

  // `kind` is the one field a request body must not decide: /api/generate checks
  // the generate bindings and /api/upscale checks the upscale ones, so a body
  // that picked its own graph could skip the matching pre-flight.
  const res = await post('/api/generate', { kind: 'upscale', slots: [{ uploadId: 'x' }], scale: 2 });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.match(res.body.error, /prompt is required|prompt/i);
  assert.equal((await get('/api/jobs')).jobs.length, 0);
});