import crypto from 'node:crypto';
import { config, getToken, reloadEnv } from './config.js';
import { WsClient } from './ws.js';

/**
 * Every failure this module raises carries a `kind`.
 *
 * `status` alone cannot tell "the phone cannot see the server" apart from "the
 * server said no" - both can arrive with status 0, and treating an HTTP problem
 * as a network problem would pause a queue that was never at fault. So:
 *
 *   http    - ComfyUI answered, and the answer was not fine
 *   network- the connection itself failed (wrong subnet, server asleep, DNS)
 *   timeout - no answer within the configured window, i.e. the same thing slowly
 *   cancel  - the operator pressed cancel, never a fault
 *   queue   - the prompt vanished from ComfyUI's queue (cleared/interrupted)
 */
export class ComfyError extends Error {
  constructor(message, { status = 0, body = '', path = '', kind = 'http' } = {}) {
    super(message);
    this.name = 'ComfyError';
    this.status = status;
    this.body = body;
    this.path = path;
    this.kind = kind;
  }
}

/**
 * Did we lose the server rather than get an answer from it?
 *
 * This is the single question the in-app queue asks before deciding to hold
 * everything it has instead of failing 40 runs one at a time, so it is answered
 * here, from one place, rather than re-guessed at every call site.
 */
export function isConnectionError(e) {
  return e instanceof ComfyError && (e.kind === 'network' || e.kind === 'timeout');
}

/**
 * ComfyUI answered 401: the token is wrong, missing, or stale.
 *
 * `reloaded` is the answer to "did you even see my new .env?". The client
 * re-reads the file on a 401 and retries once before giving up, so by the time
 * this is thrown either the file CHANGED and was still refused (ComfyUI's side
 * - it caches its own password at startup, so it needs the restart) or it held
 * the very token that just failed (this file's side: wrong line, wrong file, or
 * a save that never landed). Saying which turns "authentication error" from a
 * shrug into a next step.
 */
export class AuthError extends ComfyError {
  constructor(path, body, reloaded = null) {
    super(
      'Authentication required.'
      + (reloaded === null
        ? ''
        : reloaded
          ? ' The token was re-read from .env and ComfyUI still refuses it - restart ComfyUI after changing its password.'
          : ' .env still holds the same token ComfyUI refused - check AUTH_TOKEN in the .env file.'),
      { status: 401, body, path, kind: 'http' },
    );
    this.name = 'AuthError';
    this.reloaded = reloaded;
  }
}

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

export function mimeFor(filename = '') {
  const dot = filename.lastIndexOf('.');
  return (dot >= 0 && MIME[filename.slice(dot).toLowerCase()]) || 'application/octet-stream';
}

export function comfyBase() {
  const c = config().comfy;
  return `http://${c.host}:${c.port}`;
}

/**
 * Is the configured address even a shape that can be dialled?
 *
 * The base is built by string concatenation - `http://${host}:${port}` - so a
 * host box holding something that is not a host does not fail loudly. It fails
 * as a fetch error, and a fetch error reads exactly like "the server is down".
 * That is the worst possible answer for someone whose server is right there:
 * a pasted "http://192.168.1.5:8188" and a wrong port produce the same dot.
 * So the shape is checked BEFORE anything is dialled, and the message says which
 * box is wrong.
 *
 * Returns null when the address is fine.
 */
export function addressProblem(comfy = {}) {
  const raw = String(comfy.host ?? '').trim();
  // The port box is checked the same way however the host goes, so it is one
  // answer with two callers rather than two copies that drift apart.
  const portProblem = () => {
    if (comfy.port === '' || comfy.port === null || comfy.port === undefined) return 'the Port box is empty';
    const port = Number(comfy.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return `the Port box holds "${comfy.port}", which is not a port`;
    return null;
  };
  if (!raw) return 'the host box is empty';
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(raw);
  if (scheme) return `the host box wants the bare address - drop the "${scheme[0]}" from the front`;
  if (/\s/.test(raw)) return `the host has a space in it: "${raw}"`;
  if (raw.includes('/')) return `the host box wants the bare address - "${raw}" still has a path`;
  // Bracketed IPv6 ([::1]) is the correct form and needs no complaint; a bare
  // one is counted rather than pattern-matched, because "::1" ends in ":1" and
  // would otherwise be read as an address with port 1 attached.
  if (/^\[.*\]$/.test(raw)) return portProblem();
  const colons = raw.split(':').length - 1;
  if (colons > 1) return `an IPv6 address needs brackets, and the port belongs in the Port box - check "${raw}"`;
  if (colons === 1) return `the port belongs in the Port box - "${raw}" is an address AND a port`;
  return portProblem();
}

/**
 * Turn one failed health probe into something a person can act on.
 *
 * The old version had exactly two answers - 401 or "unreachable" - which folded
 * five different faults into one word: no answer, a slow answer, an HTML login
 * page, a proxy, and a timeout all read as "unreachable", and "unreachable" is
 * the one answer that sends you looking in the wrong place. Each case gets its
 * own word and its own next step.
 *
 *   no-token    - nothing to authenticate with
 *   bad address - the host/port boxes cannot be dialled at all (see addressProblem)
 *   unauthorized- ComfyUI answered and said the token is wrong
 *   slow        - ComfyUI is up but did not answer inside the window
 *   unreachable - nothing answered: wrong subnet, asleep, or bound to loopback
 *   not comfyui - something answered, with a WEB PAGE
 *   http NNN    - something answered, with a refusal
 */
export function classifyComfyHealth(e) {
  const message = e?.message ?? String(e);
  if (e instanceof AuthError || e?.status === 401) {
    return {
      state: 'unauthorized',
      kind: e?.kind ?? 'http',
      error: 'ComfyUI refused the token',
      hint: 'press "reload token from .env" - and restart ComfyUI first if its password changed',
    };
  }
  if (e?.kind === 'timeout') {
    return {
      state: 'slow',
      kind: 'timeout',
      error: message,
      hint: 'nothing came back in time - ComfyUI may still be starting up or loading models',
    };
  }
  if (e?.kind === 'network') {
    return {
      state: 'unreachable',
      kind: 'network',
      error: message,
      hint: 'nothing answered at that address - check host and port, and that ComfyUI listens on 0.0.0.0 rather than 127.0.0.1',
    };
  }
  if (e?.kind === 'parse') {
    return {
      state: 'not comfyui',
      kind: 'parse',
      error: message,
      hint: 'that address answered with a web page instead of ComfyUI - check the port. If the page is a login screen, reload the token',
    };
  }
  if (Number.isInteger(e?.status) && e.status >= 400) {
    return {
      state: `http ${e.status}`,
      kind: 'http',
      error: message,
      hint: 'something answered, but not us - usually a proxy, or a port that is not ComfyUI',
    };
  }
  return { state: 'unreachable', kind: 'other', error: message, hint: '' };
}

/**
 * The whole ComfyUI half of GET /api/health, as a pure-ish function of the
 * configured address, the token file and one probe.
 *
 * It lives here rather than in the route so the classification can be tested
 * without a socket, and so the UI has ONE place to learn "what is wrong and
 * what to do about it" instead of guessing from a single word.
 */
export async function comfyHealth(client = new ComfyClient()) {
  const c = config().comfy;
  const out = { host: c.host, port: c.port, state: 'unknown', checkedAt: Date.now() };
  const shape = addressProblem(c);
  if (shape) {
    out.state = 'bad address';
    out.problem = shape;
    return out;
  }
  if (!client.hasToken) {
    out.state = 'no-token';
    out.problem = 'no token in the .env file - copy the token= line out of the ComfyUI console';
    return out;
  }
  try {
    // Its own window, not the run timeout: /system_stats is instant on a warm
    // ComfyUI, so a long wait here means the address is wrong or the server is
    // still booting - and a phone that waits 40 minutes learns nothing.
    const stats = await client.systemStats({ timeoutMs: c.healthTimeoutMs ?? 8000 });
    out.state = 'ok';
    out.info = {
      comfyui: stats?.system?.comfyui_version,
      devices: (stats?.devices ?? []).map((d) => d.name),
    };
  } catch (e) {
    Object.assign(out, classifyComfyHealth(e));
  }
  return out;
}

/**
 * The prompt ids out of one of ComfyUI's two queue lists.
 *
 * The entries are POSITIONAL arrays, not objects:
 *   [number, prompt_id, prompt, extra_data, node_errors]
 * so the id lives at index 1. Reading `.prompt_id` off an entry yields undefined
 * with no error at all, which is how a queue full of prompts looks identical to
 * an empty one - the object form is kept as a fallback for anything that answers
 * with a different shape.
 */
export function readQueueIds(list) {
  return (Array.isArray(list) ? list : [])
    .map((e) => (Array.isArray(e) ? e[1] : e?.prompt_id))
    .filter(Boolean);
}

export class ComfyClient {
  #token;
  #retriedAuth = false;

  constructor(base = comfyBase()) {
    this.base = base;
    this.#token = getToken();
  }

  get hasToken() {
    return Boolean(this.#token);
  }

  #authHeaders() {
    return this.#token ? { Authorization: `Bearer ${this.#token}` } : {};
  }

  // One re-read of .env on a 401, then give up. Never loops.
  #refreshAuth() {
    reloadEnv();
    const next = getToken();
    const changed = next !== this.#token;
    this.#token = next;
    return changed;
  }

  async request(method, pathname, { query, json, body, headers = {}, timeoutMs, allow404 } = {}) {
    const url = new URL(pathname, this.base);
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

    const cfgTimeout = timeoutMs ?? config().comfy.timeoutMs ?? 2400000;
    const doFetch = () =>
      fetch(url, {
        method,
        headers: {
          ...this.#authHeaders(),
          ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body: json !== undefined ? JSON.stringify(json) : body,
        signal: AbortSignal.timeout(cfgTimeout),
      });

    let res;
    try {
      res = await doFetch();
    } catch (e) {
      if (e?.name === 'TimeoutError') {
        throw new ComfyError(`timeout after ${cfgTimeout}ms calling ${pathname}`, {
          path: pathname,
          kind: 'timeout',
        });
      }
      // fetch only rejects for the things you cannot see the server for - DNS,
      // a refused connection, a subnet the phone just walked out of. Whatever the
      // name, it means "no answer", which is what the queue pauses on.
      throw new ComfyError(`${e.message} (is ComfyUI at ${this.base}?)`, {
        path: pathname,
        kind: 'network',
      });
    }

    // One re-read of .env per 401, never a loop - and whether that re-read
    // produced a DIFFERENT token travels with the failure, so the message can
    // say which side is stale (see AuthError).
    let reloaded = null;
    if (res.status === 401 && !this.#retriedAuth) {
      this.#retriedAuth = true;
      reloaded = this.#refreshAuth();
      try {
        res = await doFetch();
      } finally {
        this.#retriedAuth = false;
      }
    }

    if (res.status === 401) throw new AuthError(pathname, await safeText(res), reloaded);
    if (allow404 && res.status === 404) return null;
    if (!res.ok) {
      throw new ComfyError(`HTTP ${res.status} ${res.statusText} on ${pathname}`, {
        status: res.status,
        body: await safeText(res),
        path: pathname,
      });
    }
    return res;
  }

  async getJson(pathname, opts) {
    const res = await this.request('GET', pathname, opts);
    return res.json();
  }

  /**
   * `res.json()` on a page that is not JSON throws a bare SyntaxError, and a
   * SyntaxError carries none of the useful parts: not the status, not the
   * content-type, not a byte of what actually came back. So a login screen, a
   * captive portal or a proxy error page all arrive as the same unhelpful
   * "Unexpected token <" - which is exactly the situation where the reply
   * itself is the diagnosis. Read it as text, then parse, and say what came.
   */
  async jsonChecked(pathname, opts) {
    const res = await this.request('GET', pathname, opts);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      const type = res.headers.get('content-type') ?? 'no content-type';
      const head = (text || '').trim().slice(0, 90).replace(/\s+/g, ' ');
      throw new ComfyError(
        `${pathname} answered ${res.status} as ${type}, not JSON: ${head || '(empty body)'}`,
        { status: res.status, body: text.slice(0, 400), path: pathname, kind: 'parse' },
      );
    }
  }

  async postJson(pathname, payload, opts) {
    const res = await this.request('POST', pathname, { ...opts, json: payload ?? {} });
    const text = await res.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  }

  // ------------------------------------------------------------------ calls

  async systemStats(opts = {}) {
    return this.jsonChecked('/system_stats', opts);
  }

  /**
   * One look at ComfyUI's queue, answered for one prompt.
   *
   * /queue entries are POSITIONAL arrays, not objects:
   *   [number, prompt_id, prompt, extra_data, node_errors]
   * so the id lives at index 1. Reading `.prompt_id` off an entry silently
   * yields undefined, which is how a cleared queue looks identical to a full one.
   *
   * `state` is the answer to the question the run timer turns on:
   *
   *   pending - queued, not one node executed yet
   *   running - ComfyUI is working on it RIGHT NOW
   *   absent  - neither, which (if we ever saw it queued) means it was lost
   *   unknown - the probe itself failed; never let that look like an empty queue
   *
   * `position` is how many prompts are ahead of it, which is the number that
   * matters while it waits - not how many are running, which is almost always 1.
   */
  async queueLookup(promptId, opts = {}) {
    try {
      const q = await this.getJson('/queue', opts);
      const running = readQueueIds(q?.queue_running);
      const pending = readQueueIds(q?.queue_pending);
      const at = pending.indexOf(promptId);
      return {
        state: running.includes(promptId) ? 'running' : at === -1 ? 'absent' : 'pending',
        position: at === -1 ? null : at,
        remaining: running.length,
      };
    } catch {
      return { state: 'unknown', position: null, remaining: null };
    }
  }

  /**
   * Every prompt id in ComfyUI's queue, whoever put it there.
   *
   * This is the one question the runner asks about work it did not send: another
   * device on the same ComfyUI shares its single queue, and a prompt from there
   * is invisible from here until this app looks.
   *
   * `ok: false` means the LOOK failed, which is not the same answer as an empty
   * queue and must never be read as one - so a failed probe is reported, never
   * guessed at.
   */
  async queueBusy(opts = {}) {
    try {
      const q = await this.getJson('/queue', opts);
      const running = readQueueIds(q?.queue_running);
      const pending = readQueueIds(q?.queue_pending);
      return { ok: true, ids: [...running, ...pending], running: running.length, pending: pending.length };
    } catch {
      return { ok: false, ids: [], running: 0, pending: 0 };
    }
  }

  async uploadImage(buffer, filename, { type = 'input', overwrite = true } = {}) {
    const fd = new FormData();
    fd.append('image', new Blob([buffer], { type: mimeFor(filename) }), filename);
    fd.append('overwrite', String(overwrite));
    fd.append('type', type);
    const res = await this.request('POST', '/upload/image', { body: fd });
    return res.json();
  }

  async submitPrompt(payload, { clientId, extraData } = {}) {
    const body = { prompt: payload, client_id: clientId, extra_data: extraData };
    return this.postJson('/prompt', body);
  }

  /**
   * Drop one prompt that has not started yet.
   *
   * Once "send everything" has put a batch of runs into ComfyUI's queue, cancel
   * has to reach past this app: a prompt sitting in ComfyUI will run whether or
   * not we are still watching it, and nothing else can call it off. ComfyUI
   * refuses to delete the running prompt, which is correct - it is never the one
   * we mean here.
   */
  async deleteQueuedPrompt(promptId) {
    return this.postJson('/queue', { delete: [promptId] }, { timeoutMs: 10000 });
  }

  async history(promptId, opts) {
    return this.getJson(`/history/${encodeURIComponent(promptId)}`, opts);
  }

  async historyEntry(promptId, opts) {
    const h = await this.history(promptId, opts);
    return h?.[promptId] ?? null;
  }

  async viewImage({ filename, subfolder = '', type = 'output' }) {
    const res = await this.request('GET', '/view', {
      query: { filename, subfolder, type },
    });
    return Buffer.from(await res.arrayBuffer());
  }

  async interrupt() {
    return this.postJson('/interrupt', {}, { timeoutMs: 10000 });
  }

  // --------------------------------------------------------------- monitor

  /**
   * Watch one prompt to completion.
   * WebSocket drives the progress events; /history decides the outcome, because
   * it is the only source that reliably reports a finished-but-empty run.
   */
  async monitor(promptId, { onEvent = () => {}, signal } = {}) {
    const clientId = crypto.randomUUID();
    const wsUrl =
      `${this.base.replace(/^http/, 'ws')}/ws` +
      `?clientId=${encodeURIComponent(clientId)}` +
      (this.#token ? `&token=${encodeURIComponent(this.#token)}` : '');

    let ws = null;
    let wsFailed = null;
    try {
      ws = new WsClient(wsUrl);
      ws.on('message', (text) => {
        let msg;
        try {
          msg = JSON.parse(text);
        } catch {
          return;
        }
        try {
          onEvent(normalize(msg, promptId));
        } catch {
          /* a bad UI handler must not kill the stream */
        }
      });
      ws.on('error', () => {});
      await ws.connect({ timeoutMs: 10000 });
    } catch (e) {
      wsFailed = e;
      if (e?.status === 401) throw new AuthError('/ws', e.message);
      onEvent({ type: 'ws-failed', message: e.message });
    }

    const cleanup = () => {
      try {
        ws?.close(1000, '');
      } catch {
        /* already gone */
      }
    };

    try {
      return await this.#pollUntilDone(promptId, { onEvent, signal, wsFailed });
    } finally {
      cleanup();
    }
  }

  async #pollUntilDone(promptId, { onEvent, signal, wsFailed }) {
    const entered = Date.now();
    // Emitted exactly once. The run timer turns on this, so it must not depend on
    // catching the prompt in `queue_running`: a run short enough to be finished
    // by the first poll never appears there at all.
    let sawStart = false;
    const markStarted = () => {
      if (sawStart) return;
      sawStart = true;
      onEvent({ type: 'started', at: Date.now() });
    };
    let reportedQueue = -1;
    // A prompt can vanish without an error: the user clears the queue, or the
    // server restarts. Without this the job would hang for the full timeout.
    let seenInQueue = false;
    let absentPolls = 0;

    for (;;) {
      if (signal?.aborted) throw new ComfyError('cancelled', { path: '/history', kind: 'cancel' });

      const entry = await this.historyEntry(promptId);
      if (entry) {
        const status = entry.status ?? {};
        if (status.completed === true) {
          markStarted();
          onEvent({ type: 'done', outputs: entry.outputs ?? {}, status });
          return { outputs: entry.outputs ?? {}, status };
        }
        if (status.status_str === 'error') {
          const msg =
            status.messages?.find((m) => m[0] === 'execution_error')?.[1]?.exception_message ||
            'execution error';
          markStarted();
          onEvent({ type: 'error', message: msg, detail: status.messages ?? [] });
          throw new ComfyError(msg, { path: '/history' });
        }
      }

      const q = await this.queueLookup(promptId);

      // Only judge the prompt lost once it has actually been seen queued, so a
      // brief /queue hiccup right after submit cannot fail a healthy run.
      if (q.state === 'unknown') {
        absentPolls = 0;
      } else if (q.state !== 'absent') {
        seenInQueue = true;
        absentPolls = 0;
        // Pending means it has not started, and the timer must say so: billing a
        // run for the time it spent waiting in ComfyUI's queue is exactly the
        // number people use to judge how long a generation takes.
        if (q.state === 'running') markStarted();
      } else if (seenInQueue) {
        absentPolls += 1;
        if (absentPolls >= LOST_AFTER_POLLS) {
          const msg =
            'prompt was dropped from the ComfyUI queue (cleared or interrupted)';
          onEvent({ type: 'error', message: msg });
          throw new ComfyError(msg, { path: '/queue', kind: 'queue' });
        }
      }

      if (Date.now() - entered > 5000 && reportedQueue !== q.remaining) {
        reportedQueue = q.remaining;
        onEvent({ type: 'queue', remaining: q.remaining, position: q.position });
      }
      if (wsFailed) {
        // No live events - keep the UI honest with a heartbeat.
        onEvent({ type: 'poll', elapsedMs: Date.now() - entered });
      }
      await sleep(1000, signal);
    }
  }
}

// ~6s of consecutive absence. Long enough to ride out a queue swap or a slow
// /queue response, short enough that "cleared" is reported promptly.
const LOST_AFTER_POLLS = 6;

function normalize(msg, promptId) {
  switch (msg?.type) {
    case 'status':
      return {
        type: 'queue',
        remaining: msg?.data?.status?.exec_info?.queue_remaining ?? null,
      };
    case 'progress':
      return {
        type: 'progress',
        value: msg?.data?.value ?? 0,
        max: msg?.data?.max ?? 0,
        node: msg?.data?.node ?? null,
        promptId,
      };
    case 'executing':
      return { type: 'executing', node: msg?.data?.node ?? null, promptId };
    case 'execution_start':
    case 'execution_cached':
      return { type: 'exec-start', promptId };
    case 'execution_error':
      return {
        type: 'error',
        message: msg?.data?.exception_message ?? 'execution error',
        node: msg?.data?.node_id ?? null,
        detail: msg?.data ?? [],
      };
    case 'execution_interrupted':
      return { type: 'interrupted', promptId };
    default:
      return { type: msg?.type ?? 'unknown', promptId };
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 400);
  } catch {
    return '';
  }
}