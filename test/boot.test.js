// The page has no framework and no build step: app.js boots by BEING EVALUATED.
// Every top-level statement runs once, in order, and one throw aborts everything
// after it - so "the shut down button gives no feedback" and "swipe stopped
// working" were both the same bug: a `$('lbClose').onclick =` against a button
// somebody commented out of index.html, two thousand lines above the pointer
// handlers that then never got attached.
//
// Source-reading tests (ui.test.js) can see the wiring is written; only this
// file actually RUNS it. The DOM here is deliberately harsh: every id that
// index.html declares exists as a plain element, and every id it does NOT have
// - lbClose, lbZoomIn, lbZoomOut, which live only inside HTML comments - comes
// back as null, exactly as a browser would report them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'public', 'app.js');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
// A commented-out button is not a button: these must be MISSING below.
const liveHtml = html.replace(/<!--[\s\S]*?-->/g, '');

/** Everything an element in this page is ever asked to do. */
function makeEl(id, tagName) {
  const listeners = new Map();
  const classes = new Set();
  return {
    id, tagName,
    value: '', checked: false, disabled: false, hidden: false, type: 'text',
    textContent: '', innerHTML: '', title: '', className: '',
    isConnected: true,
    style: {}, dataset: {},
    offsetWidth: 0, offsetHeight: 0, clientWidth: 0, clientHeight: 0, scrollHeight: 0,
    options: [], files: [],
    // Kept for assertions: the lightbox's swipe and pinch live in here, and the
    // whole point of this file is that they still get attached.
    listeners,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle(c, force) {
        const on = force === undefined ? !classes.has(c) : Boolean(force);
        if (on) classes.add(c); else classes.delete(c);
        return on;
      },
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener() {},
    append() {}, prepend() {}, appendChild(n) { return n; },
    remove() {}, removeChild() {},
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    click() {}, focus() {}, blur() {}, select() {}, setSelectionRange() {},
    scrollIntoView() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }; },
  };
}

/** One element per id index.html actually declares (comments stripped above). */
function buildEls() {
  const els = new Map();
  const tags = /<([a-zA-Z0-9]+)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  for (const m of liveHtml.matchAll(tags)) {
    const attrs = m[2];
    const id = /\bid="([^"]*)"/.exec(attrs)?.[1];
    if (!id || els.has(id)) continue;
    const el = makeEl(id, m[1].toUpperCase());
    el.className = /\bclass="([^"]*)"/.exec(attrs)?.[1] ?? '';
    for (const d of attrs.matchAll(/\bdata-([\w-]+)="([^"]*)"/g)) {
      el.dataset[d[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = d[2];
    }
    els.set(id, el);
  }
  return els;
}

const REFUSED = {
  allowed: false,
  because: 'this page was opened from 192.168.1.99, which is another device',
  error: 'the shut down button only works from the phone, and this page was opened from 192.168.1.99, which is another device',
};
const ALLOWED = {
  allowed: true,
  because: 'this is the phone itself (127.0.0.1)',
  error: null,
};

// Per-boot observations, reset by every install().
let els; let fetches; let esOpened; let intervals; let docListeners;

function install(shutdown) {
  els = buildEls();
  fetches = [];
  esOpened = [];
  intervals = [];
  docListeners = [];

  globalThis.document = {
    getElementById: (id) => els.get(id) ?? null,
    createElement: (tag) => makeEl('', String(tag).toUpperCase()),
    querySelector(sel) {
      const m = /^\.([\w-]+)$/.exec(sel);
      return m ? this.querySelectorAll(sel)[0] ?? null : null;
    },
    querySelectorAll(sel) {
      const m = /^\.([\w-]+)$/.exec(sel);
      if (!m) return [];
      return [...els.values()].filter((e) => e.className.split(/\s+/).includes(m[1]));
    },
    addEventListener: (type, fn) => docListeners.push([type, fn]),
    removeEventListener() {},
    body: makeEl('body', 'BODY'),
    documentElement: makeEl('html', 'HTML'),
    hidden: false,
    visibilityState: 'visible',
  };
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    scrollTo() {},
    innerHeight: 800,
    innerWidth: 400,
    isSecureContext: false,
  };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.EventSource = class EventSourceStub {
    constructor(url) { this.url = url; esOpened.push(this); }
    close() {}
    addEventListener() {}
  };
  globalThis.fetch = async (url) => {
    const u = String(url);
    fetches.push(u);
    const body = u.startsWith('/api/health')
      ? {
          comfy: { state: 'ok', host: '127.0.0.1', port: 3081, info: { comfyui_version: 'test' }, checkedAt: Date.now() },
          queue: { paused: false, reason: null, waiting: 0, running: 0, submitted: 0 },
          shutdown,
        }
      : u.startsWith('/api/config')
        ? { defaults: { defaults: { batch: 1, promptEnhance: true } } }
        : u.startsWith('/api/jobs')
          ? { jobs: [], queue: { paused: false, reason: null, waiting: 0, running: 0, submitted: 0 } }
          : {};
    return {
      ok: true, status: 200, statusText: 'OK',
      text: async () => JSON.stringify(body),
      json: async () => body,
    };
  };
}

let boots = 0;
async function boot(shutdown) {
  install(shutdown);
  // The two boot intervals must not keep this test process alive, and the test
  // runner must keep the real one - so the stub exists only for the evaluation.
  const real = globalThis.setInterval;
  globalThis.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return { unref() {} }; };
  try {
    // A fresh query re-evaluates the module: a second boot needs its own state.
    await import(pathToFileURL(APP).href + `?boot=${++boots}`);
  } finally {
    globalThis.setInterval = real;
  }
  // refreshHealth() and the defaults IIFE are unawaited promises; let them land.
  await new Promise((r) => setTimeout(r, 25));
}

test('booting the page wires every control - including the ones whose buttons are commented out', async () => {
  await boot(REFUSED);

  // Module scope ran all the way to the end...
  assert.ok(fetches.includes('/api/health'), 'refreshHealth() ran');
  assert.ok(fetches.includes('/api/config'), 'the remembered-settings IIFE ran');
  assert.equal(esOpened.length, 1, 'connectEvents() opened the event stream');
  assert.deepEqual(intervals.map((i) => i.ms), [1000, 30000], 'both boot intervals were scheduled');
  const docTypes = docListeners.map(([t]) => t);
  assert.ok(docTypes.includes('keydown'), 'the lightbox key handler was attached');
  assert.ok(docTypes.includes('visibilitychange'), 'the wake-up handler was attached');

  // ...which is only possible if the old module-scope crash did NOT happen:
  // lbClose exists in index.html only inside a comment, so $('lbClose') came
  // back as null here and the line below it used to throw - taking the swipe,
  // the pinch and everything after it down with it.
  assert.equal(els.has('lbClose'), false, 'lbClose really is commented out of the markup');
  const img = els.get('lightboxImg');
  assert.ok(img, 'the lightbox image is in the markup');
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
    assert.ok(img.listeners.has(type), `the lightbox's ${type} handler was attached`);
  }

  // The controls that mattered in the last two bug reports are wired too.
  assert.equal(typeof els.get('shutdownServer').onclick, 'function', 'the shut down button opens the modal');
  assert.equal(typeof els.get('shGo').onclick, 'function', 'the confirm button has its handler');
  assert.equal(typeof els.get('lbPrev').onclick, 'function', 'the gallery arrows work');
  assert.equal(typeof els.get('generate').onclick, 'function', 'Generate works');

  // And the refusal from the very first health poll is painted before any press.
  const note = els.get('shutdownNote');
  assert.equal(note.hidden, false, 'a remote page is told it cannot shut the server down');
  assert.match(note.textContent, /shut down button only works from the phone/);
});

test('an allowed verdict leaves the note out of the way', async () => {
  await boot(ALLOWED);
  const note = els.get('shutdownNote');
  assert.equal(note.hidden, true, 'the phone itself sees no warning');
  assert.equal(note.textContent, '');
  // The second boot really did re-evaluate the module rather than reuse the
  // first one's state - otherwise this test would pass or fail by accident.
  assert.ok(fetches.includes('/api/health'), 'the second boot polled health again');
});
