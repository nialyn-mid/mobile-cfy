import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from '../lib/env.js';
import {
  deepMerge, mergeConfig, migrateBindings, migrateValues,
  BINDING_MIGRATIONS, DEFAULTS, expandHome,
} from '../lib/config.js';
import { ASPECT_RATIOS } from '../lib/payload.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
  assert.equal(b.enhanceSwitch.node, '176');
  assert.equal(b.enhanceSwitch.input, 'cond');
  assert.equal(b.imageCount.node, '158');
  assert.equal(b.shuffleSwitch.node, '68');
  assert.equal(b.turboSwitch.node, '147');
  assert.equal(b.stepsTurbo.node, '149');
  assert.equal(b.stepsFull.node, '150');
  assert.equal(b.seed.node, '37');
  assert.equal(b.megapixels.node, '232');
  assert.equal(b.megapixels.input, 'value', '232 is a PrimitiveFloat, not node 9');
  assert.equal(b.useSuggestedAspect.node, '233');
  assert.equal(b.aspectRatio.node, '9');
  assert.equal(b.aspectRatio.input, 'aspect_ratio');
  assert.equal(b.consistencyLora.node, '207');
  assert.equal(b.inputResolution.node, '204');
  assert.deepEqual(b.images.map((i) => i.node), ['11', '140', '141', '142']);
  assert.deepEqual(DEFAULTS.collectNodes, [], 'both S7 and S8 are collected by default');
  assert.deepEqual(DEFAULTS.promptTextNodes, ['181'], 'the workflow SaveText node');
  assert.equal(DEFAULTS.defaults.inputResolution, null, 'blank means the workflow default');
  assert.equal(DEFAULTS.defaults.consistency, true, 'on, like the workflow editor');
  assert.equal(DEFAULTS.defaults.useSuggestedAspect, false);
  assert.equal(DEFAULTS.defaults.aspectRatio, '1:1 (Square)');
});

test('the default aspect ratio is one the workflow combo actually offers', () => {
  const combo = Object.values(
    JSON.parse(fs.readFileSync(new URL('../workflow_api.json', import.meta.url), 'utf8')),
  ).find((n) => n.class_type === 'ResolutionSelector')?.inputs?.aspect_ratio;
  // The live value is whatever the editor last picked; what matters is that the
  // default we ship is spelled the way the node's own dropdown spells it.
  assert.ok(typeof combo === 'string', 'expected a ResolutionSelector with an aspect_ratio combo');
  for (const r of ASPECT_RATIOS) {
    assert.equal(typeof r, 'string');
    assert.match(r, /^\d+:\d+ \(.+\)$/, `"${r}" should look like the node's own entries`);
  }
  assert.ok(ASPECT_RATIOS.includes(DEFAULTS.defaults.aspectRatio));
});

test('a config saved before the workflow moved is re-pointed, not left dead', () => {
  // This is the "I changed the node id and nothing happened" trap: mergeConfig
  // reconciles binding NAMES, so a stale VALUE survives and keeps writing into
  // the node the binding used to live on.
  const saved = mergeConfig(DEFAULTS, { bindings: { megapixels: { node: '9', input: 'megapixels' } } });
  assert.deepEqual(saved.bindings.megapixels, { node: '9', input: 'megapixels' }, 'precondition');

  assert.deepEqual(migrateBindings(saved.bindings), ['megapixels']);
  assert.deepEqual(saved.bindings.megapixels, { node: '232', input: 'value' });
});

test('a hand-edited binding is never rewritten by the migration', () => {
  const bindings = { megapixels: { node: '55', input: 'value' } };
  assert.deepEqual(migrateBindings(bindings), []);
  assert.deepEqual(bindings.megapixels, { node: '55', input: 'value' });
});

test('the migration is a no-op once the config already points at the new node', () => {
  const bindings = mergeConfig(DEFAULTS, { bindings: {} }).bindings;
  assert.deepEqual(migrateBindings(bindings), []);
  assert.deepEqual(bindings.megapixels, { node: '232', input: 'value' });
});

test('a null binding is skipped instead of being resurrected', () => {
  const bindings = { megapixels: null };
  assert.deepEqual(migrateBindings(bindings), []);
  assert.equal(bindings.megapixels, null, 'null means the user turned the feature off');
});

test('the enhance gate migrates from both of its old shapes', () => {
  // The untouched default, and the half-migrated row you get by typing the new
  // node id into Settings and leaving the old input name beside it - a real node
  // with an input that does not exist, reported as "has no input switch".
  for (const from of [{ node: '43', input: 'switch' }, { node: '176', input: 'switch' }]) {
    const bindings = mergeConfig(DEFAULTS, { bindings: { enhanceSwitch: from } }).bindings;
    assert.deepEqual(migrateBindings(bindings), ['enhanceSwitch']);
    assert.deepEqual(bindings.enhanceSwitch, { node: '176', input: 'cond' });
  }
});

test('two migration shapes of one binding are reported once', () => {
  const bindings = mergeConfig(DEFAULTS, {
    bindings: { megapixels: { node: '9', input: 'megapixels' }, enhanceSwitch: { node: '43', input: 'switch' } },
  }).bindings;
  assert.deepEqual(migrateBindings(bindings).sort(), ['enhanceSwitch', 'megapixels']);
  assert.deepEqual(bindings.enhanceSwitch, { node: '176', input: 'cond' });
  assert.deepEqual(bindings.megapixels, { node: '232', input: 'value' });
});

test('every migration points at an input the workflow really has', () => {
  // A migration that names a wrong node is worse than none: it upgrades a config
  // into a different broken one and the reason no longer matches the mistake.
  const wf = JSON.parse(fs.readFileSync(path.join(ROOT, 'workflow_api.json'), 'utf8'));
  for (const [key, m] of Object.entries(BINDING_MIGRATIONS)) {
    const node = wf[String(m.to.node)];
    assert.ok(node, `${key}: node ${m.to.node} is not in the workflow`);
    assert.ok(m.to.input in (node.inputs ?? {}), `${key}: node ${m.to.node} has no input "${m.to.input}"`);
  }
});

test('a setting still holding the old default is upgraded', () => {
  // config.json written before the filename default changed keeps the OLD value
  // forever, because mergeConfig only fills gaps - which is how a shipped
  // default change can look like it never landed.
  const cfg = { filenameTemplate: '{stamp}_{prompt}_{variant}_{seed}' };
  assert.deepEqual(migrateValues(cfg), ['filenameTemplate']);
  assert.equal(cfg.filenameTemplate, '{stamp}_s{shuffle}b{batch}i{img}');
});

test('a filename template the user wrote is never rewritten', () => {
  const cfg = { filenameTemplate: 'my_{prompt}' };
  assert.deepEqual(migrateValues(cfg), []);
  assert.equal(cfg.filenameTemplate, 'my_{prompt}');
  assert.deepEqual(migrateValues({ filenameTemplate: '{stamp}_s{shuffle}b{batch}i{img}' }), [], 'idempotent');
});

test('the shipped default survives a merge over a saved config', () => {
  // End to end for the bug: old saved value in, new default out.
  const merged = mergeConfig(DEFAULTS, { filenameTemplate: '{stamp}_{prompt}_{variant}_{seed}' });
  migrateValues(merged);
  assert.equal(merged.filenameTemplate, DEFAULTS.filenameTemplate);
});

test('the Consistency LoRA default upgrades through a dotted path', () => {
  // It shipped as null ("do not touch node 207"), which a checkbox cannot show:
  // an untouched switch rendered as off and forced the LoRA OFF on every run,
  // where the workflow's own editor value is True.
  const cfg = { defaults: { consistency: null } };
  assert.deepEqual(migrateValues(cfg), ['defaults.consistency']);
  assert.equal(cfg.defaults.consistency, true);
  assert.deepEqual(migrateValues(cfg), [], 'idempotent');
});

test('a Consistency LoRA choice the user made is never rewritten', () => {
  const cfg = { defaults: { consistency: false } };
  assert.deepEqual(migrateValues(cfg), []);
  assert.equal(cfg.defaults.consistency, false);
});

test('the Consistency LoRA ships on, matching the workflow', () => {
  assert.equal(DEFAULTS.defaults.consistency, true);
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