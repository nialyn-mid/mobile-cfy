import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sanitizeFilename, uniquePath, slugify, timestamp, renderTemplate, downloadImage } from '../lib/download.js';

test('sanitizeFilename strips path separators and collapses whitespace', () => {
  assert.equal(sanitizeFilename('a/b\\c.png'), 'a_b_c.png');
  assert.equal(sanitizeFilename('a   b.png'), 'a b.png');
});

test('sanitizeFilename refuses to return a bare dot name', () => {
  // path.join(dir, '..') escapes the download folder, so the guard must catch it.
  assert.equal(sanitizeFilename('  ..  '), '_..');
  assert.equal(sanitizeFilename('.'), '_.');
  assert.equal(sanitizeFilename(''), '_image');
});

test('slugify makes a prompt safe for a filename', () => {
  assert.equal(slugify('a small red cube'), 'a-small-red-cube');
  assert.equal(slugify('2 anime girls!'), '2-anime-girls');
  assert.equal(slugify('   '), 'prompt');
});

test('timestamp is yyMMdd-HHmmss', () => {
  assert.match(timestamp(new Date(2026, 9, 2, 17, 29, 13)), /^\d{6}-\d{6}$/);
  assert.equal(timestamp(new Date(2026, 9, 2, 7, 3, 4)), '261002-070304');
});

test('renderTemplate fills every token', () => {
  const out = renderTemplate('{stamp}_{prompt}_{variant}_{seed}_{index}_{node}_{group}', {
    prompt: 'a cat', seed: 42, index: 1, node: 8, group: 0, filename: 'qwen-image-2.1_S8_00001_.png',
  });
  assert.match(out, /^\d{6}-\d{6}_a-cat_S8_42_1_8_0$/);
});

test('renderTemplate keeps an unknown token instead of dropping it', () => {
  assert.equal(renderTemplate('x_{nope}', {}), 'x_{nope}');
});

test('renderTemplate strips slashes that would escape the download folder', () => {
  assert.ok(!renderTemplate('../../etc/{stamp}', {}).includes('/'));
});

test('renderTemplate falls back to the node id when there is no S7/S8 hint', () => {
  assert.match(renderTemplate('{variant}', { node: 45, filename: 'out.png' }), /^N45$/);
});

test('uniquePath appends _1, _2 ... rather than overwriting', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-dl-'));
  const a = uniquePath(dir, 'x.png');
  fs.writeFileSync(a, 'a');
  const b = uniquePath(dir, 'x.png');
  fs.writeFileSync(b, 'b');
  const c = uniquePath(dir, 'x.png');
  assert.equal(path.basename(a), 'x.png');
  assert.equal(path.basename(b), 'x_1.png');
  assert.equal(path.basename(c), 'x_2.png');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('downloadImage keeps the extension ComfyUI sent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-dl-'));
  const client = { viewImage: async () => Buffer.from('fake-png-bytes') };
  const saved = await downloadImage(client, { filename: 'qwen-image-2.1_S8_00001_.png', type: 'output' }, {
    dir,
    template: '{stamp}_{prompt}_{variant}_{seed}',
    ctx: { prompt: 'a red cube', seed: 7, filename: 'qwen-image-2.1_S8_00001_.png' },
  });
  assert.ok(saved.name.endsWith('.png'), `expected a .png name, got ${saved.name}`);
  assert.equal(path.extname(saved.path), '.png');
  assert.equal(fs.statSync(saved.path).size, 'fake-png-bytes'.length);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('downloadImage does not double the extension when the template supplies one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-dl-'));
  const client = { viewImage: async () => Buffer.from('x') };
  const saved = await downloadImage(client, { filename: 'out.png' }, { dir, template: 'fixed-name.png' });
  assert.equal(path.basename(saved.path), 'fixed-name.png');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('downloadImage de-duplicates instead of overwriting an earlier image', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-dl-'));
  const client = { viewImage: async () => Buffer.from('x') };
  const first = await downloadImage(client, { filename: 'a.png' }, { dir, template: 'same' });
  const second = await downloadImage(client, { filename: 'a.png' }, { dir, template: 'same' });
  assert.notEqual(first.path, second.path);
  fs.rmSync(dir, { recursive: true, force: true });
});