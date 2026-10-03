import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { init } from '../lib/config.js';
import {
  fingerprint,
  record,
  finish,
  list,
  find,
  remove,
  clear,
} from '../lib/history.js';

function freshRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcfy-hist-'));
  init(dir);
  return dir;
}

const SETTINGS = {
  megapixels: 1,
  batch: 2,
  shuffle: 1,
  promptEnhance: false,
  turbo: true,
  stepsOverride: 6,
  collectImages: true,
  refresh: 'firstOfGroup',
};

test('fingerprint ignores surrounding whitespace but not real differences', () => {
  const a = fingerprint({ prompt: 'a cat', settings: SETTINGS, slots: [] });
  const b = fingerprint({ prompt: '  a cat  ', settings: SETTINGS, slots: [] });
  const c = fingerprint({ prompt: 'a dog', settings: SETTINGS, slots: [] });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('fingerprint separates prompt, settings and slot identity', () => {
  const base = { prompt: 'x', settings: SETTINGS, slots: [{ uploadId: 'u1' }] };
  const fp = fingerprint(base);
  assert.notEqual(fp, fingerprint({ ...base, settings: { ...SETTINGS, turbo: false } }));
  assert.notEqual(fp, fingerprint({ ...base, slots: [{ uploadId: 'u2' }] }));
  assert.notEqual(fp, fingerprint({ ...base, slots: [{ ref: 'g1' }] }));
  assert.notEqual(fp, fingerprint({ ...base, slots: [] }));
});

test('record then list returns the entry newest first', () => {
  freshRoot();
  record({ prompt: 'one', settings: SETTINGS, slots: [], jobId: 'job-1' });
  record({ prompt: 'two', settings: SETTINGS, slots: [], jobId: 'job-2' });
  const rows = list();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].prompt, 'two');
  assert.equal(rows[1].prompt, 'one');
  assert.equal(rows[0].uses, 1);
  assert.equal(rows[0].jobId, 'job-2');
  assert.equal(rows[0].settings.stepsOverride, 6);
});

test('list trims to the requested limit', () => {
  freshRoot();
  for (let i = 0; i < 5; i += 1) record({ prompt: `p${i}`, settings: SETTINGS, slots: [], jobId: `j${i}` });
  assert.equal(list({ limit: 2 }).length, 2);
  assert.equal(list({ limit: 2 })[0].prompt, 'p4');
});

test('submitting the identical prompt twice folds into one row with a use count', () => {
  freshRoot();
  const first = record({ prompt: 'same', settings: SETTINGS, slots: [{ ref: 'g1' }], jobId: 'job-a' });
  const again = record({ prompt: 'same', settings: SETTINGS, slots: [{ ref: 'g1' }], jobId: 'job-b' });
  assert.equal(first.id, again.id);
  const rows = list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].uses, 2);
  assert.equal(rows[0].jobId, 'job-b');
});

test('a different setting set is a separate row even for the same prompt', () => {
  freshRoot();
  record({ prompt: 'same', settings: SETTINGS, slots: [], jobId: 'job-a' });
  record({ prompt: 'same', settings: { ...SETTINGS, turbo: false }, slots: [], jobId: 'job-b' });
  assert.equal(list().length, 2);
});

test('finish stamps status, image count and seeds onto the job row', () => {
  freshRoot();
  record({ prompt: 'run me', settings: SETTINGS, slots: [], jobId: 'job-x' });
  finish('job-x', { status: 'done', results: 4, seeds: [1, 2] });
  const row = list()[0];
  assert.equal(row.status, 'done');
  assert.equal(row.results, 4);
  assert.deepEqual(row.seeds, [1, 2]);
  assert.ok(row.finishedAt);
});

test('finish for an unknown job is a no-op, not a throw', () => {
  freshRoot();
  record({ prompt: 'a', settings: SETTINGS, slots: [], jobId: 'job-x' });
  assert.equal(finish('nope', { status: 'done' }), null);
  assert.equal(list().length, 1);
});

test('slots come back described for the UI, and a missing image is flagged', () => {
  freshRoot();
  // No upload and no gallery entry exists for these ids, so both are missing.
  record({ prompt: 'with refs', settings: SETTINGS, slots: [{ uploadId: 'gone1' }, { ref: 'gone2' }], jobId: 'j' });
  const [row] = list();
  assert.equal(row.slots.length, 2);
  assert.equal(row.slots[0].kind, 'upload');
  assert.equal(row.slots[0].uploadId, 'gone1');
  assert.equal(row.slots[0].available, false);
  assert.equal(row.slots[0].url, null);
  assert.equal(row.slots[1].kind, 'gallery');
  assert.equal(row.slots[1].ref, 'gone2');
  assert.equal(row.slots[1].available, false);
});

test('trailing empty slots survive the round trip as null', () => {
  freshRoot();
  record({ prompt: 'p', settings: SETTINGS, slots: [{ ref: 'g' }, null, null, null], jobId: 'j' });
  const [row] = list();
  assert.equal(row.slots.length, 4);
  assert.ok(row.slots[0]);
  assert.equal(row.slots[3], null);
});

test('remove deletes one row and reports whether it existed', () => {
  freshRoot();
  const a = record({ prompt: 'a', settings: SETTINGS, slots: [], jobId: 'j1' });
  const b = record({ prompt: 'b', settings: SETTINGS, slots: [], jobId: 'j2' });
  assert.equal(remove(b.id), true);
  assert.equal(remove(b.id), false);
  const rows = list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, a.id);
  assert.equal(find(b.id), null);
  assert.ok(find(a.id));
});

test('clear empties the store and keeps it usable', () => {
  freshRoot();
  record({ prompt: 'a', settings: SETTINGS, slots: [], jobId: 'j1' });
  clear();
  assert.equal(list().length, 0);
  record({ prompt: 'b', settings: SETTINGS, slots: [], jobId: 'j2' });
  assert.equal(list().length, 1);
});

test('a corrupt history file reads as empty instead of crashing the server', () => {
  const root = freshRoot();
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'history.json'), '{{{ not json', 'utf8');
  assert.deepEqual(list(), []);
  record({ prompt: 'recovered', settings: SETTINGS, slots: [], jobId: 'j' });
  assert.equal(list().length, 1);
});

test('prompts containing quotes and angle brackets survive storage', () => {
  freshRoot();
  const nasty = `<script>alert("x")</script> & 'quotes'`;
  record({ prompt: nasty, settings: SETTINGS, slots: [], jobId: 'j' });
  assert.equal(list()[0].prompt, nasty);
});

test('history is capped at 300 entries, dropping the oldest', () => {
  freshRoot();
  for (let i = 0; i < 305; i += 1) {
    record({ prompt: `p${i}`, settings: { ...SETTINGS, megapixels: 1 + i / 1000 }, slots: [], jobId: `j${i}` });
  }
  const all = list({ limit: 1000 });
  assert.equal(all.length, 300);
  assert.equal(all[0].prompt, 'p304');
  assert.equal(all[all.length - 1].prompt, 'p5');
});

test('record survives a server that cannot write history', () => {
  const root = freshRoot();
  // Put a plain file where the data directory belongs. mkdirSync on an existing
  // file throws on every platform, unlike chmod - which Windows ignores.
  fs.writeFileSync(path.join(root, 'data'), 'not a directory', 'utf8');
  assert.equal(record({ prompt: 'nope', settings: SETTINGS, slots: [], jobId: 'j' }), null);
});
