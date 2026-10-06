import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { startFakeComfyUI, sleep, waitFor } from './helpers/fakeComfy.js';

/**
 * The third graph's HTTP surface: workflow_api_enhanceless.json, the file that
 * runs whenever the enhance toggle is off, and the separate binding map the
 * Settings tab keeps for it.
 *
 * Everything here exists because one flag (promptEnhance) picks THREE things -
 * the file, the binding map and the pre-flight - and if any two of those ever
 * disagree, the failure mode is a run submitted against a graph whose nodes the
 * checked bindings do not have. Each test pins one of those couplings.
 *
 * Port 3081 is the live instance; 3082/3083/3084 belong to the other server
 * test files, so this one takes 3085.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3085;
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

// The whole job shape, because a partial one is a 400 and no job is ever queued.
const JOB = (prompt, promptEnhance) => ({
  prompt,
  batch: 1,
  shuffle: 1,
  megapixels: 1,
  promptEnhance,
  turbo: false,
  stepsOverride: null,
  consistency: true,
});

let tmp;
let log = '';

/** Boot the third server. `enhanceless` / `generate` land in config.json verbatim. */
async function boot(t, comfyPort, { enhanceless, generate } = {}) {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcfy-enhanceless-'));
  for (const file of ['workflow_api.json', 'workflow_api_enhanceless.json', 'upscale_api.json']) {
    fs.copyFileSync(path.join(ROOT, file), path.join(tmp, file));
  }
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
    server: { host: '127.0.0.1', port: PORT },
    comfy: { host: '127.0.0.1', port: comfyPort, timeoutMs: 5000 },
    downloadDir: path.join(tmp, 'downloads'),
    dataDir: path.join(tmp, 'data'),
    ...(enhanceless ? { enhancelessBindings: enhanceless } : {}),
    ...(generate ? { bindings: generate } : {}),
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

test('the enhanceless kind checks its own graph, against its own file', async (t) => {
  await boot(t, 9);
  const check = await post('/api/config/validate', { kind: 'enhanceless' });
  assert.equal(check.body.kind, 'enhanceless');
  assert.equal(check.body.ok, true, JSON.stringify(check.body.bindings));

  // The defaults really are checked against the OTHER file: same ids by luck
  // today, which is exactly the coincidence the separate map exists to survive.
  const wf = await get('/api/enhanceless/workflow');
  assert.ok(wf.path.endsWith('workflow_api_enhanceless.json'), wf.path);
  assert.equal(wf.workflow['44']._meta.title, 'Raw Prompt (If Enhance Disabled)');
  assert.equal(wf.workflow['226'], undefined, 'the enhancer is not in this file');
  assert.equal(wf.workflow['176'], undefined, 'nor the enhance switch - picking the file replaced it');

  // ...and the normal file is untouched and still has those nodes.
  const normal = await get('/api/workflow');
  assert.ok(normal.path.endsWith('workflow_api.json'), normal.path);
  assert.ok(normal.workflow['226'], 'the enhancer still lives in the normal file');

  const cfg = await get('/api/config');
  assert.ok(cfg.resolved.enhancelessWorkflow.endsWith('workflow_api_enhanceless.json'),
    'GET /api/config names the third resolved path');
});

test('each flag refuses runs against its OWN map, and only its own', async (t) => {
  const comfy = await startFakeComfyUI({ mode: 'manual' });
  t.after(() => comfy.close());
  await boot(t, comfy.port, {
    // The enhanceless map points at a node its graph does not have.
    enhanceless: { promptRaw: { node: '9999', input: 'value' } },
  });
  await post('/api/queue/pause'); // held, so nothing submits on its own

  const check = await post('/api/config/validate', { kind: 'enhanceless' });
  assert.equal(check.body.ok, false, 'the broken row is reported');
  assert.deepEqual(check.body.bindings.filter((b) => !b.ok).map((b) => b.binding), ['promptRaw']);
  const gen = await post('/api/config/validate', { kind: 'generate' });
  assert.equal(gen.body.ok, true, 'an enhanceless problem is not a generate problem');

  // Break the normal map too - the inverse direction of the same question.
  const put = await send('PUT', '/api/config', JSON.stringify({
    bindings: { promptEnhanced: { node: '9999', input: 'value' } },
  }));
  assert.equal(put.status, 200, JSON.stringify(put.body));

  // Enhance OFF checks the enhanceless map: its own broken row is what gets named.
  const off = await post('/api/generate', JOB('a dog in a park', false));
  assert.equal(off.status, 400, JSON.stringify(off.body));
  assert.match(off.body.error, /binding problem/);
  assert.match(off.body.error, /promptRaw/);

  // Enhance ON checks the normal map: the OTHER broken row is what gets named,
  // proving the flag picks the map and not just the file.
  const on = await post('/api/generate', JOB('a dog in a park', true));
  assert.equal(on.status, 400, JSON.stringify(on.body));
  assert.match(on.body.error, /promptEnhanced/);

  // Restore the normal map: enhance-on runs again while enhance-off - whose map
  // is still broken - keeps refusing. The two really are separate switches.
  const fixed = await send('PUT', '/api/config', JSON.stringify({
    bindings: { promptEnhanced: { node: '41', input: 'value' } },
  }));
  assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
  const okRun = await post('/api/generate', JOB('a cat in a kitchen', true));
  assert.equal(okRun.status, 202, JSON.stringify(okRun.body));

  const { jobs } = await get('/api/jobs');
  assert.equal(jobs.length, 1, 'only the healthy run was ever queued');
});

test('an enhance-off run is submitted as the enhanceless graph with the raw prompt', async (t) => {
  const comfy = await startFakeComfyUI({ mode: 'instant' });
  t.after(() => comfy.close());
  await boot(t, comfy.port);

  const res = await post('/api/generate', JOB('a dog in a park', false));
  assert.equal(res.status, 202, JSON.stringify(res.body));
  await waitFor(() => comfy.state.prompts.length === 1, 'the prompt to reach ComfyUI');
  const wf = comfy.state.prompts[0].payload;

  assert.equal(wf['44'].inputs.value, 'a dog in a park', 'the raw prompt node got the text');
  assert.equal(wf['176'], undefined, 'this is the enhanceless file, not the normal one');
  assert.equal(wf['226'], undefined, 'no enhancer in the graph that ran');
  // The bindings the run wrote through were the enhanceless ones: Image Count
  // and turbo live in that map too, and they were written (the graph shipped
  // with its own values, so a no-op write would leave those untouched).
  assert.equal(wf['158'].inputs.value, 0, 'imageCount written through the enhanceless map');

  // waitFor() checks fn()'s return synchronously, so an async probe would pass
  // on the Promise alone; poll explicitly until the run settles.
  let status = '';
  for (let i = 0; i < 150 && status !== 'done'; i++) {
    status = (await get(`/api/jobs/${res.body.id}`)).status;
    if (status !== 'done') await sleep(100);
  }
  assert.equal(status, 'done', 'the job finished against the fake ComfyUI');
});

test('an unknown enhanceless binding name is reported against that map only', async (t) => {
  await boot(t, 9);
  const put = await send('PUT', '/api/config', JSON.stringify({
    enhancelessBindings: { ghostSwitch: { node: '176', input: 'cond' } },
  }));
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.deepEqual(put.body.staleEnhancelessBindings, ['ghostSwitch'], 'one report per map');
  assert.deepEqual(put.body.staleBindings, [], 'and silence about the others');

  const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'));
  assert.equal('ghostSwitch' in onDisk.enhancelessBindings, false, 'the dropped name is not written');
  assert.equal('staleEnhancelessBindings' in onDisk, false, 'the report is an answer, not configuration');
  assert.deepEqual(onDisk.bindings.promptEnhanced, { node: '41', input: 'value' },
    'the other maps are still the shipped ones');
});

test('the enhanceless bindings can be reset without touching the other two', async (t) => {
  await boot(t, 9, { enhanceless: { promptRaw: { node: '9999', input: 'value' } } });
  // A hand-edited generate binding, so "left alone" has an answer.
  const marked = await send('PUT', '/api/config', JSON.stringify({
    bindings: { seed: { node: '37', input: 'noise_seed' } },
  }));
  assert.equal(marked.status, 200, JSON.stringify(marked.body));

  const reset = await post('/api/config/bindings/reset', { kind: 'enhanceless' });
  assert.equal(reset.body.kind, 'enhanceless');
  assert.equal(reset.body.ok, true, JSON.stringify(reset.body.bindings));
  assert.deepEqual(reset.body.config.enhancelessBindings.promptRaw, { node: '44', input: 'value' });
  assert.deepEqual(reset.body.config.bindings.seed, { node: '37', input: 'noise_seed' },
    'the generate map is left alone');
  assert.deepEqual(reset.body.config.upscaleBindings.seed, { node: '536', input: 'seed' },
    'and so is the upscale map');
});

test('the enhanceless workflow can be read and replaced on its own', async (t) => {
  await boot(t, 9);
  const read = await get('/api/enhanceless/workflow');
  assert.equal(read.workflow['44'].class_type, 'PrimitiveStringMultiline');
  assert.ok(read.path.endsWith('workflow_api_enhanceless.json'));

  const tiny = {
    44: { class_type: 'PrimitiveStringMultiline', inputs: { value: 'x' }, _meta: { title: 'Raw Prompt (If Enhance Disabled)' } },
  };
  const put = await send('PUT', '/api/enhanceless/workflow', JSON.stringify({ workflow: tiny }));
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.nodes, 1);
  assert.deepEqual((await get('/api/enhanceless/workflow')).workflow, tiny);
  assert.equal(fs.existsSync(path.join(tmp, 'workflow_api_enhanceless.json.tmp')), false,
    'the temp file is renamed, not left behind');

  // The other two files were not disturbed.
  const normal = JSON.parse(fs.readFileSync(path.join(tmp, 'workflow_api.json'), 'utf8'));
  assert.ok(normal['226'], 'the normal file still has its enhancer');
  assert.ok(fs.existsSync(path.join(tmp, 'upscale_api.json')), 'and the upscale file is still there');

  const junk = await send('PUT', '/api/enhanceless/workflow', JSON.stringify({ workflow: [1, 2, 3] }));
  assert.equal(junk.status, 400, 'an array is not a graph');
});
