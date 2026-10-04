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

export class AuthError extends ComfyError {
  constructor(path, body) {
    super('Authentication required.', { status: 401, body, path, kind: 'http' });
    this.name = 'AuthError';
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

    if (res.status === 401 && !this.#retriedAuth) {
      this.#retriedAuth = true;
      this.#refreshAuth();
      try {
        res = await doFetch();
      } finally {
        this.#retriedAuth = false;
      }
    }

    if (res.status === 401) throw new AuthError(pathname, await safeText(res));
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
    return this.getJson('/system_stats', opts);
  }

  async queueRemaining(opts = {}) {
    try {
      const q = await this.getJson('/queue', opts);
      return Array.isArray(q?.queue_running) ? q.queue_running.length : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Prompt ids currently queued, in submission order.
   *
   * /queue entries are POSITIONAL arrays, not objects:
   *   [number, prompt_id, prompt, extra_data, node_errors]
   * so the id lives at index 1. Reading `.prompt_id` off an entry silently
   * yields undefined, which is how a cleared queue looks identical to a full one.
   */
  async queuePromptIds(opts = {}) {
    try {
      const q = await this.getJson('/queue', opts);
      const read = (list) =>
        (Array.isArray(list) ? list : [])
          .map((e) => (Array.isArray(e) ? e[1] : e?.prompt_id))
          .filter(Boolean);
      return [...read(q?.queue_running), ...read(q?.queue_pending)];
    } catch {
      return null; // unknown - never let a failed probe look like an empty queue
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

  async history(promptId) {
    return this.getJson(`/history/${encodeURIComponent(promptId)}`);
  }

  async historyEntry(promptId) {
    const h = await this.history(promptId);
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
    const started = Date.now();
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
          onEvent({ type: 'done', outputs: entry.outputs ?? {}, status });
          return { outputs: entry.outputs ?? {}, status };
        }
        if (status.status_str === 'error') {
          const msg =
            status.messages?.find((m) => m[0] === 'execution_error')?.[1]?.exception_message ||
            'execution error';
          onEvent({ type: 'error', message: msg, detail: status.messages ?? [] });
          throw new ComfyError(msg, { path: '/history' });
        }
      }

      // Only judge the prompt lost once it has actually been seen queued, so a
      // brief /queue hiccup right after submit cannot fail a healthy run.
      const ids = await this.queuePromptIds();
      if (ids === null) {
        absentPolls = 0;
      } else if (ids.includes(promptId)) {
        seenInQueue = true;
        absentPolls = 0;
      } else if (seenInQueue) {
        absentPolls += 1;
        if (absentPolls >= LOST_AFTER_POLLS) {
          const msg =
            'prompt was dropped from the ComfyUI queue (cleared or interrupted)';
          onEvent({ type: 'error', message: msg });
          throw new ComfyError(msg, { path: '/queue', kind: 'queue' });
        }
      }

      if (Date.now() - started > 5000 && reportedQueue !== (await this.queueRemaining())) {
        reportedQueue = await this.queueRemaining();
        onEvent({ type: 'queue', remaining: reportedQueue });
      }
      if (wsFailed) {
        // No live events - keep the UI honest with a heartbeat.
        onEvent({ type: 'poll', elapsedMs: Date.now() - started });
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