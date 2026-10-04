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

  // {stamp} {prompt} {variant} {seed} {index} {node} {group}
  // The bash script wrote raw ComfyUI names (S8_00001_.png), which collide
  // across runs and read as noise in a folder of 60. This default is readable;
  // set it to "" to fall back to ComfyUI's own filename plus dedupe.
  filenameTemplate: '{stamp}_{prompt}_{variant}_{seed}',

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
    // and 160/164/167/169 gate slots 1..4. The prompt routing itself needs no
    // write from us any more: node 178 "Switch (Any)" takes
    // min(imageCount + 1, 2), so any image at all forces the raw prompt through.
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
    megapixels: { node: '9', input: 'megapixels' },
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
    megapixels: 4,
    batch: 1,
    shuffle: 1,
    // 'firstOfGroup' | 'everyRun' - when the override switch (node 68) fires.
    shuffleRefresh: 'firstOfGroup',
    promptEnhance: true,
    turbo: false,
    stepsOverride: null,
    // null = use whatever node 204 says in the workflow (1024 today).
    inputResolution: null,
    collectImages: true,
  },
};

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