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
 */
export function startFakeComfyUI({ mode = 'instant' } = {}) {
  const state = {
    mode,
    prompts: [],
    deleted: [],
    next: 0,
    pending: new Map(),
    history: new Map(),
    stall: null,
  };

  const entryFor = (n, prompt) => ({
    status: { status_str: 'success', completed: true },
    outputs: {
      8: { images: [{ filename: `ComfyUI_${String(n).padStart(5, '0')}_.png`, subfolder: '', type: 'output' }] },
      181: { text: [`enhanced: ${String(prompt).slice(0, 40)}`] },
    },
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'Content-Type': type });
      res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };

    if (req.method === 'POST' && url.pathname === '/prompt') {
      readJson(req).then((body) => {
        const n = ++state.next;
        const promptId = `p${n}`;
        state.prompts.push({ id: promptId, payload: body?.prompt, clientId: body?.client_id });
        if (state.mode === 'instant') state.history.set(promptId, entryFor(n, 'x'));
        else state.pending.set(promptId, n);
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
            state.history.delete(id);
          }
          send(200, {});
        });
        return;
      }
      send(200, {
        queue_running: [...state.pending.keys()].map((id) => [1, id, {}, {}, []]),
        queue_pending: [],
      });
      return;
    }

    if (url.pathname === '/view') return send(200, PNG, 'image/png');
    if (url.pathname === '/system_stats') {
      return send(200, { system: { comfyui_version: '0.3.0-test', devices: [] } });
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
        },
        ids: () => state.prompts.map((p) => p.id),
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