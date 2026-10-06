import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { init, saveConfig, paths } from '../lib/config.js';
import { Runner } from '../lib/runner.js';
import * as queuedb from '../lib/queuedb.js';
import { startFakeComfyUI, sleep, waitFor, dropRoot } from './helpers/fakeComfy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A throwaway root, and a factory for runners of its own.
 *
 * `new Runner()` rather than the singleton, on purpose: these tests are ABOUT a
 * process boundary, and the point is that the second runner knows nothing the
 * first one did except what is on disk. Sharing the singleton would hide exactly
 * the bug they exist to catch.
 *
 * Every runner made here is registered, because each one arms an UNREF'd 300ms
 * save timer. A test that drops its root while such a timer is still pending
 * lets it fire during some *other* test - and by then it would resolve the
 * current root's queue.json and unlink it. `dropAll` is the answer to that.
 */
function useRoot(comfyPort = 1, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-cfy-persist-'));
  init(root);
  saveConfig({
    comfy: { host: '127.0.0.1', port: comfyPort, timeoutMs: 5000 },
    // Absolute, so the temp root needs no copy of the workflows.
    workflowFile: path.join(ROOT, 'workflow_api.json'),
    upscaleWorkflowFile: path.join(ROOT, 'upscale_api.json'),
    downloadDir: path.join(root, 'downloads'),
    dataDir: path.join(root, 'data'),
    promptTextNodes: ['181'],
    ...extra,
  });
  queuedb.resetWriteCache();
  const runners = [];
  let first = null;
  return {
    root,
    file: queuedb.queueFile(),
    /**
     * `box.runner` twice is the SAME runner - memoised, because three
     * independent runners would happily pass a test that a queue is being
     * saved at all.
     */
    get runner() {
      if (!first) {
        first = new Runner();
        runners.push(first);
      }
      return first;
    },
    /** A second process: knows only what is on disk. */
    reboot() {
      const r = new Runner();
      runners.push(r);
      return r;
    },
    async dropAll() {
      for (const r of runners) {
        r.cancel(...r.list().map((j) => j.id));
        r.flushNow();
      }
      // Give anything already scheduled the chance to fire while this root is
      // still the current one, so it can only ever touch its own file.
      await sleep(60);
      dropRoot(root);
    },
  };
}

function useRunner(comfyPort = 1, extra = {}) {
  const box = useRoot(comfyPort, extra);
  box.runner; // materialise the first one up front
  return box;
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

const readJobs = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null);

test('a queued job is on disk before it has started', async (t) => {
  const box = useRunner();
  t.after(() => box.dropAll());

  // Paused, so nothing is submitted and nothing touches the network: this is
  // the state a job is in while it waits behind two others, which is exactly the
  // state a restart used to destroy.
  box.runner.pause('manual');
  box.runner.enqueue(JOB('a lighthouse in a storm'));
  box.runner.flushNow();

  const saved = readJobs(box.file);
  assert.ok(saved, 'queue.json exists while a job is waiting');
  assert.equal(saved.version, queuedb.QUEUE_FILE_VERSION);
  assert.equal(saved.jobs.length, 1);
  const rec = saved.jobs[0];
  assert.equal(rec.position, 'waiting');
  assert.equal(rec.spec.prompt, 'a lighthouse in a storm');
  assert.equal(rec.spec.kind, 'generate', 'the record says what it is, rather than leaving it to be guessed');
  assert.equal(rec.runs.length, 1);
  assert.equal(rec.runs[0].status, 'pending');
  assert.equal(rec.runs[0].promptId, null);
});

test('the waiting list is written in the order it will run', async (t) => {
  const box = useRunner();
  t.after(() => box.dropAll());

  box.runner.pause('manual');
  for (const p of ['first', 'second', 'third']) box.runner.enqueue(JOB(p));
  box.runner.flushNow();

  const body = JSON.parse(fs.readFileSync(box.file, 'utf8'));
  assert.deepEqual(body.jobs.map((j) => j.spec.prompt), ['first', 'second', 'third']);
  assert.deepEqual(body.jobs.map((j) => j.position), ['waiting', 'waiting', 'waiting']);
});

test('a restart brings every job back, and the one that was running comes back first', async (t) => {
  const box = useRoot();
  t.after(() => box.dropAll());

  const first = box.runner;
  first.pause('manual');
  for (const p of ['alpha', 'beta', 'gamma']) first.enqueue(JOB(p));
  first.flushNow();
  // Mark the first as the job that was running when the lights went out.
  const body = JSON.parse(fs.readFileSync(box.file, 'utf8'));
  body.jobs[0].position = 'active';
  fs.writeFileSync(box.file, JSON.stringify(body, null, 2));
  queuedb.resetWriteCache();

  const second = box.reboot();
  second.pause('manual');
  const found = second.restore();

  assert.ok(found, 'restore() reported what it found');
  assert.equal(found.jobs, 3);
  assert.equal(found.running, 1);
  const list = second.list();
  assert.deepEqual(list.map((j) => j.spec.prompt), ['alpha', 'beta', 'gamma']);
  assert.deepEqual(list.map((j) => j.queuePosition), [1, 2, 3]);
  assert.equal(second.queueState().waiting, 3);
  assert.equal(second.queueState().restored.at, body.savedAt);
});

test('a restored job starts by itself - the pump takes it, no help needed', async (t) => {
  const comfy = await startFakeComfyUI();
  const box = useRunner(comfy.port);
  t.after(async () => {
    await comfy.close();
    await box.dropAll();
  });

  box.runner.pause('manual');
  box.runner.enqueue(JOB('starts by itself'));
  box.runner.flushNow();
  queuedb.resetWriteCache();

  // A second process, not paused this time - the real boot path.
  const second = box.reboot();
  second.restore();
  await waitFor(() => second.list()[0]?.status === 'done', 'the restored job to finish', 20000);
  assert.equal(comfy.state.prompts.length, 1, 'submitted exactly once');
  assert.ok(Number.isInteger(second.list()[0].runs[0].seed), 'a seed was rolled for it');
  await waitFor(() => !fs.existsSync(box.file), 'queue.json to be removed once nothing was left', 5000);
});

test('restoring does not write a second history row', async (t) => {
  const box = useRoot();
  t.after(() => box.dropAll());

  const first = box.runner;
  first.pause('manual');
  const job = first.enqueue(JOB('remembered exactly once'));
  first.flushNow();
  const historyFile = path.join(paths().dataDir, 'history.json');
  const before = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
  assert.equal(before.entries.length, 1);
  assert.equal(before.entries[0].jobId, job.id);

  const second = box.reboot();
  second.pause('manual');
  assert.equal(second.restore().jobs, 1);

  // record() already ran when the job was first queued, and finish() finds the
  // row by jobId. A second record here would show the user the same prompt
  // twice, as though they had run it twice.
  const after = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
  assert.equal(after.entries.length, 1, 'no duplicate history row');
  assert.equal(after.entries[0].jobId, job.id);
});

test('a job that had already finished when the crash happened is not run again', async (t) => {
  const comfy = await startFakeComfyUI();
  const box = useRunner(comfy.port);
  t.after(async () => {
    await comfy.close();
    await box.dropAll();
  });

  box.runner.pause('manual');
  box.runner.enqueue(JOB('finished before the crash'));
  box.runner.flushNow();
  const body = JSON.parse(fs.readFileSync(box.file, 'utf8'));
  body.jobs[0].runs[0].status = 'done';
  body.jobs[0].runs[0].seed = 999;
  fs.writeFileSync(box.file, JSON.stringify(body, null, 2));
  queuedb.resetWriteCache();

  const second = box.reboot();
  second.restore();
  await waitFor(() => second.list()[0]?.status === 'done', 'the restored job to settle', 20000);
  // It finished before, so there is nothing to submit: the images it produced
  // are already in the gallery, and a second pass would burn a seed and a
  // minute of somebody's GPU to make copies of images that already exist.
  assert.equal(comfy.state.prompts.length, 0);
  assert.equal(second.list()[0].runs[0].seed, 999, 'and it kept the seed it used');
});

test('a restored run comes back with every field the runner reads', () => {
  // A run record with only a promptId and a seed - the minimum - must not leave
  // a hole anywhere the UI or the run loop would read `undefined`.
  const run = queuedb.runFromRecord({ index: 0, promptId: 'p-1', seed: 42 }, 0);
  assert.equal(run.index, 0);
  assert.equal(run.group, 0);
  assert.equal(run.indexInGroup, 0);
  assert.equal(run.isFirstOfGroup, false);
  assert.equal(run.refreshOverride, false);
  assert.equal(run.seed, 42);
  assert.equal(run.status, 'pending');
  assert.equal(run.promptId, 'p-1');
  assert.equal(run.startedAt, null);
  assert.equal(run.endedAt, null);
  assert.equal(run.error, null);
  assert.equal(run.promptText, null);
  assert.deepEqual(run.images, []);
  assert.deepEqual(run.outputs, []);
  assert.equal(run.progress, 0);
  assert.equal(run.node, null);
  assert.equal(run.queue, null);
  assert.equal(run.ahead, null);
  assert.equal(run.wsFailed, false);
  assert.equal(run.resumedFromDisk, true);
  // A seed that is not a whole number is dropped rather than written back as NaN.
  assert.equal(queuedb.runFromRecord({ seed: -1 }, 0).seed, null);
});

test('volatile fields are not written, so a running job does not rewrite the file per tick', () => {
  const rec = queuedb.toRecord(
    {
      id: 'x',
      createdAt: new Date().toISOString(),
      spec: { prompt: 'p', kind: 'generate', slots: [] },
      runs: [{
        index: 0, group: 0, indexInGroup: 0, isFirstOfGroup: true, refreshOverride: true,
        seed: 1, status: 'running', promptId: 'p1', startedAt: 'x', endedAt: null,
        error: null, promptText: null, promptTextNode: null, promptTextFile: null,
        images: [], progress: 61, node: '519', queue: 1, ahead: 2, wsFailed: true,
        outputs: [{ filename: 'a.png' }],
      }],
    },
    'active',
  );
  for (const gone of ['progress', 'node', 'queue', 'ahead', 'wsFailed', 'outputs']) {
    assert.equal(gone in rec.runs[0], false, `${gone} must not be saved`);
  }
  // ...while the identity of the run is all still there.
  assert.equal(rec.runs[0].promptId, 'p1');
  assert.equal(rec.runs[0].seed, 1);
  assert.equal(rec.position, 'active');
});

test('an empty queue leaves no file at all', async (t) => {
  const box = useRunner();
  t.after(() => box.dropAll());

  box.runner.pause('manual');
  const job = box.runner.enqueue(JOB('transient'));
  box.runner.flushNow();
  assert.ok(fs.existsSync(box.file), 'written while something waits');
  box.runner.cancel(job.id);
  box.runner.flushNow();
  assert.equal(fs.existsSync(box.file), false, 'gone once the queue is empty');
});

test('a corrupt queue file starts an empty queue instead of stopping the server', async (t) => {
  const box = useRunner();
  t.after(() => box.dropAll());

  fs.mkdirSync(path.dirname(box.file), { recursive: true });
  fs.writeFileSync(box.file, '{ "version": 1, "jobs": [ { "id": ', 'utf8');
  assert.equal(box.runner.restore(), null);
  assert.equal(box.runner.list().length, 0);
});

test('a queue file from a newer build is left alone', async (t) => {
  const box = useRunner();
  t.after(() => box.dropAll());

  fs.mkdirSync(path.dirname(box.file), { recursive: true });
  fs.writeFileSync(
    box.file,
    JSON.stringify({ version: queuedb.QUEUE_FILE_VERSION + 1, jobs: [{ id: 'x', spec: {}, runs: [{}] }] }),
    'utf8',
  );
  assert.equal(box.runner.restore(), null);
  assert.equal(box.runner.list().length, 0);
});

test('a hand-edited half record boots into an honestly pending run', async (t) => {
  const box = useRunner();
  t.after(() => box.dropAll());

  fs.mkdirSync(path.dirname(box.file), { recursive: true });
  fs.writeFileSync(
    box.file,
    JSON.stringify({
      version: queuedb.QUEUE_FILE_VERSION,
      savedAt: new Date().toISOString(),
      jobs: [
        { id: 'hand-written', spec: { prompt: 'edited by hand' }, runs: [{ index: 0 }] },
        // No id, no spec, no runs - all of it unusable.
        { spec: {}, runs: [] },
      ],
    }),
    'utf8',
  );
  box.runner.pause('manual');
  const found = box.runner.restore();
  assert.equal(found.jobs, 1, 'the one readable record survives, the other is skipped');
  const job = box.runner.list()[0];
  assert.equal(job.spec.prompt, 'edited by hand');
  assert.equal(job.spec.kind, 'generate');
  assert.deepEqual(job.spec.slots, []);
  assert.equal(job.runs.length, 1);
  assert.equal(job.runs[0].status, 'pending');
  assert.equal(job.runs[0].seed, null);
  assert.equal(job.status, 'queued');
});

test('the cap keeps the newest and says how many it dropped', () => {
  const recs = Array.from({ length: 7 }, (_, i) => ({ id: `j${i}` }));
  assert.deepEqual(queuedb.trimSaved(recs, 10), { kept: recs, dropped: 0 });
  const capped = queuedb.trimSaved(recs, 5);
  assert.equal(capped.dropped, 2);
  // The NEWEST survive: a cap must not quietly throw away the job the user
  // queued a second ago.
  assert.deepEqual(capped.kept.map((r) => r.id), ['j2', 'j3', 'j4', 'j5', 'j6']);
  assert.equal(queuedb.MAX_SAVED_JOBS, 100);
});

test('the save is atomic: no .tmp is left behind, and the file is whole', async (t) => {
  const box = useRoot();
  t.after(() => box.dropAll());

  const job = {
    id: 'atomic',
    createdAt: new Date().toISOString(),
    spec: { prompt: 'atomic', kind: 'generate', slots: [] },
    runs: [{
      index: 0, group: 0, indexInGroup: 0, isFirstOfGroup: true, refreshOverride: false,
      seed: null, status: 'pending', promptId: null, startedAt: null, endedAt: null,
      error: null, images: [],
    }],
  };
  const out = await queuedb.writeQueue([queuedb.toRecord(job, 'waiting')]);
  assert.equal(out.written, true);
  assert.equal(out.error, null);
  assert.equal(fs.existsSync(`${box.file}.tmp`), false);
  const body = readJobs(box.file);
  assert.equal(body.jobs.length, 1);
  assert.equal(body.jobs[0].id, 'atomic');
  assert.ok(Date.parse(body.savedAt) > 0, 'savedAt is a real timestamp');
});

test('two writes racing cannot leave a half-written file', async (t) => {
  const box = useRoot();
  t.after(() => box.dropAll());

  const base = queuedb.toRecord(
    { id: 'one', createdAt: '2026-01-01T00:00:00.000Z', spec: { prompt: 'one' }, runs: [{ index: 0 }] },
    'waiting',
  );
  const other = { ...base, id: 'other', spec: { ...base.spec, prompt: 'two' } };
  await Promise.all([queuedb.writeQueue([base]), queuedb.writeQueue([other]), queuedb.writeQueue([base])]);
  const body = readJobs(box.file);
  assert.ok(body, 'the file parses');
  assert.equal(body.jobs.length, 1);
  assert.equal(fs.existsSync(`${box.file}.tmp`), false);
});

test('the queue is saved the moment it is created, not only when a run ends', async (t) => {
  const box = useRunner();
  t.after(() => box.dropAll());

  box.runner.pause('manual');
  box.runner.enqueue(JOB('immediately'));
  // No flushNow: the debounced write is what a real server relies on.
  await waitFor(() => fs.existsSync(box.file), 'queue.json to appear', 5000);
  await sleep(60);
  assert.equal(readJobs(box.file).jobs.length, 1);
});

test('a save that fails is reported, not thrown', async (t) => {
  const box = useRoot();
  // Point the data dir at a path that cannot be created: a file where a
  // directory should be. The queue must survive being unable to save itself.
  fs.writeFileSync(path.join(box.root, 'blocked'), 'not a directory', 'utf8');
  saveConfig({ dataDir: path.join(box.root, 'blocked', 'data') });
  t.after(() => box.dropAll());

  box.runner.pause('manual');
  box.runner.enqueue(JOB('cannot be saved'));
  box.runner.flushNow(); // must not throw
  const out = await queuedb.writeQueue([{ id: 'x' }]);
  assert.equal(out.written, false);
  assert.ok(out.error, 'the reason is handed back to the runner, which shows it');
});

test('an upscale job comes back as an upscale job', async (t) => {
  const box = useRoot();
  t.after(() => box.dropAll());

  const first = box.runner;
  first.pause('manual');
  first.enqueue({ kind: 'upscale', slots: [{ uploadId: 'u1' }], scale: 2, collectImages: true });
  first.flushNow();
  queuedb.resetWriteCache();

  const second = box.reboot();
  second.pause('manual');
  second.restore();
  const job = second.list()[0];
  assert.equal(job.kind, 'upscale');
  assert.equal(job.spec.kind, 'upscale');
  assert.equal(job.spec.scale, 2);
  assert.equal(job.runs.length, 1);
});

/**
 * A job that was mid-run when the phone died, written straight into queue.json.
 * This is the case the whole feature exists for, and the one with a real
 * question in it: ComfyUI may have restarted too.
 */
function writeInterruptedJob(file, promptId) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: queuedb.QUEUE_FILE_VERSION,
      savedAt: new Date().toISOString(),
      jobs: [queuedb.toRecord({
        id: 'interrupted',
        createdAt: new Date().toISOString(),
        spec: { prompt: 'vanished prompt', kind: 'generate', slots: [], seed: 5 },
        runs: [{
          index: 0, group: 0, indexInGroup: 0, isFirstOfGroup: true, refreshOverride: true,
          seed: 5, status: 'running', promptId, startedAt: new Date().toISOString(),
          endedAt: null, error: null, images: [], promptText: null,
        }],
      }, 'active')],
    }),
    'utf8',
  );
  queuedb.resetWriteCache();
}

test('a prompt ComfyUI has forgotten fails honestly instead of hanging', async (t) => {
  const comfy = await startFakeComfyUI();
  const box = useRunner(comfy.port);
  t.after(async () => {
    await comfy.close();
    await box.dropAll();
  });

  writeInterruptedJob(box.file, 'gone-forever');
  const runner = box.reboot();
  runner.restore();

  await waitFor(() => ['done', 'error'].includes(runner.list()[0]?.status), 'the job to stop being unfinished', 20000);
  const done = runner.list()[0];
  assert.equal(done.runs[0].status, 'error');
  assert.match(done.runs[0].error, /no record of it any more/);
  assert.equal(done.spec.seed, 5, 'the pinned seed survived the restart');
  assert.equal(comfy.state.prompts.length, 0, 'nothing was submitted to a ComfyUI that forgot it');
});

test('a prompt ComfyUI still has is re-attached, not submitted twice', async (t) => {
  const comfy = await startFakeComfyUI();
  const box = useRunner(comfy.port);
  t.after(async () => {
    await comfy.close();
    await box.dropAll();
  });

  // The same shape, but this time ComfyUI is still chewing on the prompt.
  const submitted = await fetch(`http://127.0.0.1:${comfy.port}/prompt`, {
    method: 'POST',
    body: JSON.stringify({ prompt: '1' }),
  });
  const { prompt_id: promptId } = await submitted.json();
  writeInterruptedJob(box.file, promptId);
  const runner = box.reboot();
  runner.restore();

  await waitFor(() => runner.list()[0]?.runs[0]?.promptId === promptId, 'the run to keep its prompt id', 10000);
  assert.equal(comfy.state.prompts.length, 1, 'the prompt was not sent a second time');
  assert.equal(runner.list()[0].runs[0].status, 'running');

  // And it is watched to the end like any other run.
  comfy.completeAll();
  await waitFor(() => runner.list()[0]?.status === 'done', 'the re-attached run to finish', 20000);
});