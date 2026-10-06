import http from 'node:http';
import fs from 'node:fs';

// A 1x1 PNG - the downloader only needs bytes with the right magic number.
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

export function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, label, timeout = 15000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await sleep(40);
  }
}

/** The suite also runs on the phone, whose temp dir should not collect a spare
 * copy of every test's downloads folder. */
export const dropRoot = (root) => fs.rmSync(root, { recursive: true, force: true });

/**
 * A stand-in for ComfyUI, good enough to exercise the queue and the download
 * retry: /prompt, /history, /queue (including the `delete` form cancel needs),
 * /view and /system_stats.
 *
 * `mode: 'manual'` keeps every submitted prompt pending until the test finishes
 * it, which is what makes "hand the whole batch over and walk away" observable.
 *
 * `holdStart` goes one step further: the prompt sits in `queue_pending`, i.e. it
 * has been handed over but ComfyUI has not begun it. That is the only state in
 * which a run has a prompt id and NO start time, so it is the state a timer has
 * to be right about. `startAll()` (or `start(id)`) moves it to `queue_running`.
 */
export function startFakeComfyUI({ mode = 'instant', holdStart = false, saveNode = 8, textNode = 181 } = {}) {
  const state = {
    mode,
    holdStart,
    saveNode,
    textNode,
    prompts: [],
    deleted: [],
    next: 0,
    pending: new Map(),
    running: new Set(),
    foreign: [],
    foreignNext: 0,
    history: new Map(),
    uploads: [],
    stall: null,
    queueFail: false,
    // /system_stats impersonators: a login page, a proxy refusal, a dead
    // socket that answers anyway. The health classifier tells these apart, so
    // the suite has to be able to produce each one.
    statsBody: null,
    statsStatus: 200,
    statsDelayMs: 0,
    authFail: false,
  };

  const entryFor = (n, prompt) => ({
    status: { status_str: 'success', completed: true },
    outputs: {
      // The graph under test decides which node saves; the generate workflow
      // uses 8 and 181, the upscale workflow saves from 508 and has no text node.
      [saveNode]: {
        images: [{ filename: `ComfyUI_${String(n).padStart(5, '0')}_.png`, subfolder: '', type: 'output' }],
      },
      ...(textNode === null ? {} : { [textNode]: { text: [`enhanced: ${String(prompt).slice(0, 40)}`] } }),
    },
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'Content-Type': type });
      res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };

    // A ComfyUI behind ComfyUI-Login that no longer believes the token. Every
    // path, because that is what the extension does.
    if (state.authFail) return send(401, { error: 'no' });

    if (req.method === 'POST' && url.pathname === '/prompt') {
      readJson(req).then((body) => {
        const n = ++state.next;
        const promptId = `p${n}`;
        state.prompts.push({ id: promptId, payload: body?.prompt, clientId: body?.client_id });
        if (state.mode === 'instant') state.history.set(promptId, entryFor(n, 'x'));
        else {
          state.pending.set(promptId, n);
          if (!state.holdStart) state.running.add(promptId);
        }
        const reply = () => send(200, { prompt_id: promptId, number: n, node_errors: {} });
        // `stallNext` lets a test hold the ANSWER back while the prompt is already
        // recorded, which is the exact window a second submitter would slip into.
        const stall = state.stall;
        if (!stall) return reply();
        state.stall = null;
        stall.promise.then(reply, reply);
      });
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/history/')) {
      const id = decodeURIComponent(url.pathname.slice('/history/'.length));
      const n = state.history.has(id) ? null : state.pending.get(id);
      if (state.history.has(id)) send(200, { [id]: state.history.get(id) });
      else if (n !== undefined) send(200, { [id]: { status: { status_str: 'pending' }, outputs: {} } });
      else send(200, {});
      return;
    }

    if (url.pathname === '/queue') {
      if (req.method === 'POST') {
        readJson(req).then((body) => {
          for (const id of body?.delete ?? []) {
            state.deleted.push(id);
            state.pending.delete(id);
            state.running.delete(id);
            state.history.delete(id);
          }
          send(200, {});
        });
        return;
      }
      // A ComfyUI that answers everything except /queue. The runner has to treat
      // this as "cannot tell", never as "the queue is empty".
      if (state.queueFail) return send(500, { error: 'queue unavailable' });
      // ComfyUI really does separate the two lists, and so must the fake: the
      // difference between "queued" and "running" is the whole reason the run
      // timer does not start at submit.
      send(200, {
        queue_running: [...state.pending.keys()].filter((id) => state.running.has(id)).map((id) => [1, id, {}, {}, []]),
        queue_pending: [...state.pending.keys()].filter((id) => !state.running.has(id)).map((id) => [1, id, {}, {}, []]),
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/upload/image') {
      // The fake does not keep an input directory - it only has to say the way
      // ComfyUI does, because LoadImage is handed this name back and the runner
      // writes it into the workflow. The multipart body is drained, not parsed.
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('latin1');
        const name = /filename="([^"]+)"/.exec(raw)?.[1] ?? 'upload.png';
        state.uploads.push(name);
        send(200, { name, subfolder: '', type: 'input' });
      });
      return;
    }

    if (url.pathname === '/view') return send(200, PNG, 'image/png');
    if (url.pathname === '/system_stats') {
      // `statsBody` is how the suite reproduces the failure that has no status
      // to give it away: a 200 whose body is a login page. JSON.parse says
      // "Unexpected token <" and the address is innocent.
      const reply = () =>
        state.statsBody
          ? send(state.statsStatus, state.statsBody, 'text/html; charset=utf-8')
          : send(state.statsStatus, { system: { comfyui_version: '0.3.0-test', devices: [] } });
      if (state.statsDelayMs) setTimeout(reply, state.statsDelayMs);
      else reply();
      return;
    }
    send(404, { error: 'not found' });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        state,
        /** Finish every prompt still waiting. */
        completeAll() {
          for (const [id, n] of state.pending) state.history.set(id, entryFor(n, 'x'));
          state.pending.clear();
          state.running.clear();
        },
        /** ComfyUI begins working on the prompts held by `holdStart`. */
        startAll() {
          for (const id of state.pending.keys()) state.running.add(id);
        },
        /** ...or just one of them, so the rest stay "ahead in the queue". */
        start(id) {
          state.running.add(id);
        },
        /** Prompts handed over but not begun yet, in queue order. */
        held: () => [...state.pending.keys()].filter((id) => !state.running.has(id)),
        ids: () => state.prompts.map((p) => p.id),
        /**
         * Work another client put in ComfyUI's queue - the shape the runner has
         * to notice before adding a prompt of its own. These ids are in nobody's
         * job, which is exactly how a second device's work looks from here.
         */
        foreign(n = 1) {
          for (let i = 0; i < n; i += 1) {
            const id = `x${++state.foreignNext}`;
            state.pending.set(id, ++state.next);
            state.running.add(id);
            state.foreign.push(id);
          }
          return state.foreign.slice();
        },
        /** ...and that other client finishing, which frees the queue. */
        clearForeign() {
          for (const id of state.foreign) {
            state.pending.delete(id);
            state.running.delete(id);
          }
          state.foreign.length = 0;
        },
        foreignIds: () => state.foreign.slice(),
        /** Hold the next /prompt ANSWER back until the returned gate is released. */
        stallNext() {
          let release = () => {};
          state.stall = { promise: new Promise((r) => { release = r; }) };
          return { release: () => release() };
        },
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** The prompt text a submitted payload carried, whichever text node took it. */
export function textOf(p) {
  const wf = p.payload ?? {};
  return wf['41']?.inputs?.value ?? wf['44']?.inputs?.value ?? null;
}