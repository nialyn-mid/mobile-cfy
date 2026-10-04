import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

/**
 * Boots a SECOND server on a spare port against a temp root, so the running
 * instance is never touched and nothing is ever submitted to ComfyUI - only the
 * config endpoints are exercised here.
 *
 * Port 3081 is the live one; this uses 3082 and a MOBILE_CFY_ROOT of its own.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3082;
const base = `http://127.0.0.1:${PORT}`;

const get = async (p) => (await fetch(base + p)).json();
const post = async (p, body) => (await fetch(base + p, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body ?? {}),
})).json();

let child;
let tmp;
let log = '';

test('bindings reset to defaults, and broken ones stop blocking generate', async (t) => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcfy-reset-'));
  fs.copyFileSync(path.join(ROOT, 'workflow_api.json'), path.join(tmp, 'workflow_api.json'));
  // Wrong in both interesting ways: a half-migrated binding (right node, old
  // input name - a real node with an input that does not exist) and a node that
  // is not in the workflow at all.
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
    server: { host: '127.0.0.1', port: PORT },
    bindings: {
      enhanceSwitch: { node: '176', input: 'switch' },
      seed: { node: '9999', input: 'seed' },
    },
  }, null, 2));

  child = spawn(process.execPath, ['server.js'], {
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
    // Windows needs the child to be gone before this process lets go of its
    // handles; killing it and immediately calling process.exit() trips an
    // assertion inside libuv.
    await exited;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  for (let i = 0; i < 60; i++) {
    try { await fetch(`${base}/api/health`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }

  const before = await post('/api/config/validate');
  const bad = before.bindings.filter((b) => !b.ok);
  assert.equal(bad.length, 1, `exactly one problem to start with: ${log}`);
  assert.equal(bad[0].binding, 'seed');
  assert.match(bad[0].reason, /9999/);
  assert.equal(before.ok, false);
  assert.ok(
    before.bindings.find((b) => b.binding === 'enhanceSwitch').ok,
    'the half-migrated enhance switch is repaired by the startup migration',
  );

  const gen = await fetch(`${base}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'x' }),
  });
  const genBody = await gen.json();
  assert.equal(gen.status, 400);
  assert.match(genBody.error, /binding problem/);

  const reset = await post('/api/config/bindings/reset');
  const stillBad = reset.bindings.filter((b) => !b.ok);
  assert.deepEqual(stillBad, [], `the defaults must fit the workflow: ${JSON.stringify(stillBad)}`);
  assert.equal(reset.ok, true);
  assert.ok(reset.bindings.length >= 15, 'every binding is reported back');
  assert.deepEqual(reset.config.bindings.enhanceSwitch, { node: '176', input: 'cond' });
  assert.deepEqual(reset.config.bindings.seed, { node: '37', input: 'seed' });
  assert.equal(reset.config.bindings.images.length, 4);

  const after = await post('/api/config/validate');
  assert.equal(after.ok, true);
  const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'));
  assert.deepEqual(onDisk.bindings.seed, { node: '37', input: 'seed' });
  assert.deepEqual(onDisk.bindings.consistencyLora, { node: '207', input: 'value' });

  const again = await post('/api/config/bindings/reset');
  assert.equal(again.ok, true, 'a second reset is a no-op, not a new breakage');

  // the job queue is untouched by any of this - nothing was submitted
  const jobs = await get('/api/jobs');
  assert.deepEqual(jobs.jobs, []);
});