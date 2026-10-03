import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { parseEnv } from '../lib/env.js';
import { deepMerge, mergeConfig, DEFAULTS, expandHome } from '../lib/config.js';

test('parseEnv reads plain, quoted, and empty assignments', () => {
  const text = ['# comment', 'AUTH_TOKEN=$2b$12$abc', 'QUOTED="two words"', "SINGLE='q'", 'EMPTY=', 'no_equals_here', '', 'SPACED = spaced '].join('\n');
  const env = parseEnv(text);
  assert.equal(env.AUTH_TOKEN, '$2b$12$abc');
  assert.equal(env.QUOTED, 'two words');
  assert.equal(env.SINGLE, 'q');
  assert.equal(env.EMPTY, '');
  assert.equal(env.SPACED, 'spaced');
  assert.ok(!('no_equals_here' in env));
});

test('parseEnv keeps bcrypt tokens intact', () => {
  const tok = '$2b$12$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  assert.equal(parseEnv(`AUTH_TOKEN=${tok}`).AUTH_TOKEN, tok);
  assert.equal(parseEnv(`AUTH_TOKEN="${tok}"`).AUTH_TOKEN, tok);
});

test('deepMerge merges nested objects but replaces arrays', () => {
  const a = { server: { host: '0.0.0.0', port: 1 }, list: [1, 2] };
  const b = { server: { port: 2 }, list: [9] };
  const out = deepMerge(a, b);
  assert.deepEqual(out, { server: { host: '0.0.0.0', port: 2 }, list: [9] });
  assert.deepEqual(a.list, [1, 2], 'must not mutate the source');
});

test('mergeConfig replaces binding objects wholesale', () => {
  const out = mergeConfig(DEFAULTS, { bindings: { turboSwitch: { node: '999', input: 'flag' } } });
  assert.deepEqual(out.bindings.turboSwitch, { node: '999', input: 'flag' });
  assert.ok(!('turboValue' in out.bindings.turboSwitch), 'default keys must not linger');
  assert.deepEqual(DEFAULTS.bindings.turboSwitch, {
    node: '147',
    input: 'value',
    turboValue: true,
    normalValue: false,
  });
});

test('mergeConfig lets a binding be disabled with null', () => {
  const out = mergeConfig(DEFAULTS, { bindings: { seed: null } });
  assert.equal(out.bindings.seed, null);
});

test('mergeConfig swaps the image slot list', () => {
  const out = mergeConfig(DEFAULTS, { bindings: { images: [{ node: '7', input: 'image' }] } });
  assert.deepEqual(out.bindings.images, [{ node: '7', input: 'image' }]);
});

test('expandHome turns ~/x into an absolute path', () => {
  const got = expandHome('~/storage/downloads/mobile-cfy');
  assert.ok(path.isAbsolute(got));
  assert.ok(got.startsWith(os.homedir()));
});

test('defaults match the real workflow node ids', () => {
  const b = DEFAULTS.bindings;
  assert.equal(b.promptEnhanced.node, '41');
  assert.equal(b.promptRaw.node, '44');
  assert.equal(b.enhanceSwitch.node, '43');
  assert.equal(b.imageCount.node, '158');
  assert.equal(b.shuffleSwitch.node, '68');
  assert.equal(b.turboSwitch.node, '147');
  assert.equal(b.stepsTurbo.node, '149');
  assert.equal(b.stepsFull.node, '150');
  assert.equal(b.seed.node, '37');
  assert.equal(b.megapixels.node, '9');
  assert.deepEqual(b.images.map((i) => i.node), ['11', '140', '141', '142']);
  assert.deepEqual(DEFAULTS.collectNodes, [], 'both S7 and S8 are collected by default');
});

test('a renamed binding is dropped, not left pointing at a dead node', () => {
  const saved = {
    bindings: {
      ...DEFAULTS.bindings,
      // what config.json held before the workflow replaced node 12 with node 158
      referenceSwitch: { node: '12', input: 'value' },
    },
    missingSlotStrategy: 'keep',
  };
  const merged = mergeConfig(DEFAULTS, saved);
  assert.equal('referenceSwitch' in merged.bindings, false);
  assert.deepEqual(merged.staleBindings, ['referenceSwitch']);
  assert.deepEqual(merged.bindings.imageCount, { node: '158', input: 'value' });
  // non-binding keys still merge through, they are not schema-controlled
  assert.equal(merged.missingSlotStrategy, 'keep');
});

test('a binding the user customised by hand is preserved', () => {
  const merged = mergeConfig(DEFAULTS, {
    bindings: { seed: { node: '99', input: 'noise_seed' } },
  });
  assert.deepEqual(merged.bindings.seed, { node: '99', input: 'noise_seed' });
  assert.deepEqual(merged.staleBindings, []);
});