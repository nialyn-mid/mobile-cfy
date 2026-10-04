import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseEnv } from './env.js';

// Seeded from the real workflow_api.json so the server runs with zero config.
export const DEFAULTS = {
  server: { host: '0.0.0.0', port: 3081 },
  comfy: { host: '192.168.1.78', port: 8188, timeoutMs: 2400000 },

  envFile: '.env',
  auth: { tokenVar: 'AUTH_TOKEN' },

  workflowFile: 'workflow_api.json',
  downloadDir: '~/storage/downloads/mobile-cfy',
  dataDir: './data',
  maxImages: 4,
  uploadPrefix: 'mobilecfy',

  // [] = every SaveImage's images (both S7 and S8 are finals). ["8"] = node 8 only.
  collectNodes: [],

  // SaveText-style nodes whose text output is pulled back after each run and
  // shown in the History tab. Node 181 "Save Text" is fed the same STRING that
  // node 5's text encoder received, so it is the prompt the image was actually
  // made from - enhanced, or the raw one when the enhancer was bypassed.
  // [] disables prompt capture entirely (unlike collectNodes, where [] = all).
  promptTextNodes: ['181'],

  // {stamp} {prompt} {variant} {seed} {shuffle} {batch} {img} {node} {group} {index}
  // The bash script wrote raw ComfyUI names (S8_00001_.png), which collide
  // across runs and read as noise in a folder of 60. This default is the moment
  // the prompt was submitted plus the three counters that identify it: shuffle
  // group, image within the batch, and image within the run. Set it to "" to fall
  // back to ComfyUI's own filename plus dedupe.
  filenameTemplate: '{stamp}_s{shuffle}b{batch}i{img}',

  bindings: {
    promptEnhanced: { node: '41', input: 'value' },
    promptRaw: { node: '44', input: 'value' },
    // 176 "Prompt Enhance On/Off" is an ImpactConditionalBranch: cond=true takes
    // tt_value (59, the enhancer), cond=false takes ff_value (44, the raw text).
    // It was node 43 (a ComfySwitchNode) until the workflow was reorganised -
    // writing 43 now silently does nothing because 43 no longer exists.
    enhanceSwitch: { node: '176', input: 'cond' },
    // 0 = text-to-image, N = the first N reference slots are routed through.
    // Node 165 converts this to the boolean that drives 14 "match reference size"
    // and 160/164/167/169 gate slots 1..4.
    imageCount: { node: '158', input: 'value' },
    shuffleSwitch: {
      node: '68',
      input: 'value',
      activeValue: true,
      inactiveValue: false,
    },
    turboSwitch: { node: '147', input: 'value', turboValue: true, normalValue: false },
    stepsTurbo: { node: '149', input: 'value' },
    stepsFull: { node: '150', input: 'value' },
    seed: { node: '37', input: 'seed' },
    // 232 "Input Megapixels" (PrimitiveFloat) feeds BOTH node 9's megapixels and
    // node 226 "Target Megapixels", so one write keeps the output size and the
    // enhancer's target in agreement. It was node 9 directly until the workflow
    // grew the float primitive.
    megapixels: { node: '232', input: 'value' },
    // 233 "Use Suggested Aspect": true lets the enhancer (226) hand its own
    // aspect to nodes 240/241, which 234/235 pick in preference to node 9.
    // Requires the enhancer, so the server forces it off when enhance is off.
    useSuggestedAspect: { node: '233', input: 'value' },
    // Only read when "Use Suggested Aspect" is off - then node 9's combo is what
    // 234/235 take. Values must match the dropdown in the node exactly.
    aspectRatio: { node: '9', input: 'aspect_ratio' },
    // 207 "Consistency LoRA" -> 220 ConvertAny2Int -> 219 (int_1 + 1), which is
    // the `select` of ImpactSwitch nodes 218/221: false passes the plain model
    // through, true routes it through 206 "Load LoRA (Model and CLIP)".
    consistencyLora: { node: '207', input: 'value' },
    // Text-encoder input resolution (node 5 "Text Encode Qwen Image 2.1" and the
    // editor copy in 71). Blank in the UI = leave the workflow's own 1024.
    inputResolution: { node: '204', input: 'value' },
    images: [
      { node: '11', input: 'image' },
      { node: '140', input: 'image' },
      { node: '141', input: 'image' },
      { node: '142', input: 'image' },
    ],
  },

  defaults: {
    megapixels: 1,
    batch: 1,
    shuffle: 1,
    // 'firstOfGroup' | 'everyRun' - when the override switch (node 68) fires.
    shuffleRefresh: 'firstOfGroup',
    promptEnhance: true,
    turbo: false,
    stepsOverride: null,
    // null = use whatever node 204 says in the workflow (1024 today).
    inputResolution: null,
    // true/false force the Consistency LoRA on/off; null leaves node 207 alone.
    // The default is `true` because that is what the workflow's own editor value
    // is - the page renders a plain on/off switch, so "blank" is not a state it
    // can show, and defaulting to false would quietly switch the LoRA OFF for
    // anyone who never touched the toggle. `null` is still honoured for callers
    // that set it by hand in config.json.
    consistency: true,
    // Suggested aspect comes from the enhancer, so it is forced off without it.
    useSuggestedAspect: false,
    aspectRatio: '1:1 (Square)',
    collectImages: true,
  },
};

/**
 * Binding values that MOVED when the workflow was reorganised.
 *
 * mergeConfig reconciles binding NAMES against DEFAULTS but never their values,
 * so a config saved before the move keeps pointing at the node the binding used
 * to live on. Writing the old node either fails loudly (gone) or, worse, silently
 * succeeds against a node that now means something else - the "I changed the node
 * id in Settings and nothing happened" family of bug.
 *
 * An untouched default is therefore upgraded in place at startup. A value the user
 * edited by hand is never rewritten: only an exact match for `from` migrates.
 */
export const BINDING_MIGRATIONS = {
  megapixels: { from: { node: '9', input: 'megapixels' }, to: { node: '232', input: 'value' } },
  // The enhance gate was a ComfySwitchNode `switch` before it became an
  // ImpactConditionalBranch `cond`. Both of the half-migrated shapes are covered:
  // the untouched default (43) and the one you get by typing the new node id and
  // leaving the old input name behind (176 + switch), which is a valid node with
  // a nonsense input - the exact thing a node id in Settings has to explain.
  enhanceSwitch: { from: { node: '43', input: 'switch' }, to: { node: '176', input: 'cond' } },
  enhanceSwitch2: { from: { node: '176', input: 'switch' }, to: { node: '176', input: 'cond' } },
};

export function migrateBindings(bindings) {
  const done = [];
  if (!isPlainObject(bindings)) return done;
  for (const [key, m] of Object.entries(BINDING_MIGRATIONS)) {
    // The migration key is the BINDING name; a "2" suffix means a second shape of
    // the same binding, not a different binding.
    const name = key.replace(/\d+$/, '') || key;
    // Compare against what would ACTUALLY be written - after mergeConfig that is
    // the saved value if there was one and the default otherwise. A value that
    // still equals `from` is an untouched default and safe to upgrade; anything
    // else was edited by hand (or already migrated) and is left alone.
    const have = bindings[name];
    if (!isPlainObject(have)) continue;
    if (have.node !== m.from.node || have.input !== m.from.input) continue;
    bindings[name] = { ...have, ...m.to };
    done.push(name);
  }
  return [...new Set(done)];
}

/**
 * Same idea for plain settings: a config.json written before a default changed
 * keeps the OLD value forever, because mergeConfig only fills gaps. A saved value
 * that still equals the old default is therefore upgraded to the new one; a value
 * the user typed is left alone.
 */
export const VALUE_MIGRATIONS = {
  filenameTemplate: { from: '{stamp}_{prompt}_{variant}_{seed}', to: '{stamp}_s{shuffle}b{batch}i{img}' },
  // Dotted paths reach into nested settings. `consistency` shipped as null ("do
  // not touch node 207"), which the page cannot represent: a switch is on or
  // off, and an untouched one rendered as off - so every run silently forced the
  // LoRA OFF where the workflow's editor says True.
  'defaults.consistency': { from: null, to: true },
};

export function migrateValues(cfg) {
  const done = [];
  if (!isPlainObject(cfg)) return done;
  for (const [path, m] of Object.entries(VALUE_MIGRATIONS)) {
    const keys = path.split('.');
    const last = keys.pop();
    let target = cfg;
    for (const k of keys) {
      target = target?.[k];
      if (!isPlainObject(target)) { target = null; break; }
    }
    if (!isPlainObject(target) || target[last] !== m.from) continue;
    target[last] = m.to;
    done.push(path);
  }
  return done;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function deepMerge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch ?? {})) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

// Binding objects are replaced wholesale, never merged - a removed input key
// must not linger just because the default had one.
//
// Binding NAMES are also reconciled against DEFAULTS: when a feature is renamed
// or removed, the stale key is dropped instead of surviving in config.json and
// pointing at a node the workflow no longer has (a silent no-op, because the
// old binding simply stops being read). Non-binding sections are untouched, so
// user-added keys elsewhere still survive.
export function mergeConfig(base, patch) {
  const out = deepMerge(base, patch);
  if (isPlainObject(patch?.bindings) && isPlainObject(base.bindings)) {
    const known = new Set(Object.keys(base.bindings));
    out.bindings = { ...base.bindings };
    for (const [k, v] of Object.entries(patch.bindings)) {
      if (known.has(k)) out.bindings[k] = Array.isArray(v) ? v : v;
    }
    out.staleBindings = Object.keys(patch.bindings).filter((k) => !known.has(k));
  }
  return out;
}

export function expandHome(p) {
  if (typeof p !== 'string' || !p.startsWith('~')) return p;
  return path.join(os.homedir(), p.slice(1).replace(/^[\\/]/, ''));
}

export function resolveFrom(root, p) {
  if (!p) return p;
  return path.resolve(root, expandHome(p));
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Atomic-ish write: temp file then rename, so a crash mid-save can't truncate config.
export function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------- app state

export const state = {
  root: process.cwd(),
  config: null,
  env: {},
  envStamp: '',
};

export function init(rootDir) {
  state.root = path.resolve(rootDir);
  const cfgPath = path.join(state.root, 'config.json');
  let saved = {};
  if (fs.existsSync(cfgPath)) {
    try {
      saved = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    } catch (e) {
      console.warn(`[config] ${cfgPath} is unreadable (${e.message}); using defaults`);
    }
  }
  state.config = mergeConfig(DEFAULTS, saved);
  const migrated = migrateBindings(state.config.bindings);
  const moved = migrateValues(state.config);
  if (migrated.length || moved.length) {
    console.log(
      `[config] upgraded to the current defaults: ${[...migrated, ...moved].join(', ')} ` +
        '(clear them in Settings to take full control)',
    );
    // Persist, so the upgrade happens once instead of on every start and the
    // file on disk agrees with what the server is actually using.
    try {
      writeJson(cfgPath, state.config);
    } catch (e) {
      console.warn(`[config] could not save the upgrade to ${cfgPath}: ${e.message}`);
    }
  }
  if (!fs.existsSync(cfgPath)) {
    writeJson(cfgPath, state.config);
    console.log(`[config] wrote defaults to ${cfgPath}`);
  }
  loadEnv();
  return state.config;
}

export function saveConfig(patch) {
  state.config = mergeConfig(state.config, patch ?? {});
  writeJson(path.join(state.root, 'config.json'), state.config);
  return state.config;
}

export function loadEnv() {
  const file = resolveFrom(state.root, state.config.envFile || '.env');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    text = '';
  }
  state.env = parseEnv(text);
  state.envStamp = file;
  return state.env;
}

export function envFilePath() {
  return resolveFrom(state.root, state.config.envFile || '.env');
}

// Re-reads .env without restarting - the retry-once path after a 401.
export function reloadEnv() {
  return loadEnv();
}

export function getToken() {
  const name = state.config?.auth?.tokenVar || 'AUTH_TOKEN';
  const tok = state.env?.[name] || '';
  return tok.trim();
}

export function config() {
  if (!state.config) init(process.cwd());
  return state.config;
}

export function paths() {
  const c = config();
  const dataDir = resolveFrom(state.root, c.dataDir);
  return {
    root: state.root,
    workflow: resolveFrom(state.root, c.workflowFile),
    config: path.join(state.root, 'config.json'),
    dataDir,
    uploads: path.join(dataDir, 'uploads'),
    gallery: path.join(dataDir, 'gallery'),
    index: path.join(dataDir, 'index.json'),
    downloadDir: resolveFrom(state.root, c.downloadDir),
  };
}