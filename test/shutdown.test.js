import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isSameHost } from '../lib/shutdown.js';
import { startFakeComfyUI, sleep, dropRoot } from './helpers/fakeComfy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Each test file that spawns a server needs its OWN fixed port, because
// node --test runs the files in parallel. 3082 is reset.test.js's.
const PORT = 3083;
const base = `http://127.0.0.1:${PORT}`;

// ----------------------------------------------------------------- who may stop

const req = (remote, local) => ({ socket: { remoteAddress: remote, localAddress: local } });

test('only the phone may stop the phone', () => {
  assert.equal(isSameHost(req('127.0.0.1', '127.0.0.1')), true, 'loopback');
  assert.equal(isSameHost(req('::1', '::1')), true, 'ipv6 loopback');
  assert.equal(isSameHost(req('::ffff:127.0.0.1', '127.0.0.1')), true, 'mapped loopback');
  // The phone answering on its own wifi address - same machine either way.
  assert.equal(isSameHost(req('192.168.1.40', '192.168.1.40')), true, 'same LAN address');
  assert.equal(isSameHost(req('192.168.1.99', '192.168.1.40')), false, 'another device on the wifi');
});

test('a request with no socket information is allowed rather than locked out', () => {
  assert.equal(isSameHost({}), true);
  assert.equal(isSameHost({ socket: {} }), true);
  assert.equal(isSameHost(undefined), true);
});

test('the remote shutdown override is honoured', () => {
  const mismatch = req('192.168.1.99', '192.168.1.40');
  assert.equal(isSameHost(mismatch), false, 'no override in this process');
  assert.equal(isSameHost(mismatch, { MOBILE_CFY_ALLOW_REMOTE_SHUTDOWN: '1' }), true);
  assert.equal(isSameHost(mismatch, { MOBILE_CFY_ALLOW_REMOTE_SHUTDOWN: '0' }), false);
});

// ------------------------------------------------------------- the real thing

/** A throwaway server on its own root, pointed at a fake ComfyUI. */
async function startServer(t, comfyPort) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-cfy-shutdown-'));
  fs.copyFileSync(path.join(ROOT, 'workflow_api.json'), path.join(tmp, 'workflow_api.json'));
  fs.writeFileSync(
    path.join(tmp, 'config.json'),
    JSON.stringify({
      server: { host: '127.0.0.1', port: PORT },
      comfy: { host: '127.0.0.1', port: comfyPort, timeoutMs: 5000 },
      downloadDir: path.join(tmp, 'downloads'),
      dataDir: path.join(tmp, 'data'),
      promptTextNodes: ['181'],
    }),
  );

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, MOBILE_CFY_ROOT: tmp },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  // `left` matters: the server shuts ITSELF down, so the cleanup must not wait
  // for an 'exit' event that has already fired - that await never resolves.
  let left = null;
  const exited = new Promise((resolve) =>
    child.once('exit', (code) => { left = code; resolve(code); }));

  t.after(async () => {
    child.stdout.destroy();
    child.stderr.destroy();
    if (left === null) {
      const gone = new Promise((r) => child.once('exit', r));
      child.kill();
      await gone;
    }
    dropRoot(tmp);
  });

  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return { child, exited, logs: () => out };
    } catch { /* not listening yet */ }
    await sleep(100);
  }
  throw new Error(`the server never came up on ${PORT}\n${out}`);
}

const post = (p, body) =>
  fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

// The whole job shape, because a partial one is a 400 and no job is ever queued.
const JOB = (prompt, batch = 1) => ({
  prompt,
  batch,
  shuffle: 1,
  megapixels: 1,
  promptEnhance: false,
  turbo: false,
  stepsOverride: null,
  consistency: true,
});

/** Wait for the process to leave, and give up rather than hang the suite. */
const waitForExit = (app, ms = 8000) => Promise.race([app.exited, sleep(ms).then(() => 'timeout')]);

test('the shut down button stops the server and hands the queue over first', async (t) => {
  const comfy = await startFakeComfyUI({ mode: 'manual' });
  t.after(() => comfy.close());
  const app = await startServer(t, comfy.port);

  // Two jobs waiting, held so nothing is submitted on its own.
  await post('/api/queue/pause');
  await post('/api/generate', JOB('shut down me', 2));
  await post('/api/generate', JOB('and me', 1));

  const res = await post('/api/shutdown', { handover: true });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.stopping, true);
  assert.equal(body.jobs.length, 2, 'both jobs are named in the summary');
  assert.deepEqual(body.jobs.map((j) => j.runs), [2, 1]);
  assert.deepEqual(body.jobs.map((j) => j.atComfy), [0, 0], 'nothing had reached ComfyUI yet');
  assert.equal(body.handover.runs, 3, 'every queued run was handed over');

  // The reply only claims success - the port stopping is the actual proof, which
  // is exactly what the page polls for.
  const code = await waitForExit(app);
  assert.notEqual(code, 'timeout', `the process should have left\n${app.logs()}`);
  assert.equal(code, 0, 'and left quietly');
  assert.equal(await fetch(`${base}/api/health`).then(() => true, () => false), false,
    'the port refuses connections');
  assert.match(app.logs(), /bye \(web ui\)/, 'and says so in the log');
  assert.match(app.logs(), /shutting down on request/, 'naming the request');
  assert.doesNotMatch(app.logs(), /Assertion failed/, 'no libuv crash on the way out');

  // The work really is at ComfyUI: it did not die with the server.
  assert.equal(comfy.ids().length, 3);
});

test('a second press is told the first one is already on its way', async (t) => {
  const comfy = await startFakeComfyUI({ mode: 'manual' });
  t.after(() => comfy.close());
  const app = await startServer(t, comfy.port);
  await post('/api/queue/pause');
  await post('/api/generate', JOB('second press', 1));

  // Hold the ANSWER to /prompt back: the first shutdown is parked mid-handover,
  // which is exactly when a worried second tap arrives.
  const gate = comfy.stallNext();
  t.after(() => gate.release());
  const first = post('/api/shutdown', { handover: true });
  for (let i = 0; i < 100 && comfy.ids().length === 0; i++) await sleep(50);
  assert.equal(comfy.ids().length, 1, 'the handover reached ComfyUI');

  const second = await post('/api/shutdown');
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), { ok: true, stopping: true, already: true });

  gate.release();
  const body = await (await first).json();
  assert.equal(body.handover.runs, 1);
  assert.notEqual(await waitForExit(app), 'timeout');
});

test('the phone\'s own browser may stop it, and nothing is handed over unasked', async (t) => {
  const comfy = await startFakeComfyUI({ mode: 'manual' });
  t.after(() => comfy.close());
  const app = await startServer(t, comfy.port);
  // Held, so "nothing was handed over" can be told apart from "the queue
  // submitted it by itself a moment earlier".
  await post('/api/queue/pause');
  await post('/api/generate', JOB('plain stop', 1));

  const res = await post('/api/shutdown');
  assert.equal(res.status, 200, 'a loopback caller IS the phone');
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.handover, null, 'no handover was asked for, so none was attempted');
  assert.equal(body.jobs.length, 1, 'the queued job is still named, so the page can warn');

  assert.notEqual(await waitForExit(app), 'timeout');
  // The refusal itself needs a second machine to be provable, so it is covered
  // by the unit tests above; what matters here is that the real button works.
  assert.equal(comfy.ids().length, 0, 'and the queued run was left where it was');
});