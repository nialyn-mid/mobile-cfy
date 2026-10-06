import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { init, paths } from '../lib/config.js';
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
  assert.deepEqual(row.promptTexts, [], 'no capture was requested for this run');
});

test('finish stores the prompt the workflow actually rendered, and how it got there', () => {
  freshRoot();
  record({ prompt: 'a cat', settings: SETTINGS, slots: [], jobId: 'job-y' });
  finish('job-y', {
    status: 'done',
    results: 1,
    seeds: [9],
    promptTexts: [{ runIndex: 0, seed: 9, source: 'enhanced', text: 'a photorealistic tabby cat, studio lighting' }],
  });
  const row = list()[0];
  assert.equal(row.promptTexts.length, 1);
  assert.equal(row.promptTexts[0].text, 'a photorealistic tabby cat, studio lighting');
  assert.equal(row.promptTexts[0].source, 'enhanced');
  assert.equal(row.promptTexts[0].runIndex, 0);
});

test('every run keeps its own wording - a batch can come back N different ways', () => {
  freshRoot();
  record({ prompt: 'a cat', settings: SETTINGS, slots: [], jobId: 'job-m' });
  finish('job-m', {
    status: 'done',
    results: 3,
    seeds: [1, 2, 3],
    promptTexts: [
      { runIndex: 0, seed: 1, source: 'enhanced', text: 'wording one' },
      { runIndex: 2, seed: 3, source: 'enhanced', text: 'wording three' },
    ],
  });
  const texts = list()[0].promptTexts;
  assert.deepEqual(texts.map((t) => t.text), ['wording one', 'wording three']);
  assert.deepEqual(texts.map((t) => t.runIndex), [0, 2]);
  assert.deepEqual(texts.map((t) => t.seed), [1, 3]);
});

test('a re-run appends its captures instead of replacing them', () => {
  freshRoot();
  record({ prompt: 'a cat', settings: SETTINGS, slots: [], jobId: 'job-r' });
  finish('job-r', { status: 'done', results: 1, seeds: [1], promptTexts: [{ runIndex: 0, seed: 1, text: 'first wording' }] });
  finish('job-r', { status: 'done', results: 1, seeds: [1], promptTexts: [{ runIndex: 0, seed: 1, text: 'second wording' }] });
  assert.deepEqual(list()[0].promptTexts.map((t) => t.text), ['first wording', 'second wording']);
});

test('the same capture twice is not listed twice', () => {
  freshRoot();
  record({ prompt: 'a cat', settings: SETTINGS, slots: [], jobId: 'job-d' });
  const cap = { runIndex: 0, seed: 5, text: 'same wording' };
  finish('job-d', { status: 'done', results: 1, seeds: [5], promptTexts: [cap] });
  finish('job-d', { status: 'done', results: 1, seeds: [5], promptTexts: [{ ...cap }] });
  assert.equal(list()[0].promptTexts.length, 1);
});

test('a row written before captures were a list still shows its prompt', () => {
  // history.json on disk may already hold the old single-string shape.
  freshRoot();
  record({ prompt: 'a cat', settings: SETTINGS, slots: [], jobId: 'job-old' });
  finish('job-old', { status: 'done', results: 1, seeds: [1] });
  const file = path.join(paths().dataDir, 'history.json');
  const store = JSON.parse(fs.readFileSync(file, 'utf8'));
  store.entries[0].promptText = 'legacy wording';
  store.entries[0].promptSource = 'enhanced';
  fs.writeFileSync(file, JSON.stringify(store));
  const texts = list()[0].promptTexts;
  assert.equal(texts.length, 1);
  assert.equal(texts[0].text, 'legacy wording');
  assert.equal(texts[0].source, 'enhanced');
});

test('a bypassed enhancer is labelled raw, not dressed up as enhanced', () => {
  // The workflow falls back to node 44 on its own when a reference image is
  // attached, so the saved text can be the untouched prompt even though the
  // toggle was on. Showing that as "enhanced prompt" would be a lie.
  freshRoot();
  record({ prompt: 'a cat', settings: SETTINGS, slots: [{ uploadId: 'u1' }], jobId: 'job-z' });
  finish('job-z', { status: 'done', results: 1, seeds: [3], promptTexts: [{ runIndex: 0, seed: 3, source: 'raw', text: 'a cat' }] });
  assert.equal(list()[0].promptTexts[0].source, 'raw');
});

test('a re-run that loses its text file keeps what the last one captured', () => {
  freshRoot();
  record({ prompt: 'a cat', settings: SETTINGS, slots: [], jobId: 'job-w' });
  finish('job-w', { status: 'done', results: 1, seeds: [1], promptTexts: [{ runIndex: 0, seed: 1, text: 'enhanced wording' }] });
  finish('job-w', { status: 'error', results: 0, seeds: [] });
  const row = list()[0];
  assert.equal(row.status, 'error');
  assert.equal(row.promptTexts[0].text, 'enhanced wording');
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

test('a postprompt survives the round trip that restores the box', () => {
  freshRoot();
  record({ prompt: 'a cat', settings: { ...SETTINGS, postprompt: '\n\npencil sketch' }, slots: [], jobId: 'j-pp' });
  finish('j-pp', { status: 'done', results: 1, seeds: [1] });
  assert.equal(list()[0].settings.postprompt, '\n\npencil sketch');
});

test('two runs that differ only by their postprompt are two rows', () => {
  // The fingerprint covers the whole settings object, so a job submitted with a
  // different tail cannot be folded into the previous one - which would silently
  // re-run it with the wrong postprompt and leave the row showing the new text.
  freshRoot();
  record({ prompt: 'a cat', settings: { ...SETTINGS, postprompt: 'at dusk' }, slots: [], jobId: 'j-1' });
  record({ prompt: 'a cat', settings: { ...SETTINGS, postprompt: 'at dawn' }, slots: [], jobId: 'j-2' });
  const rows = list();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.settings.postprompt).sort(), ['at dawn', 'at dusk']);
});

test('record survives a server that cannot write history', () => {
  const root = freshRoot();
  // Put a plain file where the data directory belongs. mkdirSync on an existing
  // file throws on every platform, unlike chmod - which Windows ignores.
  fs.writeFileSync(path.join(root, 'data'), 'not a directory', 'utf8');
  assert.equal(record({ prompt: 'nope', settings: SETTINGS, slots: [], jobId: 'j' }), null);
});
