import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { init, saveConfig, paths } from '../lib/config.js';
import { ComfyClient } from '../lib/comfy.js';
import { runner } from '../lib/runner.js';
import * as gallery from '../lib/gallery.js';
import { startFakeComfyUI, textOf, sleep, waitFor, dropRoot } from './helpers/fakeComfy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = JSON.parse(fs.readFileSync(path.join(ROOT, 'workflow_api.json'), 'utf8'));
// What nodes 256 and 44 ship with, so "we left it alone" can be asserted by
// value rather than by trusting that a no-op write really was a no-op.
const WORKFLOW_POSTPROMPT_DEFAULT = WORKFLOW['256'].inputs.value;
const WORKFLOW_RAW_DEFAULT = WORKFLOW['44'].inputs.value;

/** Point the whole app at a throwaway root + a given ComfyUI port. */
function useTempRoot(port) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-cfy-queue-'));
  init(root);
  saveConfig({
    comfy: { host: '127.0.0.1', port, timeoutMs: 5000 },
    // Absolute, so the temp root does not need a copy of the workflow.
    workflowFile: path.join(ROOT, 'workflow_api.json'),
    upscaleWorkflowFile: path.join(ROOT, 'upscale_api.json'),
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

/** An upscale request: one image, taken from a picture the gallery already holds. */
const UPSCALE = (scale = 2, extra = {}) => {
  const src = gallery.addEntry({
    prompt: 'an earlier run',
    at: new Date().toISOString(),
    comfyFilename: 'ComfyUI_00001_.png',
    subfolder: '',
    type: 'output',
    localName: 'earlier.png',
  });
  return { kind: 'upscale', slots: [{ ref: src.id }], scale, collectImages: true, ...extra };
};

/** Finish prompts as they arrive, so a two-job queue drains without help. */
function autoFinish(comfy) {
  const t = setInterval(() => {
    if (comfy.state.pending.size) comfy.completeAll();
  }, 100);
  return () => clearInterval(t);
}

test('submit all hands the running job\'s tail AND the waiting jobs to ComfyUI', async () => {
  const comfy = await startFakeComfyUI({ mode: 'manual' });
  const root = useTempRoot(comfy.port);
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
    dropRoot(root);
  }
});

test('send everything never re-sends a run that is already on its way', async () => {
  const comfy = await startFakeComfyUI({ mode: 'manual' });
  const root = useTempRoot(comfy.port);
  const gate = comfy.stallNext();
  try {
    const a = runner.enqueue(JOB('bulk race', 2));
    // ComfyUI has the first prompt, but the phone has not been told the id yet.
    // In that window the run has no prompt id and yet is submitted as far as the
    // queue is concerned - and "send everything" must read it that way too.
    await waitFor(() => comfy.state.prompts.length === 1, 'the first prompt to arrive');

    const report = await runner.submitAll();
    assert.equal(report.runs, 1, 'only the run nobody is submitting was handed over');
    assert.equal(report.alreadySubmitted, 1, 'the in-flight run counts as already there');
    assert.equal(comfy.state.prompts.length, 2, 'no duplicate prompt reached ComfyUI');

    gate.release();
    await waitFor(() => runner.get(a.id).runs[0].promptId, 'the in-flight prompt id');
    // The seed recorded for the in-flight run is the one its payload carried, so
    // the image and the history row still agree.
    const [firstRun, secondRun] = runner.get(a.id).runs;
    assert.equal(comfy.state.prompts[0].payload?.['37']?.inputs?.seed, firstRun.seed);
    assert.notEqual(firstRun.seed, secondRun.seed, 'a re-send would have burnt a second seed');
  } finally {
    gate.release();
    cleanup();
    await comfy.close();
    dropRoot(root);
  }
});

test('a lost connection holds the queue instead of failing the job', async () => {
  // Nothing is listening on this port, which is what leaving the network looks
  // like from the server's side.
  const root = useTempRoot(1);
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
    dropRoot(root);
  }
});

test('requests can still be built while the queue is held, and resume finishes them all', async () => {
  // Start with no server at all, queue work offline, then bring one up.
  const root = useTempRoot(1);
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
    dropRoot(root);
  }
});

test('cancel after a bulk submit calls ComfyUI\'s delete for the prompt that never started', async () => {
  const comfy = await startFakeComfyUI({ mode: 'manual' });
  const root = useTempRoot(comfy.port);
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
    dropRoot(root);
  }
});

test('a manual pause holds the queue and resume starts it again', async () => {
  const comfy = await startFakeComfyUI({ mode: 'instant' });
  const root = useTempRoot(comfy.port);
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
    dropRoot(root);
  }
});

// ---------------------------------------------------------------- run timers

test('one look at the queue separates queued from running, and says how far back the wait is', async () => {
  const comfy = await startFakeComfyUI({ mode: 'manual', holdStart: true });
  const client = new ComfyClient(`http://127.0.0.1:${comfy.port}`);
  try {
    const send = async () =>
      (await fetch(`http://127.0.0.1:${comfy.port}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: {} }),
      })).json();
    const one = (await send()).prompt_id;
    const two = (await send()).prompt_id;

    // Handed over, not begun: the state the run timer has to be right about.
    assert.deepEqual(await client.queueLookup(one), { state: 'pending', position: 0, remaining: 0 });
    assert.deepEqual(await client.queueLookup(two), { state: 'pending', position: 1, remaining: 0 });

    comfy.start(one);
    assert.deepEqual(await client.queueLookup(one), { state: 'running', position: null, remaining: 1 });
    // The one behind moves up, because the started prompt left the waiting list.
    assert.deepEqual(await client.queueLookup(two), { state: 'pending', position: 0, remaining: 1 });

    assert.equal((await client.queueLookup('p-never-existed')).state, 'absent');

    // A probe that cannot answer is unknown, never "empty queue": a flaky network
    // must not read as "the prompt is gone".
    await comfy.close();
    assert.deepEqual(await client.queueLookup(one), { state: 'unknown', position: null, remaining: null });
  } finally {
    await comfy.close();
  }
});

test("a run's timer starts when ComfyUI begins it, not when the phone hands it over", async () => {
  const comfy = await startFakeComfyUI({ mode: 'manual', holdStart: true });
  const root = useTempRoot(comfy.port);
  try {
    const a = runner.enqueue(JOB('timer alpha', 2));
    await waitFor(() => comfy.state.prompts.length === 1, 'the first prompt to be handed over');

    const waiting = runner.get(a.id).runs[0];
    assert.equal(waiting.promptId !== null, true, 'ComfyUI has it');
    assert.equal(waiting.startedAt, null, 'but has not begun it, so there is no timer to show');

    const handedOverAt = Date.now();
    comfy.startAll();
    await waitFor(() => runner.get(a.id).runs[0].startedAt !== null, 'ComfyUI to begin the prompt');

    const started = Date.parse(runner.get(a.id).runs[0].startedAt);
    // The stamp is when the run began: not at submit (which would bill it for
    // the queue's wait) and not in the future either.
    assert.equal(started >= handedOverAt - 1500, true, 'not stamped before the run began');
    assert.equal(started <= Date.now() + 500, true, 'and not after it');

    // The queue submits one run at a time, so run 2 only reaches ComfyUI once run
    // 1 is finished - and its prompt then needs finishing too.
    const finisher = setInterval(() => {
      if (comfy.state.pending.size) comfy.completeAll();
    }, 100);
    comfy.completeAll();
    try {
      await waitFor(() => runner.get(a.id).status === 'done', 'the job to finish');
    } finally {
      clearInterval(finisher);
    }
    for (const r of runner.get(a.id).runs) {
      assert.equal(r.startedAt !== null, true, `run ${r.index + 1} has a start`);
      assert.equal(r.endedAt !== null, true, `run ${r.index + 1} has an end`);
      assert.equal(Date.parse(r.endedAt) >= Date.parse(r.startedAt), true, 'and the end is never before the start');
    }
  } finally {
    cleanup();
    await comfy.close();
    dropRoot(root);
  }
});

test('a prompt cleared out of the queue never grows a timer, because it never generated', async () => {
  const comfy = await startFakeComfyUI({ mode: 'manual', holdStart: true });
  const root = useTempRoot(comfy.port);
  try {
    const a = runner.enqueue(JOB('lost prompt', 1));
    await waitFor(() => comfy.state.prompts.length === 1, 'the prompt to be handed over');

    // Somebody clears ComfyUI's queue up there: the prompt is in neither list and
    // has no history, which is what a lost prompt looks like.
    await fetch(`http://127.0.0.1:${comfy.port}/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delete: [comfy.ids()[0]] }),
    });

    await waitFor(() => runner.get(a.id).status === 'error', 'the run to be told the prompt is gone');
    assert.equal(runner.get(a.id).runs[0].startedAt, null, 'it never ran, so it has no generating time');
  } finally {
    cleanup();
    await comfy.close();
    dropRoot(root);
  }
});

test('a pinned seed reaches every run of the job, and the history row', async () => {
  const comfy = await startFakeComfyUI({ mode: 'manual' });
  const root = useTempRoot(comfy.port);
  try {
    const a = runner.enqueue({ ...JOB('pinned seed', 3), seed: '1234567' });
    await waitFor(() => comfy.state.prompts.length === 1, 'the first prompt to be handed over');

    // The recorded seed is the one in the payload, not a second roll.
    assert.equal(runner.get(a.id).runs[0].seed, 1234567);
    assert.equal(comfy.state.prompts[0].payload['37'].inputs.seed, 1234567);

    const finisher = setInterval(() => {
      if (comfy.state.pending.size) comfy.completeAll();
    }, 100);
    comfy.completeAll();
    try {
      await waitFor(() => runner.get(a.id).status === 'done', 'the job to finish');
    } finally {
      clearInterval(finisher);
    }

    // Every run of a pinned job uses the same seed - which is why the page warns
    // about it when a batch or a shuffle is more than one.
    assert.deepEqual(runner.get(a.id).runs.map((r) => r.seed), [1234567, 1234567, 1234567]);
    assert.deepEqual(comfy.state.prompts.map((p) => p.payload['37'].inputs.seed), [1234567, 1234567, 1234567]);

    // The history row keeps the seed so the tab can list and copy it.
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'data', 'history.json'), 'utf8'));
    const row = saved.entries.find((e) => e.jobId === a.id);
    assert.deepEqual(row.seeds, [1234567, 1234567, 1234567]);
    assert.equal(row.settings.seed, 1234567, 'and the pinned value comes back with the prompt');
  } finally {
    cleanup();
    await comfy.close();
    dropRoot(root);
  }
});

test('a job without a seed still rolls a fresh one per run', async () => {
  const comfy = await startFakeComfyUI({ mode: 'manual' });
  const root = useTempRoot(comfy.port);
  try {
    const a = runner.enqueue(JOB('random seed', 2));
    await waitFor(() => comfy.state.prompts.length === 1, 'the first prompt');
    assert.equal(runner.get(a.id).runs[0].seed !== null, true);

    const finisher = setInterval(() => {
      if (comfy.state.pending.size) comfy.completeAll();
    }, 100);
    comfy.completeAll();
    try {
      await waitFor(() => runner.get(a.id).status === 'done', 'the job to finish');
    } finally {
      clearInterval(finisher);
    }
    const seeds = runner.get(a.id).runs.map((r) => r.seed);
    assert.equal(seeds.every((s) => Number.isInteger(s)), true);
    assert.notEqual(seeds[0], seeds[1], 'two runs of an unpinned job must not share a seed');

    // An unpinned job does not pretend it pinned anything.
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'data', 'history.json'), 'utf8'));
    const row = saved.entries.find((e) => e.jobId === a.id);
    assert.equal(row.settings.seed, null);
  } finally {
    cleanup();
    await comfy.close();
    dropRoot(root);
  }
});

test('an upscale job runs on the shared queue and its output lands in the gallery', async () => {
  // The upscale graph saves from 508 and has no text node, so the fake is told
  // which node to answer on - otherwise "the image arrived" would prove nothing
  // about which graph ran.
  const comfy = await startFakeComfyUI({ mode: 'manual', saveNode: 508, textNode: null });
  const root = useTempRoot(comfy.port);
  try {
    const up = runner.enqueue(UPSCALE(2, { seed: '4242' }));
    const gen = runner.enqueue(JOB('a generate behind the upscale', 1));

    assert.equal(up.kind, 'upscale', 'the snapshot says which kind of job this is');
    assert.match(up.spec.prompt, /^upscale \S+ ×2$/);

    await waitFor(() => comfy.state.prompts.length === 1, 'the upscale prompt');
    assert.equal(runner.get(up.id).status, 'running');
    assert.equal(runner.get(gen.id).status, 'queued', 'the two tabs share one queue');

    // The picture went to ComfyUI's input dir and its own name came back into
    // LoadImage - a generated image lives in the output dir and LoadImage cannot
    // see it, so this hop is the whole reason reuse-from-gallery works.
    const wf = comfy.state.prompts[0].payload;
    assert.equal(wf['538'].inputs.image, comfy.state.uploads[0]);
    assert.equal(wf['517'].inputs.value, 2);
    assert.equal(wf['536'].inputs.seed, 4242);
    assert.equal(wf['526'].inputs.value, false);
    assert.equal(wf['530'].inputs.switch, false);
    assert.equal(wf['544'].inputs.value, '', 'blank guidance leaves the node\'s own text in place');

    const stop = autoFinish(comfy);
    try {
      await waitFor(() => runner.get(up.id).status === 'done', 'the upscale to finish');
      await waitFor(() => runner.get(gen.id).status === 'done', 'the generate behind it to finish');
    } finally {
      stop();
    }

    // It arrived as a normal gallery entry, tagged with the kind that made it.
    const entries = gallery.listEntries({ jobId: up.id });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, 'upscale');
    assert.equal(entries[0].localPath !== null, true, 'and it was downloaded');

    const saved = JSON.parse(fs.readFileSync(path.join(root, 'data', 'history.json'), 'utf8'));
    const row = saved.entries.find((e) => e.jobId === up.id);
    assert.equal(row.settings.kind, 'upscale');
    assert.equal(row.settings.scale, 2);
    assert.deepEqual(row.seeds, [4242]);
  } finally {
    cleanup();
    await comfy.close();
    dropRoot(root);
  }
});

test('scale to a target size carries the width and height into both switches', async () => {
  const comfy = await startFakeComfyUI({ mode: 'manual', saveNode: 508, textNode: null });
  const root = useTempRoot(comfy.port);
  try {
    // A generate job first, so this also proves the upscale can queue BEHIND the
    // other tab - the shared queue is FIFO, not "generates first".
    const gen = runner.enqueue(JOB('generate first this time', 1));
    const up = runner.enqueue(UPSCALE(2, { scaleToDim: true, targetWidth: '3000', targetHeight: '2000', guidance: 'keep the grain' }));

    await waitFor(() => comfy.state.prompts.length === 1, 'the generate prompt');
    assert.equal(runner.get(up.id).status, 'queued', 'the upscale waits its turn');

    const stop = autoFinish(comfy);
    try {
      await waitFor(() => comfy.state.prompts.length === 2, 'the upscale prompt');
      await waitFor(() => runner.get(up.id).status === 'done', 'the upscale to finish');
    } finally {
      stop();
    }

    const wf = comfy.state.prompts[1].payload;
    assert.equal(wf['528'].inputs.value, 3000);
    assert.equal(wf['529'].inputs.value, 2000);
    // 530 is hard-wired to `false` in the exported graph while 527 follows 526.
    // Writing only 526 would give the upscaler a target width and a plain xscale
    // height, i.e. a stretched picture the user never asked for.
    assert.equal(wf['526'].inputs.value, true);
    assert.equal(wf['530'].inputs.switch, true);
    // Guidance is concatenated AFTER the graph's own instruction, so it adds to
    // it rather than replacing it.
    assert.equal(wf['544'].inputs.value, 'keep the grain');
    assert.equal(wf['522'].inputs.value.includes('Enhance this image'), true, 'the base prompt is left alone');
  } finally {
    cleanup();
    await comfy.close();
    dropRoot(root);
  }
});

test('a postprompt reaches node 256 and comes back in the saved history row', async () => {
  const comfy = await startFakeComfyUI({ mode: 'manual' });
  const root = useTempRoot(comfy.port);
  const stop = autoFinish(comfy);
  try {
    // Enhanced path. The prompt goes to node 41 (the enhance toggle sends it
    // there) and the postprompt still lands in 256, because node 257 hangs the
    // postprompt off the branch OUTPUT - it is applied whatever the branch did.
    const job = runner.enqueue({ ...JOB('a cat in a kitchen', 1), postprompt: '\n\nin the style of a pencil sketch' });
    await waitFor(() => comfy.state.prompts.length === 1, 'the prompt to reach ComfyUI');
    const wf = comfy.state.prompts[0].payload;
    assert.equal(wf['256'].inputs.value, '\n\nin the style of a pencil sketch', 'written verbatim');
    assert.equal(wf['41'].inputs.value, 'a cat in a kitchen');
    assert.equal(wf['44'].inputs.value, WORKFLOW_RAW_DEFAULT, 'the editor\'s own raw text is untouched');

    // Raw path: same postprompt, and it is still on the wire.
    const raw = runner.enqueue({
      ...JOB('a dog in a park', 1),
      promptEnhance: false,
      postprompt: 'at golden hour',
    });
    await waitFor(() => comfy.state.prompts.length === 2, 'the raw prompt');
    assert.equal(comfy.state.prompts[1].payload['44'].inputs.value, 'a dog in a park');
    assert.equal(comfy.state.prompts[1].payload['256'].inputs.value, 'at golden hour');
    assert.equal(comfy.state.prompts[1].payload['176'].inputs.cond, false, 'the branch really is on raw');

    // No postprompt at all leaves the editor's own node 256 text alone rather
    // than blanking it.
    const plain = runner.enqueue(JOB('no postprompt here', 1));
    await waitFor(() => comfy.state.prompts.length === 3, 'the third prompt');
    assert.equal(comfy.state.prompts[2].payload['256'].inputs.value, WORKFLOW_POSTPROMPT_DEFAULT);

    await waitFor(() => runner.get(job.id).status === 'done', 'the first run to finish');
    await waitFor(() => runner.get(raw.id).status === 'done', 'the raw run to finish');
    await waitFor(() => runner.get(plain.id).status === 'done', 'the plain run to finish');

    // The row has to be able to put the box back, so the text is recorded even
    // though the captured prompt already ends up containing it.
    const rows = JSON.parse(fs.readFileSync(path.join(root, 'data', 'history.json'), 'utf8')).entries;
    const row = rows.find((r) => r.jobId === job.id);
    assert.equal(row.settings.postprompt, '\n\nin the style of a pencil sketch');
    assert.equal(rows.find((r) => r.jobId === plain.id).settings.postprompt, '');
  } finally {
    stop();
    cleanup();
    await comfy.close();
    dropRoot(root);
  }
});

test('an upscale with no image is refused before anything is queued', () => {
  const root = useTempRoot(8188);
  try {
    const before = runner.list().length;
    assert.throws(
      () => runner.enqueue({ kind: 'upscale', slots: [], scale: 2 }),
      (e) => {
        assert.equal(e.status, 400);
        assert.match(e.message, /image to upscale is required/);
        return true;
      },
    );
    assert.equal(runner.list().length, before, 'nothing reached the queue');
  } finally {
    cleanup();
    dropRoot(root);
  }
});

test("ComfyUI's own work holds a new job instead of queueing behind it", async () => {
  // Another device on the same ComfyUI is mid-generation. That prompt is
  // invisible from here until somebody looks at /queue.
  const comfy = await startFakeComfyUI({ mode: 'manual' });
  const root = useTempRoot(comfy.port);
  try {
    comfy.foreign(1);
    const a = runner.enqueue(JOB('should wait its turn', 2));

    const q = await waitFor(() => (runner.queueState().paused ? runner.queueState() : null), 'the hold');
    assert.equal(q.reason, 'busy');
    assert.match(q.message, /busy with a prompt this app did not send/);
    assert.match(q.message, /another device/);
    assert.equal(q.waiting, 1, 'the held job is kept at the front of the queue');

    const snap = runner.get(a.id);
    assert.equal(snap.status, 'paused');
    assert.equal(snap.finishedAt, null, 'a held job has not finished');
    // The whole point of holding rather than submitting: nothing of ours reached
    // ComfyUI, no seed was burnt and no prompt id exists to chase later.
    assert.equal(comfy.state.prompts.length, 0);
    assert.equal(snap.runs.every((r) => r.promptId === null && r.seed === null), true);
    assert.match(snap.error, /busy/i);

    // ...and it starts by itself when that work ends. Nobody has to watch, and
    // nobody has to tap resume.
    comfy.clearForeign();
    const stop = autoFinish(comfy);
    await waitFor(() => runner.get(a.id).status === 'done', 'the held job to carry on by itself', 25000);
    stop();

    assert.equal(comfy.state.prompts.length, 2, 'both runs went once the queue was free');
    assert.equal(runner.queueState().paused, false);
  } finally {
    cleanup();
    await comfy.close();
    dropRoot(root);
  }
});

test('send all is the way past a hold for ComfyUI\'s own queue', async () => {
  const comfy = await startFakeComfyUI({ mode: 'manual' });
  const root = useTempRoot(comfy.port);
  try {
    comfy.foreign(2);
    const a = runner.enqueue(JOB('held anyway', 1));
    const b = runner.enqueue(JOB('behind it', 1));
    await waitFor(() => runner.queueState().paused, 'the hold');
    assert.equal(runner.get(a.id).status, 'paused');
    assert.equal(runner.get(b.id).status, 'queued');

    const report = await runner.submitAll();
    assert.equal(report.runs, 2, 'both jobs were handed over');
    assert.deepEqual(report.failures, []);
    assert.equal(
      runner.queueState().paused,
      false,
      'the hold is gone: the work is already in ComfyUI, which is all the hold wanted',
    );

    // Ours went behind the other device's work, which is the whole bargain.
    const q = await new ComfyClient().queueBusy();
    assert.deepEqual(q.ids.slice(0, 2), comfy.foreignIds(), 'the other device still goes first');
    assert.equal(q.ids.length, 4);

    const stop = autoFinish(comfy);
    await waitFor(() => runner.get(a.id).status === 'done', 'A to finish', 25000);
    await waitFor(() => runner.get(b.id).status === 'done', 'B to finish', 25000);
    stop();
    assert.equal(comfy.state.prompts.length, 2, 'each job was submitted exactly once');
  } finally {
    cleanup();
    await comfy.close();
    dropRoot(root);
  }
});

test("the app's own prompts in ComfyUI's queue never hold the queue behind itself", async () => {
  // The deadlock this check could have caused: a bulk submit leaves our prompts
  // sitting in ComfyUI, and the next job would read them as somebody else's work
  // and wait for a queue only we can empty.
  const comfy = await startFakeComfyUI({ mode: 'manual' });
  const root = useTempRoot(comfy.port);
  try {
    const a = runner.enqueue(JOB('first', 2));
    const b = runner.enqueue(JOB('second', 1));
    await waitFor(() => comfy.state.prompts.length === 1, "A's first run");
    await runner.submitAll();
    assert.equal(runner.queueState().paused, false, 'our own queue is not foreign work');

    const stop = autoFinish(comfy);
    await waitFor(() => runner.get(a.id).status === 'done', 'A to finish', 25000);
    await waitFor(() => runner.get(b.id).status === 'done', 'B to finish', 25000);
    stop();
    assert.equal(comfy.state.prompts.length, 3, '3 runs, each submitted exactly once');
  } finally {
    cleanup();
    await comfy.close();
    dropRoot(root);
  }
});

test('a queue probe that fails is not read as a busy queue', async () => {
  // A ComfyUI that answers /prompt and /history but not /queue. "Cannot tell" is
  // not "busy": holding on a failed read would strand the phone over a blip.
  const comfy = await startFakeComfyUI({ mode: 'instant' });
  const root = useTempRoot(comfy.port);
  try {
    comfy.state.queueFail = true;
    const a = runner.enqueue(JOB('unreadable queue', 1));
    await waitFor(() => runner.get(a.id).status === 'done', 'the job to run anyway', 25000);
    assert.equal(comfy.state.prompts.length, 1);
    assert.equal(runner.queueState().paused, false);
  } finally {
    comfy.state.queueFail = false;
    cleanup();
    await comfy.close();
    dropRoot(root);
  }
});
