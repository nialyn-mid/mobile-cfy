import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { init, saveConfig, paths } from '../lib/config.js';
import { addEntry, findEntry, missingDownloads, updateEntry } from '../lib/gallery.js';
import { sweep, pending, MAX_ATTEMPTS, MAX_AGE_MS, RETRY_DELAYS_MS } from '../lib/retry.js';
import { ComfyClient } from '../lib/comfy.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * A ComfyUI that only serves /view, and only as often as we tell it to. `view`
 * mode decides what a fetch gets back:
 *   ok      - the image
 *   error   - HTTP 500 (a fluke worth retrying)
 *   gone    - HTTP 404 (a definite answer)
 *   down    - the socket is not there at all (a network blip)
 */
function startFake({ view = 'ok' } = {}) {
  const state = { view, served: 0 };
  let mode = view;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/view') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end('{}');
    }
    state.served += 1;
    if (mode === 'gone') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end('{"error":"not found"}');
    }
    if (mode === 'error') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end('{"error":"boom"}');
    }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PNG.length });
    res.end(PNG);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      state,
      setView: (m) => { mode = m; },
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

function useTempRoot(port) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-cfy-retry-'));
  init(root);
  saveConfig({
    comfy: { host: '127.0.0.1', port, timeoutMs: 5000 },
    workflowFile: path.join(root, 'wf.json'),
    downloadDir: path.join(root, 'downloads'),
    dataDir: path.join(root, 'data'),
  });
  fs.writeFileSync(path.join(root, 'wf.json'), '{}', 'utf8');
  return root;
}

// The suite runs on the phone as often as on a laptop, and the phone's temp dir
// is not somewhere a spare copy of every run's download folder should pile up.
const dropRoot = (root) => fs.rmSync(root, { recursive: true, force: true });

const clientFor = (fake) => new ComfyClient();

/** One gallery row as #collect would have written it after a failed download. */
function missingRow(over = {}) {
  return addEntry({
    jobId: 'job-1',
    runIndex: 0,
    group: 0,
    shuffle: 0,
    batch: 0,
    img: 0,
    node: 8,
    comfyFilename: 'ComfyUI_00001_.png',
    subfolder: '',
    type: 'output',
    prompt: 'a red bicycle',
    seed: 4242,
    localPath: null,
    localName: null,
    bytes: null,
    ...over,
  });
}

test('a recovered download writes the file and patches the entry', async () => {
  const fake = await startFake();
  const root = useTempRoot(fake.port);
  try {
    const row = missingRow();
    const report = await sweep({ client: clientFor(fake) });
    assert.equal(report.recovered, 1);

    const after = findEntry(row.id);
    assert.ok(after.localPath && fs.existsSync(after.localPath), 'the file is on disk now');
    assert.equal(after.bytes, PNG.length);
    assert.equal(after.retry, null);
    // The counters recorded at collect time reproduce the template exactly, so a
    // retry never invents a name and never makes a near-duplicate.
    assert.match(path.basename(after.localPath), /^\d{6}-\d{6}_s0b0i0\.png$/);
    // A row with a file is no longer outstanding.
    assert.equal(pending().length, 0);
  } finally {
    await fake.close();
    dropRoot(root);
  }
});

test('an image the user deleted is never fetched again', async () => {
  const fake = await startFake();
  const root = useTempRoot(fake.port);
  try {
    // A localPath means the download succeeded once. The file being gone from
    // disk now is the user's own housekeeping, and re-fetching it would undo it.
    const kept = addEntry({
      jobId: 'job-1', node: 8, comfyFilename: 'ComfyUI_00002_.png', prompt: 'kept', seed: 1,
      localPath: path.join(paths().downloadDir, 'deleted-by-the-user.png'),
      localName: 'deleted-by-the-user.png', bytes: 10,
    });
    assert.equal(fs.existsSync(kept.localPath), false, 'precondition: the file really is gone');
    assert.equal(missingDownloads().length, 0, 'a file that once existed is not a retry candidate');
    const report = await sweep({ client: clientFor(fake) });
    assert.equal(report.candidates, 0);
    assert.equal(fake.state.served, 0, 'ComfyUI was never even asked');
  } finally {
    await fake.close();
    dropRoot(root);
  }
});

test('two tries with a delay, then it gives up', async () => {
  const fake = await startFake({ view: 'error' });
  const root = useTempRoot(fake.port);
  try {
    const row = missingRow();
    // The download at collect time was attempt 1, so there are two left.
    const first = await sweep({ client: clientFor(fake) });
    assert.equal(first.failed, 1);
    assert.equal(findEntry(row.id).retry.attempts, 2);
    assert.ok(findEntry(row.id).retry.nextAttemptAt > Date.now(), 'the next try is scheduled, not immediate');

    // Not yet due: the delay is respected, so nothing is fetched and no attempt
    // is spent.
    const early = await sweep({ client: clientFor(fake), now: Date.now() + 1000 });
    assert.equal(early.skipped, 1);
    assert.equal(fake.state.served, 1);

    const second = await sweep({ client: clientFor(fake), force: true, now: Date.now() + RETRY_DELAYS_MS[0] + 5 });
    assert.equal(second.failed, 1);
    assert.equal(findEntry(row.id).retry.attempts, MAX_ATTEMPTS);

    // Out of budget: marked gone rather than retried forever.
    const third = await sweep({ client: clientFor(fake), force: true, now: Date.now() + RETRY_DELAYS_MS[1] + 5 });
    assert.equal(third.gone, 1);
    assert.equal(fake.state.served, 2, 'exactly two tries after the original failure');
    assert.equal(findEntry(row.id).retry.gone, true);
    assert.match(findEntry(row.id).retry.reason, /gave up/);
    assert.equal(pending().length, 0, 'a gone row is not outstanding any more');

    // And it stays gone: no further attempts, ever.
    const later = await sweep({ client: clientFor(fake), force: true, now: Date.now() + 10 * MAX_AGE_MS });
    assert.equal(later.candidates, 0);
    assert.equal(fake.state.served, 2);
  } finally {
    await fake.close();
    dropRoot(root);
  }
});

test('a fluke that clears is recovered on the next sweep', async () => {
  const fake = await startFake({ view: 'error' });
  const root = useTempRoot(fake.port);
  try {
    const row = missingRow();
    await sweep({ client: clientFor(fake) });
    assert.equal(findEntry(row.id).retry.attempts, 2);

    fake.setView('ok');
    const ok = await sweep({ client: clientFor(fake), force: true, now: Date.now() + 60_000 });
    assert.equal(ok.recovered, 1);
    assert.equal(findEntry(row.id).localPath != null, true);
  } finally {
    await fake.close();
    dropRoot(root);
  }
});

test('a 404 is a definite answer and stops the retries at once', async () => {
  const fake = await startFake({ view: 'gone' });
  const root = useTempRoot(fake.port);
  try {
    const row = missingRow();
    const report = await sweep({ client: clientFor(fake) });
    assert.equal(report.gone, 1);
    assert.equal(report.failed, 0);
    assert.equal(findEntry(row.id).retry.gone, true);
    assert.match(findEntry(row.id).retry.reason, /no longer has it/);
    assert.equal(findEntry(row.id).retry.attempts, 2, 'one ask was enough');

    await sweep({ client: clientFor(fake), force: true, now: Date.now() + 10 * MAX_AGE_MS });
    assert.equal(fake.state.served, 1, 'no point asking again');
  } finally {
    await fake.close();
    dropRoot(root);
  }
});

test('the age limit counts reachable time, so being away costs nothing', async () => {
  const fake = await startFake({ view: 'error' });
  const root = useTempRoot(fake.port);
  try {
    const row = missingRow();
    const day = MAX_AGE_MS + 1000;
    // First sight: the clock starts now, not when the download failed.
    await sweep({ client: clientFor(fake), now: 1_000_000 });
    const seen = findEntry(row.id).retry;
    assert.equal(seen.firstSeenAt, 1_000_000);
    assert.equal(seen.ageMs, 0);

    // Away for a week. No sweep runs, so no age accrues - that gap is invisible,
    // which is exactly the point of counting reachable time.
    const back = 1_000_000 + 7 * 24 * 60 * 60 * 1000;
    const report = await sweep({ client: clientFor(fake), force: true, now: back });
    assert.equal(report.gone, 1);
    assert.equal(findEntry(row.id).retry.ageMs, 7 * 24 * 60 * 60 * 1000);

    // A separate row that has been checked recently does not expire, however old
    // its entry is: age accrues per sweep, not per calendar day.
    const fresh = missingRow({ comfyFilename: 'ComfyUI_00002_.png', img: 1 });
    updateEntry(fresh.id, { retry: { attempts: 1, ageMs: 0, firstSeenAt: 1_000, lastCheckedAt: back } });
    await sweep({ client: clientFor(fake), force: true, now: back + 5_000 });
    assert.equal(findEntry(fresh.id).retry.gone, undefined);
    assert.equal(findEntry(fresh.id).retry.ageMs, 5_000);
  } finally {
    await fake.close();
    dropRoot(root);
  }
});

test('a dropped connection spends no attempt and stops the sweep there', async () => {
  const fake = await startFake();
  const root = useTempRoot(fake.port);
  try {
    const first = missingRow({ comfyFilename: 'ComfyUI_00001_.png', img: 0 });
    const second = missingRow({ comfyFilename: 'ComfyUI_00002_.png', img: 1 });
    // The host stops answering between the two rows.
    await fake.close();

    const report = await sweep({ client: new ComfyClient() });
    assert.equal(report.recovered, 0);
    assert.equal(report.failed, 0, 'a network blip is not the image failing');

    // The first row spent the time long enough to be scheduled, but the blip
    // gave its attempt back - so it still has its full two tries left.
    const seen = findEntry(first.id).retry;
    assert.equal(seen.attempts, 1, 'the budget is untouched');
    assert.equal(seen.gone, undefined);
    assert.equal(seen.nextAttemptAt, undefined, 'no failure was recorded, so nothing is scheduled');

    // The second row was never even looked at: the sweep stops at the first
    // unreachable host instead of burning through the rest of the gallery.
    assert.equal(findEntry(second.id).retry, undefined);
    assert.equal(pending().length, 2, 'both rows are still worth another go');
  } finally {
    await fake.close();
    dropRoot(root);
  }
});