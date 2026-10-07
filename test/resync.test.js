/**
 * The reconnect sweep: what ComfyUI's own queue and history say happened while
 * this app was not watching it.
 *
 * The rule the whole feature exists for, in the user's words: "i dont want to
 * resubmit work that is already done". So every test here checks BOTH halves -
 * the decision the sweep reached, and the thing it deliberately did NOT do
 * (post a second prompt, roll a fresh seed, touch a run it could not judge).
 *
 * The scenarios all start by PAUSING the queue. That keeps a single job sitting
 * in the waiting list rather than becoming the active one (the sweep never
 * judges the job it is actively watching), and it makes pause()'s early return
 * swallow the connection hold that a dropped response would otherwise trigger -
 * which is what keeps a back-watch resync from racing the one under test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { init, saveConfig } from '../lib/config.js';
import { runner } from '../lib/runner.js';
import * as gallery from '../lib/gallery.js';
import {
  stableStringify,
  fingerprintOf,
  graphFromHistoryEntry,
  graphFromQueueItem,
  findByFingerprint,
} from '../lib/resync.js';
import { startFakeComfyUI, waitFor, dropRoot } from './helpers/fakeComfy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Point the whole app at a throwaway root + a given ComfyUI port. */
async function useTempRoot(port) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-cfy-resync-'));
  init(root);
  saveConfig({
    comfy: { host: '127.0.0.1', port, timeoutMs: 5000 },
    workflowFile: path.join(ROOT, 'workflow_api.json'),
    enhancelessWorkflowFile: path.join(ROOT, 'workflow_api_enhanceless.json'),
    upscaleWorkflowFile: path.join(ROOT, 'upscale_api.json'),
    downloadDir: path.join(root, 'downloads'),
    dataDir: path.join(root, 'data'),
    promptTextNodes: ['181'],
  });
  runner.resetClient();
  await runner.resume();
  return root;
}

/** The runner is a module singleton - every test leaves it empty. */
async function cleanup() {
  for (const j of runner.list()) {
    if (['queued', 'running', 'paused'].includes(j.status)) runner.cancel(j.id);
  }
  await runner.resume();
}

const JOB = (prompt, extra = {}) => ({
  prompt,
  batch: 1,
  shuffle: 1,
  megapixels: 1,
  promptEnhance: true,
  turbo: false,
  stepsOverride: null,
  consistency: true,
  collectImages: true,
  ...extra,
});

// --------------------------------------------------------------- pure shapes

test('stableStringify treats key order as no identity, at any depth', () => {
  const one = { b: 1, a: { z: true, y: [1, { d: 4, c: 3 }] } };
  const two = { a: { y: [1, { c: 3, d: 4 }], z: true }, b: 1 };
  assert.equal(stableStringify(one), stableStringify(two));
  assert.equal(fingerprintOf(one), fingerprintOf(two));

  // ...but content still counts, and arrays keep their order.
  assert.notEqual(fingerprintOf(one), fingerprintOf({ ...one, b: 2 }));
  assert.notEqual(fingerprintOf({ y: [1, 2] }), fingerprintOf({ y: [2, 1] }));

  assert.equal(stableStringify(null), 'null');
  assert.equal(stableStringify(undefined), 'null');
  assert.equal(stableStringify('x'), '"x"');
  assert.equal(stableStringify([1, { b: 2, a: 3 }]), '[1,{"a":3,"b":2}]');
});

test('a fingerprint is a short hex string, stable for one payload', () => {
  const graph = { '41': { class_type: 'Primitive', inputs: { value: 'a prompt' } } };
  const fp = fingerprintOf(graph);
  assert.match(fp, /^[0-9a-f]{16}$/);
  assert.equal(fp, fingerprintOf(graph));
  assert.notEqual(fp, fingerprintOf({ ...graph, other: true }));
});

test('the same payload is found in every shape ComfyUI reports it in', () => {
  const graph = { '41': { class_type: 'Primitive', inputs: { value: 'a prompt' } } };
  const fp = fingerprintOf(graph);

  // /queue's documented positional form: [number, prompt_id, prompt, ...].
  assert.deepEqual(graphFromQueueItem([1, 'p9', graph, {}, []]), graph);
  // ...and the object-wrapped form older builds answer with.
  assert.deepEqual(graphFromQueueItem([1, 'p9', { prompt: graph }, {}, []]), graph);
  assert.deepEqual(graphFromQueueItem({ prompt: graph }), graph);
  assert.deepEqual(graphFromQueueItem(graph), graph);

  // /history has come as the graph itself, a triple, and an object wrapper.
  assert.deepEqual(graphFromHistoryEntry({ prompt: graph }), graph);
  assert.deepEqual(graphFromHistoryEntry({ prompt: ['client', {}, graph] }), graph);
  assert.deepEqual(graphFromHistoryEntry({ prompt: [graph] }), graph);
  assert.deepEqual(graphFromHistoryEntry({ prompt: { prompt: graph } }), graph);

  // Anything that is not a graph must come back null rather than a wrong match:
  // a fingerprint compared against a tuple never matches, which would mean
  // silently resubmitting work that already exists.
  assert.equal(graphFromHistoryEntry({ prompt: 'just some text' }), null);
  assert.equal(graphFromHistoryEntry({ prompt: {} }), null);
  assert.equal(graphFromHistoryEntry({ prompt: ['cid', {}, {}] }), null);
  assert.equal(graphFromHistoryEntry(null), null);
  assert.equal(graphFromQueueItem([1, 'p9', {}, {}, []]), null);
  assert.equal(graphFromQueueItem(null), null);

  // Extraction normalises the shapes, so the fingerprint survives the trip.
  const fromQueue = graphFromQueueItem([1, 'p9', graph, {}, []]);
  const fromHistory = graphFromHistoryEntry({ prompt: ['cid', {}, graph] });
  assert.deepEqual(findByFingerprint([{ id: 'p9', graph: fromQueue }], fp), { id: 'p9' });
  assert.deepEqual(findByFingerprint([{ id: 'p9', graph: fromHistory }], fp), { id: 'p9' });
});

test('a fingerprint match needs an id, a graph, and a fingerprint', () => {
  const graph = { '8': { class_type: 'SaveImage', inputs: {} } };
  const fp = fingerprintOf(graph);
  const other = fingerprintOf({ '8': { class_type: 'SaveImage', inputs: { x: 1 } } });

  assert.equal(findByFingerprint([{ id: 'p1', graph }], other), null, 'different payload');
  assert.equal(findByFingerprint([{ id: 'p1', graph }], null), null, 'no fingerprint to match');
  assert.equal(findByFingerprint([{ id: null, graph }], fp), null, 'no id to claim');
  assert.equal(findByFingerprint([{ id: 'p1', graph: null }], fp), null, 'no graph to hash');
  assert.equal(findByFingerprint([], fp), null);
  // First match wins, so a caller can hand over an ordered candidate list.
  assert.deepEqual(findByFingerprint([{ id: 'p2', graph: null }, { id: 'p1', graph }], fp), { id: 'p1' });
});

// ------------------------------------------------------- the sweep, end to end

test('work that finished while we were away is collected, never sent again', async () => {
  const comfy = await startFakeComfyUI({ mode: 'manual' });
  const root = await useTempRoot(comfy.port);
  try {
    // Paused first, so this job waits in the list instead of becoming the job
    // the sweep refuses to judge.
    runner.pause('manual');
    const job = runner.enqueue(JOB('finished while away'));
    await runner.submitAll();
    await waitFor(() => runner.get(job.id).runs[0].promptId, 'the prompt id came back');
    const id = runner.get(job.id).runs[0].promptId;
    const before = comfy.state.prompts.length;

    // ComfyUI finishes it while this app is not looking.
    comfy.state.pending.delete(id);
    comfy.state.running.delete(id);
    comfy.state.history.set(id, {
      status: { status_str: 'success', completed: true },
      outputs: {
        8: { images: [{ filename: 'ComfyUI_00042_.png', subfolder: '', type: 'output' }] },
        181: { text: ['enhanced: finished while we were away'] },
      },
    });

    const report = await runner.resync();

    assert.equal(report.ok, true, 'the evidence was readable');
    assert.equal(report.collected, 1, 'the finished run was collected');
    assert.equal(report.requeued, 0, 'and nothing was queued to send again');
    assert.equal(report.adopted, 0);
    assert.equal(report.closed, 1, 'the job it belonged to is over');
    assert.equal(report.failed, 0);

    const snap = runner.get(job.id);
    assert.equal(snap.status, 'done');
    assert.equal(snap.runs[0].status, 'done');
    assert.equal(snap.runs[0].promptId, id, 'the id it already had is kept');
    assert.equal(snap.runs[0].promptText, 'enhanced: finished while we were away');
    assert.equal(snap.runs[0].images.length, 1, 'the image was downloaded');
    assert.equal(gallery.entriesForJob(job.id).length, 1, 'and it is in the gallery');
    assert.equal(comfy.state.prompts.length, before, 'no second prompt was posted');
  } finally {
    await cleanup();
    await comfy.close();
    dropRoot(root);
  }
});

test('work that vanished from ComfyUI is sent again with its ORIGINAL seed', async () => {
  const comfy = await startFakeComfyUI({ mode: 'manual' });
  const root = await useTempRoot(comfy.port);
  try {
    runner.pause('manual');
    const job = runner.enqueue(JOB('vanished from the queue'));
    await runner.submitAll();
    await waitFor(() => runner.get(job.id).runs[0].promptId, 'the prompt id came back');

    const seed = runner.get(job.id).runs[0].seed;
    assert.ok(Number.isSafeInteger(seed), 'the run rolled a seed to keep');
    const id = runner.get(job.id).runs[0].promptId;
    const before = comfy.state.prompts.length;

    // A ComfyUI that restarted: no queue, no history, nothing to ask.
    comfy.state.pending.delete(id);
    comfy.state.running.delete(id);
    comfy.state.history.delete(id);
    comfy.state.graphs.delete(id);

    const report = await runner.resync();

    assert.equal(report.requeued, 1, 'the run was put back to go again');
    assert.equal(report.collected, 0, 'nothing was finished');
    assert.equal(report.adopted, 0);

    const run = runner.get(job.id).runs[0];
    assert.equal(run.promptId, null, 'the dead id is dropped');
    assert.equal(run.status, 'pending', 'and the run waits to be sent');
    assert.equal(run.seed, seed, 'the ORIGINAL seed is kept for the retry');
    assert.equal(run.error, null, 'the requeue is not an error');
    assert.equal(comfy.state.prompts.length, before, 'not sent again yet');

    // Resume: the retry is the SAME run, so the payload carries the same seed
    // rather than rolling a new image out from under the user.
    await runner.resume();
    await waitFor(() => comfy.state.prompts.length > before, 'the retry was posted');
    const resent = comfy.state.prompts.at(-1);
    assert.equal(resent.payload['37'].inputs.seed, seed, 'the retry reused the seed');
    assert.equal(runner.get(job.id).runs[0].promptId, resent.id, 'and owns its new id');

    // Let it finish. Leaving a job RUNNING here would leave it running when the
    // fake closes, and the next test would inherit a held queue instead of a
    // clean one - cleanup() cannot cancel a job that is no longer waiting.
    const drain = setInterval(() => comfy.completeAll(), 50);
    try {
      await waitFor(
        () => ['done', 'error', 'cancelled'].includes(runner.get(job.id).status),
        'the retry finished',
      );
    } finally {
      clearInterval(drain);
    }
    assert.equal(runner.get(job.id).status, 'done');
  } finally {
    await cleanup();
    await comfy.close();
    dropRoot(root);
  }
});

test('a run that lost its response is adopted from the queue, not sent twice', async () => {
  const comfy = await startFakeComfyUI({ mode: 'manual' });
  const root = await useTempRoot(comfy.port);
  try {
    runner.pause('manual');
    const job = runner.enqueue(JOB('lost its answer'));
    comfy.loseNextResponse();
    const report = await runner.submitAll();

    // The POST went out and the answer never came back: the prompt IS in
    // ComfyUI's queue, and the run is left holding only a fingerprint.
    assert.equal(report.failures.length, 1, 'the dropped response was reported');
    assert.equal(comfy.state.prompts.length, 1, 'ComfyUI did receive the prompt');
    const run = runner.get(job.id).runs[0];
    assert.equal(run.promptId, null, 'no id came back');
    // run.fp is deliberately not on the snapshot - it is an internal handle, not
    // something the UI shows. Its existence is proved by what happens next: with
    // no prompt id, the ONLY way to find this run again is by hashing the payload
    // that was written out BEFORE the request went.

    // pause() was already 'manual', so the connection hold this would normally
    // trigger is swallowed and no back-watch resync can race the one under test.
    const sweep = await runner.resync();

    assert.equal(sweep.adopted, 1, 'the fingerprint found the queued prompt');
    assert.equal(sweep.requeued, 0, 'it was not sent again');
    assert.equal(sweep.collected, 0);
    assert.equal(sweep.ok, true);

    const after = runner.get(job.id).runs[0];
    assert.equal(after.promptId, comfy.state.prompts[0].id, 'the run owns that prompt id');
    assert.equal(after.status, 'submitted');
    assert.equal(comfy.state.prompts.length, 1, 'still exactly one prompt');
  } finally {
    await cleanup();
    await comfy.close();
    dropRoot(root);
  }
});

test('an unreadable queue judges nothing at all', async () => {
  const comfy = await startFakeComfyUI({ mode: 'manual' });
  const root = await useTempRoot(comfy.port);
  try {
    runner.pause('manual');
    const job = runner.enqueue(JOB('cannot be judged'));
    await runner.submitAll();
    await waitFor(() => runner.get(job.id).runs[0].promptId, 'the prompt id came back');

    const before = {
      promptId: runner.get(job.id).runs[0].promptId,
      status: runner.get(job.id).runs[0].status,
      seed: runner.get(job.id).runs[0].seed,
      prompts: comfy.state.prompts.length,
    };

    // A ComfyUI that answers everything except /queue. There is no "it is not
    // queued" verdict to be had here, so nothing may be resubmitted for it.
    comfy.state.queueFail = true;
    const report = await runner.resync();

    assert.equal(report.ok, false, 'the sweep refuses to claim it succeeded');
    assert.match(report.problem, /queue/);
    assert.equal(report.collected, 0);
    assert.equal(report.requeued, 0, 'nothing was resubmitted on a guess');
    assert.equal(report.adopted, 0);

    const run = runner.get(job.id).runs[0];
    assert.equal(run.promptId, before.promptId, 'the run was left exactly as it was');
    assert.equal(run.status, before.status);
    assert.equal(run.seed, before.seed);
    assert.equal(comfy.state.prompts.length, before.prompts, 'no prompt was posted');
    assert.equal(runner.queueState().lastResync.ok, false, 'the report reaches the UI');
  } finally {
    comfy.state.queueFail = false;
    await cleanup();
    await comfy.close();
    dropRoot(root);
  }
});
