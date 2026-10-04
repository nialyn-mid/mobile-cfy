import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { init, saveConfig, paths } from '../lib/config.js';
import { runner } from '../lib/runner.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A 1x1 PNG - the downloader only needs bytes with the right magic number.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * A stand-in for ComfyUI, good enough to exercise the queue: /prompt, /history,
 * /queue (including the `delete` form cancel needs), /view and /system_stats.
 *
 * `mode: 'manual'` keeps every submitted prompt pending until the test finishes
 * it, which is what makes "hand the whole batch over and walk away" observable.
 */
function startFakeComfyUI({ mode = 'instant' } = {}) {
  const state = {
    mode,
    prompts: [],
    deleted: [],
    next: 0,
    pending: new Map(),
    history: new Map(),
  };

  const entryFor = (n, prompt) => ({
    status: { status_str: 'success', completed: true },
    outputs: {
      8: { images: [{ filename: `ComfyUI_${String(n).padStart(5, '0')}_.png`, subfolder: '', type: 'output' }] },
      181: { text: [`enhanced: ${String(prompt).slice(0, 40)}`] },
    },
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'Content-Type': type });
      res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };

    if (req.method === 'POST' && url.pathname === '/prompt') {
      readJson(req).then((body) => {
        const n = ++state.next;
        const promptId = `p${n}`;
        state.prompts.push({ id: promptId, payload: body?.prompt, clientId: body?.client_id });
        if (state.mode === 'instant') state.history.set(promptId, entryFor(n, 'x'));
        else state.pending.set(promptId, n);
        send(200, { prompt_id: promptId, number: n, node_errors: {} });
      });
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/history/')) {
      const id = decodeURIComponent(url.pathname.slice('/history/'.length));
      const n = state.history.has(id) ? null : state.pending.get(id);
      if (state.history.has(id)) send(200, { [id]: state.history.get(id) });
      else if (n !== undefined) send(200, { [id]: { status: { status_str: 'pending' }, outputs: {} } });
      else send(200, {});
      return;
    }

    if (url.pathname === '/queue') {
      if (req.method === 'POST') {
        readJson(req).then((body) => {
          for (const id of body?.delete ?? []) {
            state.deleted.push(id);
            state.pending.delete(id);
            state.history.delete(id);
          }
          send(200, {});
        });
        return;
      }
      send(200, {
        queue_running: [...state.pending.keys()].map((id) => [1, id, {}, {}, []]),
        queue_pending: [],
      });
      return;
    }

    if (url.pathname === '/view') return send(200, PNG, 'image/png');
    if (url.pathname === '/system_stats') {
      return send(200, { system: { comfyui_version: '0.3.0-test', devices: [] } });
    }
    send(404, { error: 'not found' });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        state,
        /** Finish every prompt still waiting. */
        completeAll() {
          for (const [id, n] of state.pending) state.history.set(id, entryFor(n, 'x'));
          state.pending.clear();
        },
        ids: () => state.prompts.map((p) => p.id),
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** The prompt text a submitted payload carried, whichever text node took it. */
function textOf(p) {
  const wf = p.payload ?? {};
  return wf['41']?.inputs?.value ?? wf['44']?.inputs?.value ?? null;
}

function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, label, timeout = 15000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await sleep(40);
  }
}

/** Point the whole app at a throwaway root + a given ComfyUI port. */
function useTempRoot(port) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-cfy-queue-'));
  init(root);
  saveConfig({
    comfy: { host: '127.0.0.1', port, timeoutMs: 5000 },
    // Absolute, so the temp root does not need a copy of the workflow.
    workflowFile: path.join(ROOT, 'workflow_api.json'),
    downloadDir: path.join(root, 'downloads'),
    dataDir: path.join(root, 'data'),
    promptTextNodes: ['181'],
  });
  runner.resetClient();
  // A pause left behind by an earlier test would silently swallow the next one.
  runner.resume();
  return root;
}

/**
 * The runner is a module singleton, so a job left held by one test would still
 * be in the queue for the next one. Every test ends by calling this.
 */
function cleanup() {
  for (const j of runner.list()) {
    if (['queued', 'running', 'paused'].includes(j.status)) runner.cancel(j.id);
  }
  runner.resume();
}

const JOB = (prompt, batch = 1) => ({
  prompt,
  batch,
  shuffle: 1,
  megapixels: 1,
  promptEnhance: true,
  turbo: false,
  stepsOverride: null,
  consistency: true,
});

test('submit all hands the running job\'s tail AND the waiting jobs to ComfyUI', async () => {
  const comfy = await startFakeComfyUI({ mode: 'manual' });
  useTempRoot(comfy.port);
  try {
    const a = runner.enqueue(JOB('bulk alpha', 2));
    const b = runner.enqueue(JOB('bulk beta', 1));

    // The queue starts one run of A on its own; everything else waits.
    await waitFor(() => comfy.state.prompts.length === 1, 'the first run of A');
    assert.equal(runner.get(a.id).runs[0].status, 'running');
    assert.equal(runner.get(b.id).status, 'queued');

    const report = await runner.submitAll();
    // A still has its own run 2 to hand over, B has run 1. The run the queue
    // already submitted is not re-sent, so it is only reported as already there.
    assert.equal(report.runs, 2);
    assert.equal(report.jobs, 2);
    assert.equal(report.alreadySubmitted, 1);
    assert.deepEqual(report.failures, []);
    assert.equal(comfy.state.prompts.length, 3, 'one prompt per run of a 2+1 batch');

    // Pressing it again costs nothing.
    const again = await runner.submitAll();
    assert.equal(again.runs, 0);
    assert.equal(again.alreadySubmitted, 3);
    assert.equal(comfy.state.prompts.length, 3);

    // Order is preserved: A's remaining run is ahead of B's, because that is the
    // order the queue would have submitted them in anyway.
    assert.deepEqual(comfy.state.prompts.map(textOf), ['bulk alpha', 'bulk alpha', 'bulk beta']);
    assert.equal(runner.get(a.id).status, 'running');
    assert.equal(runner.get(b.id).status, 'queued');

    comfy.completeAll();
    await waitFor(() => runner.get(a.id).status === 'done', 'A to finish');
    await waitFor(() => runner.get(b.id).status === 'done', 'B to finish');

    const snapA = runner.get(a.id);
    assert.equal(snapA.summary.images, 2);
    assert.equal(snapA.runs.every((r) => r.promptId), true);
    // A seed per run, all different - the recorded seed is the one that made
    // the image, so a double roll here would show up as a duplicate.
    const seeds = [...snapA.runs.map((r) => r.seed), ...runner.get(b.id).runs.map((r) => r.seed)];
    assert.equal(seeds.every((s) => Number.isInteger(s)), true);
    assert.equal(new Set(seeds).size, seeds.length);

    // Images really landed on disk, and the text capture came back with them.
    assert.equal(fs.existsSync(paths().downloadDir), true);
    assert.equal(snapA.runs[0].promptText.startsWith('enhanced:'), true);
  } finally {
    cleanup();
    await comfy.close();
  }
});

test('a lost connection holds the queue instead of failing the job', async () => {
  // Nothing is listening on this port, which is what leaving the network looks
  // like from the server's side.
  useTempRoot(1);
  try {
    const a = runner.enqueue(JOB('offline one', 2));
    const q = await waitFor(() => (runner.queueState().paused ? runner.queueState() : null), 'the queue to hold');

    assert.equal(q.reason, 'connection');
    assert.equal(q.waiting, 1, 'the held job is kept at the front of the queue');
    assert.ok(q.message, 'the reason says what went wrong');

    const snap = runner.get(a.id);
    assert.equal(snap.status, 'paused');
    // Nothing is lost and nothing is half-done: no prompt id, no error on a
    // run, and no end time - a held job has not finished, it is waiting.
    assert.equal(snap.summary.done, 0);
    assert.equal(snap.summary.failed, 0);
    assert.equal(snap.finishedAt, null, 'a held job is not over, so it has no end time');
    assert.equal(snap.runs.every((r) => r.status === 'pending' && !r.promptId && r.endedAt === null), true);
    assert.match(snap.error, /ComfyUI at http:\/\/127\.0\.0\.1:1/);
  } finally {
    cleanup();
  }
});

test('requests can still be built while the queue is held, and resume finishes them all', async () => {
  // Start with no server at all, queue work offline, then bring one up.
  useTempRoot(1);
  const comfy = await startFakeComfyUI({ mode: 'instant' });
  try {
    const a = runner.enqueue(JOB('built offline a', 2));
    await waitFor(() => runner.queueState().paused, 'the first hold');
    const b = runner.enqueue(JOB('built offline b', 1));
    assert.equal(runner.get(b.id).status, 'queued', 'a paused queue still accepts work');
    assert.equal(runner.queueState().waiting, 2);

    saveConfig({ comfy: { host: '127.0.0.1', port: comfy.port, timeoutMs: 5000 } });
    runner.resetClient();
    assert.equal(runner.resume().paused, false);

    await waitFor(() => runner.get(a.id).status === 'done', 'A to finish after the resume');
    await waitFor(() => runner.get(b.id).status === 'done', 'B to finish after the resume');

    assert.equal(comfy.state.prompts.length, 3, '3 runs, each submitted exactly once');
    assert.equal(new Set(comfy.state.prompts.map((p) => p.id)).size, 3);
    assert.equal(runner.get(a.id).summary.images, 2);
    assert.equal(runner.get(b.id).summary.images, 1);
    assert.equal(runner.queueState().paused, false);
    assert.equal(runner.queueState().waiting, 0);
  } finally {
    cleanup();
    await comfy.close();
  }
});

test('cancel after a bulk submit calls ComfyUI\'s delete for the prompt that never started', async () => {
  const comfy = await startFakeComfyUI({ mode: 'manual' });
  useTempRoot(comfy.port);
  try {
    const a = runner.enqueue(JOB('cancel me', 2));
    await waitFor(() => comfy.state.prompts.length === 1, 'the first run');
    await runner.submitAll();
    assert.equal(comfy.state.prompts.length, 2);
    const [running, waiting] = comfy.ids();

    assert.equal(runner.cancel(a.id), true);
    // ComfyUI refuses to delete a prompt it has already started, and the one it
    // is chewing on is the one this app was watching - so only the bulk-submitted
    // prompt gets called off, not the running one.
    await waitFor(() => comfy.state.deleted.length === 1, 'ComfyUI to be told to drop the queued prompt');
    assert.deepEqual(comfy.state.deleted, [waiting]);
    assert.notEqual(running, waiting);
    assert.equal(runner.get(a.id).runs[1].status, 'cancelled');

    // Nothing is left running here either.
    await waitFor(() => runner.get(a.id).status === 'cancelled', 'the job to settle as cancelled');
    assert.equal(runner.get(a.id).summary.done, 0);
  } finally {
    cleanup();
    await comfy.close();
  }
});

test('a manual pause holds the queue and resume starts it again', async () => {
  const comfy = await startFakeComfyUI({ mode: 'instant' });
  useTempRoot(comfy.port);
  try {
    const held = runner.pause('manual');
    assert.equal(held.paused, true);
    assert.equal(held.reason, 'manual');

    const a = runner.enqueue(JOB('held by hand', 1));
    await sleep(300);
    assert.equal(runner.get(a.id).status, 'queued', 'a manual pause does not start anything');
    assert.equal(comfy.state.prompts.length, 0);

    assert.equal(runner.resume().paused, false);
    await waitFor(() => runner.get(a.id).status === 'done', 'the held job to run after the resume');
    assert.equal(comfy.state.prompts.length, 1);
  } finally {
    cleanup();
    await comfy.close();
  }
});
