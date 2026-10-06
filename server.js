import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  init,
  config,
  state,
  paths,
  ensureDir,
  getToken,
  envFilePath,
  reloadEnv,
  saveConfig,
  DEFAULTS,
  resolveFrom,
} from './lib/config.js';
import { ComfyClient, AuthError, mimeFor } from './lib/comfy.js';
import { parseMultipart } from './lib/multipart.js';
import { saveUpload, findUpload, listUploads, sniffImage } from './lib/uploads.js';
import * as history from './lib/history.js';
import { listEntries, findEntry, clearIndex, updateEntry, missingDownloads } from './lib/gallery.js';
import { runner } from './lib/runner.js';
import { sweep as sweepDownloadsNow, startRetryTicker } from './lib/retry.js';
import { downloadImage, uniquePath, renderTemplate, sanitizeFilename } from './lib/download.js';
import { isSameHost } from './lib/shutdown.js';

const ROOT = process.env.MOBILE_CFY_ROOT || process.cwd();
init(ROOT);
const P = paths();
for (const dir of [P.dataDir, P.uploads]) ensureDir(dir);

// Where the code lives, which is NOT where the data lives. ROOT is configurable
// so the workflows, history and downloads can be kept elsewhere; the web page is
// part of the app itself, so it is served from next to server.js and not from the
// data root - otherwise pointing MOBILE_CFY_ROOT anywhere but the checkout turned
// the whole UI into a 404.
const APP_DIR = path.dirname(fileURLToPath(import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
};

// ----------------------------------------------------------------- plumbing

const json = (res, status, obj, headers) => {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(body);
};

async function readBody(req, limit = 64 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (e) {
    throw Object.assign(new Error(`invalid JSON body: ${e.message}`), { status: 400 });
  }
}

function serveFile(req, res, file, { download = false } = {}) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return json(res, 404, { error: 'not found' });
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || mimeFor(file),
      'Content-Length': st.size,
      'Cache-Control': download ? 'no-store' : 'private, max-age=86400',
      ...(download ? { 'Content-Disposition': `attachment; filename="${sanitizeFilename(path.basename(file))}"` } : {}),
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const pubRoot = path.join(APP_DIR, 'public');
  const target = path.join(pubRoot, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!target.startsWith(pubRoot)) return json(res, 403, { error: 'forbidden' });
  fs.readFile(target, (err, data) => {
    if (err) {
      if (!path.extname(target)) {
        return fs.readFile(path.join(pubRoot, 'index.html'), (e2, html) => {
          if (e2) return json(res, 404, { error: 'not found' });
          res.writeHead(200, { 'Content-Type': MIME['.html'] });
          res.end(html);
        });
      }
      return json(res, 404, { error: 'not found' });
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

// ------------------------------------------------------------------- routes

// [{ method, segs: ['api','jobs',':id'], handler }] - ':name' captures a segment.
const routes = [];
const route = (method, pathname, handler) =>
  routes.push({ method, segs: pathname.split('/').filter(Boolean), handler });

function matchRoute(method, pathname) {
  const segs = pathname.split('/').filter(Boolean);
  const m = method === 'HEAD' ? 'GET' : method;
  for (const r of routes) {
    if (r.method !== m) continue;
    if (r.segs.length !== segs.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < segs.length; i++) {
      const pat = r.segs[i];
      if (pat.startsWith(':')) params[pat.slice(1)] = decodeURIComponent(segs[i]);
      else if (pat !== segs[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { handler: r.handler, params };
  }
  return null;
}

/**
 * Try to put back result images whose download failed. Fire-and-forget by design:
 * every caller of this has already answered the user, and a slow sweep must not
 * hold up the reply that said "resumed" or "handed over".
 */
function sweepDownloads({ force = false } = {}) {
  if (!missingDownloads().length) return null;
  return sweepDownloadsNow({ client: new ComfyClient(), force })
    .then((report) => {
      if (report.recovered || report.gone) console.log(`[retry] ${JSON.stringify(report)}`);
      return report;
    })
    .catch((e) => {
      console.warn(`[retry] sweep failed: ${e.message}`);
      return null;
    });
}

// A slow heartbeat for the fluke case: the network can come back without the user
// touching anything. It only does work when something is actually outstanding.
startRetryTicker(() => new ComfyClient());

route('GET', '/api/health', async (req, res) => {
  const client = new ComfyClient();
  const body = {
    ok: true,
    server: { root: P.root },
    token: { configured: client.hasToken, source: path.basename(envFilePath()) },
    comfy: { host: config().comfy.host, port: config().comfy.port, state: 'unknown' },
    downloadDir: { path: P.downloadDir, exists: fs.existsSync(P.downloadDir) },
    // Carried here because this is the poll the page already makes: it is how
    // the UI learns that a queue paused for the network is worth resuming again.
    queue: runner.queueState(),
  };
  if (!client.hasToken) body.comfy.state = 'no-token';
  else {
    try {
      const stats = await client.systemStats({ timeoutMs: 8000 });
      body.comfy.state = 'ok';
      body.comfy.info = {
        comfyui: stats?.system?.comfyui_version,
        devices: (stats?.devices ?? []).map((d) => d.name),
      };
    } catch (e) {
      body.comfy.state = e instanceof AuthError || e.status === 401 ? 'unauthorized' : 'unreachable';
      body.comfy.error = e.message;
    }
  }
  json(res, 200, body);
});

route('POST', '/api/auth/reload', async (req, res) => {
  const env = reloadEnv();
  const tok = getToken();
  // The runner holds a client built at construction time.
  runner.resetClient();
  json(res, 200, {
    reloaded: true,
    file: envFilePath(),
    tokenConfigured: Boolean(tok),
    keys: Object.keys(env),
  });
});

route('GET', '/api/config', async (req, res) => {
  json(res, 200, {
    config: state.config,
    defaults: DEFAULTS,
    envFile: envFilePath(),
    resolved: {
      workflow: P.workflow,
      upscaleWorkflow: P.upscaleWorkflow,
      downloadDir: P.downloadDir,
      dataDir: P.dataDir,
    },
  });
});

route('PUT', '/api/config', async (req, res) => {
  const patch = await readJson(req);
  delete patch.server; // rebinding the listener needs a restart
  const saved = saveConfig(patch);
  json(res, 200, {
    config: saved,
    // Names the server does not recognise are dropped on purpose (see
    // mergeConfig). Report them so the UI can say so instead of showing a
    // cheerful "saved" next to a binding that never took effect.
    staleBindings: saved.staleBindings ?? [],
    resolved: {
      downloadDir: paths().downloadDir,
      workflow: paths().workflow,
      upscaleWorkflow: paths().upscaleWorkflow,
    },
  });
});

route('POST', '/api/config/bindings/reset', async (req, res) => {
  // Put every binding back to what this build ships with.
  //
  // The startup migrations only upgrade values they RECOGNISE, so a row edited by
  // hand (node id changed, input name left behind) stays broken on purpose and
  // needs a way back. This is that way back, and it reports what it restored so a
  // workflow the server cannot read is visible immediately rather than after the
  // next run fails. `kind` picks which map: the two point at different files.
  const body = await readJson(req);
  const upscale = body?.kind === 'upscale';
  const saved = saveConfig(
    upscale
      ? { upscaleBindings: structuredClone(DEFAULTS.upscaleBindings) }
      : { bindings: structuredClone(DEFAULTS.bindings) },
  );
  const bindings = upscale
    ? validateBindings(saved.upscaleBindings, P.upscaleWorkflow)
    : validateBindings(saved.bindings);
  json(res, 200, {
    config: saved,
    kind: upscale ? 'upscale' : 'generate',
    bindings,
    ok: bindings.every((b) => b.ok),
    staleBindings: saved.staleBindings ?? [],
    staleUpscaleBindings: saved.staleUpscaleBindings ?? [],
  });
});

route('POST', '/api/config/validate', async (req, res) => {
  const body = await readJson(req);
  const upscale = body?.kind === 'upscale';
  const bindings = upscale
    ? validateBindings(state.config.upscaleBindings, P.upscaleWorkflow)
    : validateBindings(state.config.bindings);
  json(res, 200, { kind: upscale ? 'upscale' : 'generate', bindings, ok: bindings.every((b) => b.ok) });
});

route('POST', '/api/paths/check', async (req, res) => {
  const { dir } = await readJson(req);
  const target = resolveFrom(P.root, dir || config().downloadDir);
  const exists = fs.existsSync(target);
  let writable = false;
  if (exists) {
    try {
      fs.accessSync(target, fs.constants.W_OK);
      writable = true;
    } catch {
      writable = false;
    }
  }
  json(res, 200, { dir: target, exists, writable, isSharedStorage: /storage[\\/]downloads/i.test(target) });
});

// Both workflows can be read and replaced from Settings. Same handler twice,
// different file: the route table needs them apart, the code does not.
function readWorkflowRoute(file) {
  return async (req, res) => {
    try {
      const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
      json(res, 200, { workflow: wf, path: file });
    } catch (e) {
      json(res, 500, { error: `cannot read ${file}: ${e.message}` });
    }
  };
}

function writeWorkflowRoute(file) {
  return async (req, res) => {
    const body = await readJson(req);
    const wf = body.workflow ?? body;
    if (!wf || typeof wf !== 'object' || Array.isArray(wf)) {
      return json(res, 400, { error: 'workflow must be a JSON object of nodeId -> node' });
    }
    // Written to a temp file and renamed, so a failure halfway through cannot
    // leave a half-written graph that every later run reads as missing nodes.
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(wf, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    json(res, 200, { saved: true, nodes: Object.keys(wf).length });
  };
}

route('GET', '/api/workflow', readWorkflowRoute(paths().workflow));
route('PUT', '/api/workflow', writeWorkflowRoute(paths().workflow));
route('GET', '/api/upscale/workflow', readWorkflowRoute(paths().upscaleWorkflow));
route('PUT', '/api/upscale/workflow', writeWorkflowRoute(paths().upscaleWorkflow));

route('POST', '/api/uploads', async (req, res) => {
  const buf = await readBody(req);
  const parts = parseMultipart(buf, req.headers['content-type'] ?? '');
  const max = config().maxImages;
  const saved = [];
  for (const p of parts.filter((x) => x.filename || x.data.length)) {
    // Trust the bytes, not the header: a phone picker can send any Content-Type,
    // and LoadImage dispatches on the extension we end up storing.
    if (!/^image\//i.test(p.contentType) && !/\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(p.filename) && !sniffImage(p.data)) {
      continue;
    }
    if (saved.length >= max) break;
    saved.push(saveUpload(p.data, p.filename, p.contentType));
  }
  if (!saved.length) return json(res, 400, { error: 'no image parts in the upload' });
  json(res, 200, { uploads: saved });
});

route('GET', '/api/uploads/:id', async (req, res, url, { id }) => {
  const row = findUpload(id);
  if (!row) return json(res, 404, { error: 'unknown upload' });
  serveFile(req, res, path.join(P.uploads, row.file));
});

route('GET', '/api/uploads', async (req, res) => json(res, 200, { uploads: listUploads() }));

/**
 * Refuse a job whose bindings point at nodes the workflow no longer has.
 *
 * Without this the job is accepted, sits in the queue, and every run fails the
 * same cryptic "node 43 is not in the workflow" - which is how a stale node id
 * saved in Settings can go unnoticed for days. Failing here names the setting.
 */
function bindingGuard(bindings, workflowFile) {
  const broken = validateBindings(bindings, workflowFile).filter((b) => !b.ok);
  if (!broken.length) return;
  const err = new Error(
    `binding problem - fix it in Settings: ${broken
      .map((b) => `${b.binding}${b.slot ? ` #${b.slot}` : ''}: ${b.reason}`)
      .join('; ')}`,
  );
  err.status = 400;
  err.errors = broken.map((b) => b.reason);
  err.bindings = broken;
  throw err;
}

route('POST', '/api/generate', async (req, res) => {
  bindingGuard(state.config.bindings);
  // The kind is stamped here, not read from the body: this route runs the
  // generate graph and checks the generate bindings, so a body claiming to be an
  // upscale would otherwise slip past both.
  const job = runner.enqueue({ ...(await readJson(req)), kind: 'generate' });
  json(res, 202, job);
});

// The Upscale tab. Same queue, same progress, same gallery - only the workflow
// and the fields differ, so the route is the only place that has to know. The
// kind is stamped here rather than trusted from the body, and the pre-flight
// runs against upscale_api.json: the two graphs share no node ids, so a stale id
// in one must not be reported as missing from the other.
route('POST', '/api/upscale', async (req, res) => {
  bindingGuard(state.config.upscaleBindings, P.upscaleWorkflow);
  const body = await readJson(req);
  const job = runner.enqueue({ ...(body ?? {}), kind: 'upscale' });
  json(res, 202, job);
});

route('GET', '/api/jobs', async (req, res) =>
  json(res, 200, { jobs: runner.list().slice(-20), queue: runner.queueState() }),
);

// The queue is controllable: hold it when the phone is about to lose the
// network, resume when the network is back, and dump everything queued into
// ComfyUI itself so the work survives the phone walking away.
route('GET', '/api/queue', async (req, res) => json(res, 200, runner.queueState()));

route('POST', '/api/queue/pause', async (req, res) => json(res, 200, runner.pause('manual')));

route('POST', '/api/queue/resume', async (req, res) => {
  const state = runner.resume();
  // The connection is known good at this exact moment, which is the moment the
  // retry sweep is worth running.
  sweepDownloads();
  json(res, 200, state);
});

route('POST', '/api/queue/submit-all', async (req, res) => {
  const report = await runner.submitAll();
  sweepDownloads();
  json(res, 200, { ...report, queue: runner.queueState() });
});

route('GET', '/api/jobs/:id', async (req, res, url, { id }) => {
  const job = runner.get(id);
  return job ? json(res, 200, job) : json(res, 404, { error: 'unknown job' });
});

route('POST', '/api/jobs/:id/cancel', async (req, res, url, { id }) => {
  return runner.cancel(id) ? json(res, 200, { cancelled: true }) : json(res, 404, { error: 'unknown job' });
});

route('GET', '/api/jobs/:id/events', async (req, res, url, { id }) => {
  const job = runner.get(id);
  if (!job) return json(res, 404, { error: 'unknown job' });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (snap) => res.write(`data: ${JSON.stringify(snap)}\n\n`);
  send(job);
  const onUpdate = (snap) => {
    if (snap.id !== id) return;
    send(snap);
    if (['done', 'error', 'cancelled'].includes(snap.status)) {
      cleanup();
      res.end();
    }
  };
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  ping.unref?.();
  const cleanup = () => {
    clearInterval(ping);
    runner.off('update', onUpdate);
  };
  runner.on('update', onUpdate);
  req.on('close', cleanup);
  if (['done', 'error', 'cancelled'].includes(job.status)) {
    cleanup();
    res.end();
  }
});

route('GET', '/api/events', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (snap) => res.write(`data: ${JSON.stringify(snap)}\n\n`);
  // The queue's own state travels as a tagged message: a paused queue changes
  // nothing about any job, so without this the pause button would only learn
  // about it on the next poll. It goes FIRST, because "is the queue held?" is
  // what the client needs before it can make sense of any job snapshot.
  send({ type: 'queue', queue: runner.queueState() });
  // Replay current state so a page that just loaded is not blind until the next
  // update - several jobs can be in flight and each only emits when it changes.
  for (const snap of runner.list()) send(snap);
  const onUpdate = (snap) => send(snap);
  const onQueue = (queue) => send({ type: 'queue', queue });
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  ping.unref?.();
  const cleanup = () => {
    clearInterval(ping);
    runner.off('update', onUpdate);
    runner.off('queue', onQueue);
  };
  runner.on('update', onUpdate);
  runner.on('queue', onQueue);
  req.on('close', cleanup);
});

route('GET', '/api/gallery', async (req, res, url) => {
  const limit = Number(url.searchParams.get('limit') ?? 200) || 200;
  json(res, 200, { images: listEntries({ limit }) });
});

route('GET', '/api/gallery/:id/file', async (req, res, url, { id }) => {
  const entry = findEntry(id);
  if (!entry) return json(res, 404, { error: 'unknown image' });
  if (entry.localPath && fs.existsSync(entry.localPath)) return serveFile(req, res, entry.localPath);
  // No local copy (downloads were off, or the folder changed) - stream from ComfyUI.
  try {
    const client = new ComfyClient();
    const buf = await client.viewImage({
      filename: entry.comfyFilename,
      subfolder: entry.subfolder,
      type: entry.type,
    });
    res.writeHead(200, { 'Content-Type': mimeFor(entry.comfyFilename), 'Content-Length': buf.length });
    res.end(buf);
  } catch (e) {
    json(res, 502, { error: `not on disk and ComfyUI could not serve it: ${e.message}` });
  }
});

route('POST', '/api/gallery/retry', async (req, res) => {
  const report = await sweepDownloadsNow({ client: new ComfyClient(), force: true });
  json(res, 200, { ...report, pending: missingDownloads().length });
});

route('POST', '/api/gallery/:id/save', async (req, res, url, { id }) => {
  const entry = findEntry(id);
  if (!entry) return json(res, 404, { error: 'unknown image' });
  const body = await readJson(req).catch(() => ({}));
  const dir = resolveFrom(P.root, body.dir || config().downloadDir);
  ensureDir(dir);
  try {
    const saved = await downloadImage(new ComfyClient(), {
      filename: entry.comfyFilename,
      subfolder: entry.subfolder,
      type: entry.type,
    }, {
      dir,
      template: body.template ?? config().filenameTemplate,
      ctx: { prompt: entry.prompt, seed: entry.seed, node: entry.node },
    });
    // Record it. Hand-fetching an image and leaving `localPath` null is exactly
    // the desync this feature exists to remove, so the escape hatch has to close
    // it too - otherwise the file is on disk and the index still says otherwise.
    updateEntry(entry.id, { localPath: saved.path, localName: saved.name, bytes: saved.bytes, retry: null });
    json(res, 200, saved);
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

route('DELETE', '/api/gallery', async (req, res) => {
  const cleared = clearIndex();
  json(res, 200, { cleared: cleared.length });
});

// ------------------------------------------------------------------ shutdown

route('POST', '/api/shutdown', async (req, res) => {
  const port = config().server.port;
  if (!isSameHost(req)) {
    return json(res, 403, {
      error: `the shut down button only works from the phone - open the UI at http://127.0.0.1:${port}`,
    });
  }
  if (stopping) return json(res, 200, { ok: true, stopping: true, already: true });

  // Set BEFORE the optional handover: that await is a long pause in which a
  // double tap would otherwise start a second handover and a second exit.
  stopping = true;

  const body = await readJson(req);
  const q = runner.queueState();
  const jobs = runner.list();

  // Handing the queue over first is optional and never blocks the shutdown: if
  // ComfyUI is gone the handover fails, the failure is reported in the reply the
  // user already sees, and the server still stops.
  let handover = null;
  if (body?.handover === true) {
    handover = await runner.submitAll();
    sweepDownloads();
  }

  const inFlight = jobs.filter((j) => ['queued', 'running', 'paused'].includes(j.status));
  const summary = {
    ok: true,
    stopping: true,
    reason: 'web ui',
    at: new Date().toISOString(),
    jobs: inFlight.map((j) => ({
      id: j.id,
      status: j.status,
      runs: (j.runs ?? []).length,
      atComfy: (j.runs ?? []).filter((r) => r.promptId).length,
    })),
    queue: runner.queueState(),
    handover,
  };
  console.log(
    `[server] shutting down on request from ${req.socket?.remoteAddress ?? 'unknown'}` +
    ` (${inFlight.length} job(s) in flight${handover ? `, handed ${handover.runs} run(s) over` : ''})`
  );

  // Answer first, leave second. The page polls for the socket to stop answering,
  // so the exit has to happen after this reply is actually on the wire - not
  // after the handler returns, which is not the same thing.
  res.once('finish', () => shutDown('web ui'));
  json(res, 200, summary);
});

// ------------------------------------------------------------------- history

route('GET', '/api/history', async (req, res, url) => {
  const limit = Number(url.searchParams.get('limit') ?? 100) || 100;
  json(res, 200, { entries: history.list({ limit }) });
});

route('DELETE', '/api/history', async (req, res) => {
  const cleared = history.clear();
  json(res, 200, { cleared: cleared.length });
});

route('DELETE', '/api/history/:id', async (req, res, url, { id }) => {
  const removed = history.remove(id);
  json(res, removed ? 200 : 404, removed ? { removed: true } : { error: 'unknown history entry' });
});

// ------------------------------------------------------------ binding check

/**
 * Check every binding against the workflow it actually points at.
 *
 * `workflowFile` defaults to the generate graph; the Upscale tab's bindings are
 * checked against upscale_api.json, which shares no node ids with it, so passing
 * the wrong file here would report everything as missing.
 */
export function validateBindings(bindings, workflowFile = P.workflow) {
  let wf;
  try {
    wf = JSON.parse(fs.readFileSync(workflowFile, 'utf8'));
  } catch (e) {
    return [{ binding: '*', ok: false, reason: `cannot read workflow: ${e.message}` }];
  }
  const out = [];
  const check = (key, b, slot) => {
    if (b === null) return out.push({ binding: key, slot, ok: true, disabled: true, title: null });
    if (!b || b.node === undefined || b.node === null || b.node === '') {
      return out.push({ binding: key, slot, ok: true, disabled: true, title: null });
    }
    const nodeId = String(b.node);
    const node = wf[nodeId];
    if (!node) {
      return out.push({ binding: key, slot, ok: false, reason: `node ${nodeId} is not in the workflow`, nodeId });
    }
    const title = node._meta?.title ?? null;
    if (!node.inputs || !(b.input in node.inputs)) {
      return out.push({
        binding: key,
        slot,
        ok: false,
        nodeId,
        title,
        reason: `node ${nodeId} (${node.class_type}) has no input "${b.input}"`,
      });
    }
    out.push({ binding: key, slot, ok: true, nodeId, title, classType: node.class_type });
  };
  for (const [key, value] of Object.entries(bindings ?? {})) {
    if (key === 'images') {
      (value ?? []).forEach((b, i) => check(key, b, i + 1));
    } else {
      check(key, value, null);
    }
  }
  return out;
}

// ------------------------------------------------------------------- server

// Set the moment a shutdown is accepted. A second press gets an answer instead
// of queueing a second exit.
let stopping = false;
// Separate from `stopping` on purpose: the shutdown route sets `stopping` long
// before the reply is on the wire, so a guard that reads it would decide the
// exit had already happened and never leave.
let exiting = false;

/**
 * Leave. Nothing is drained first: the SSE stream and the keep-alive sockets to
 * ComfyUI would keep the process alive for ever, and `server.close()` on top of
 * `process.exit()` is what trips libuv's `UV_HANDLE_CLOSING` assertion on
 * Windows - the same handle gets closed twice. So the exit is one timer, and the
 * reply that asked for it has long since been on the wire. start.sh is `wait`ing
 * on this pid, so its EXIT trap releases the wake lock and removes .server.pid.
 */
function shutDown(reason = 'signal') {
  if (exiting) return;
  exiting = true;
  console.log(`\nbye (${reason})`);
  process.exitCode = 0;
  setTimeout(() => process.exit(0), 300).unref();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const hit = matchRoute(req.method, url.pathname);
  try {
    if (hit) return await hit.handler(req, res, url, hit.params);
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, url.pathname);
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error('[server]', req.method, url.pathname, e);
    if (!res.headersSent) {
      json(res, status, {
        error: e.message,
        ...(e.errors ? { errors: e.errors } : {}),
        ...(e.bindings ? { bindings: e.bindings } : {}),
      });
    }
  }
});

const c = config();
server.listen(c.server.port, c.server.host, () => {
  console.log(`mobile-cfy  http://${c.server.host}:${c.server.port}`);
  console.log(`  comfyui    http://${c.comfy.host}:${c.comfy.port}   token ${getToken() ? 'configured' : 'MISSING'}`);
  console.log(`  auth env   ${envFilePath()}`);
  console.log(`  downloads  ${P.downloadDir}${fs.existsSync(P.downloadDir) ? '' : '  (created on first run)'}`);
  const bad = validateBindings(c.bindings).filter((r) => !r.ok);
  // Warn about both, tagged, because the two files share no node ids and a
  // broken upscale binding would otherwise be reported as a missing node in a
  // graph that does not contain it.
  const upBad = fs.existsSync(P.upscaleWorkflow)
    ? validateBindings(c.upscaleBindings, P.upscaleWorkflow).filter((r) => !r.ok)
    : [];
  for (const [label, list] of [['binding', bad], ['upscale binding', upBad]]) {
    if (!list.length) continue;
    console.warn(`  ⚠ ${list.length} ${label} problem(s):`);
    for (const b of list) console.warn(`     ${b.binding}${b.slot ? ` #${b.slot}` : ''}: ${b.reason}`);
  }
});

process.on('SIGINT', () => shutDown('SIGINT'));
// stop.sh sends SIGTERM. It used to kill the process outright, which skipped
// start.sh's chance to tidy up the same way a Ctrl-C did.
process.on('SIGTERM', () => shutDown('SIGTERM'));

export { server, routes, route, json, readBody, readJson, renderTemplate, uniquePath, shutDown };