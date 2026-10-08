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
import { ComfyClient, comfyHealth, mimeFor } from './lib/comfy.js';
import { parseMultipart } from './lib/multipart.js';
import { saveUpload, findUpload, listUploads, sniffImage } from './lib/uploads.js';
import * as history from './lib/history.js';
import { listEntries, findEntry, clearIndex, updateEntry, missingDownloads } from './lib/gallery.js';
import { runner } from './lib/runner.js';
import { sweep as sweepDownloadsNow, startRetryTicker } from './lib/retry.js';
import { readCounter } from './lib/spritecounter.js';
import { downloadImage, uniquePath, renderTemplate, sanitizeFilename } from './lib/download.js';
import { shutdownPermission } from './lib/shutdown.js';

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
  json(res, 200, {
    ok: true,
    server: { root: P.root },
    token: { configured: client.hasToken, source: path.basename(envFilePath()) },
    // Classified, with a hint: "unreachable" alone sent people looking in the
    // wrong place when the real fault was a login page or a pasted scheme.
    comfy: await comfyHealth(client),
    // Whether this page is even allowed to press the shut down button. It rides
    // the poll the page already makes, so the button can say why it will be
    // refused instead of finding out by being pressed.
    shutdown: shutdownVerdict(req),
    downloadDir: { path: P.downloadDir, exists: fs.existsSync(P.downloadDir) },
    // Carried here because this is the poll the page already makes: it is how
    // the UI learns that a queue paused for the network is worth resuming again.
    queue: runner.queueState(),
    // The trace of the last async error that would have killed an unguarded
    // process (see reportFatal). null until something actually fires.
    fatal: lastFatal,
  });
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
      enhancelessWorkflow: P.enhancelessWorkflow,
      upscaleWorkflow: P.upscaleWorkflow,
      spriteWorkflow: P.spriteWorkflow,
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
    // cheerful "saved" next to a binding that never took effect. One report per
    // map: an unknown name in the enhanceless map is a different fix than the
    // same name in the normal one.
    staleBindings: saved.staleBindings ?? [],
    staleUpscaleBindings: saved.staleUpscaleBindings ?? [],
    staleEnhancelessBindings: saved.staleEnhancelessBindings ?? [],
    staleSpriteBindings: saved.staleSpriteBindings ?? [],
    resolved: {
      downloadDir: paths().downloadDir,
      workflow: paths().workflow,
      enhancelessWorkflow: paths().enhancelessWorkflow,
      upscaleWorkflow: paths().upscaleWorkflow,
      spriteWorkflow: paths().spriteWorkflow,
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
  // next run fails. `kind` picks which map: the three point at different files.
  const body = await readJson(req);
  const kind = bindingKind(body?.kind);
  const saved = saveConfig({ [kind.map]: structuredClone(DEFAULTS[kind.map]) });
  const bindings = validateBindings(saved[kind.map], kind.file());
  json(res, 200, {
    config: saved,
    kind: body?.kind === 'upscale' || body?.kind === 'enhanceless' || body?.kind === 'sprite' ? body.kind : 'generate',
    bindings,
    ok: bindings.every((b) => b.ok),
    staleBindings: saved.staleBindings ?? [],
    staleUpscaleBindings: saved.staleUpscaleBindings ?? [],
    staleEnhancelessBindings: saved.staleEnhancelessBindings ?? [],
    staleSpriteBindings: saved.staleSpriteBindings ?? [],
  });
});

route('POST', '/api/config/validate', async (req, res) => {
  const body = await readJson(req);
  const kind = bindingKind(body?.kind);
  const bindings = validateBindings(state.config[kind.map], kind.file());
  json(res, 200, {
    kind: body?.kind === 'upscale' || body?.kind === 'enhanceless' || body?.kind === 'sprite' ? body.kind : 'generate',
    bindings,
    ok: bindings.every((b) => b.ok),
  });
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
route('GET', '/api/enhanceless/workflow', readWorkflowRoute(paths().enhancelessWorkflow));
route('PUT', '/api/enhanceless/workflow', writeWorkflowRoute(paths().enhancelessWorkflow));
route('GET', '/api/upscale/workflow', readWorkflowRoute(paths().upscaleWorkflow));
route('PUT', '/api/upscale/workflow', writeWorkflowRoute(paths().upscaleWorkflow));
route('GET', '/api/sprite/workflow', readWorkflowRoute(paths().spriteWorkflow));
route('PUT', '/api/sprite/workflow', writeWorkflowRoute(paths().spriteWorkflow));
// What the NEXT sprite job will number its files with, so the form can say so
// before submitting. Read-only - the claim happens inside enqueue, after
// validation, and a peek that reserved a number would leak one per page load.
route('GET', '/api/sprite/counter', async (req, res) => json(res, 200, { next: readCounter() }));

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

/**
 * One `kind` -> the binding map, the workflow file and the Settings label that
 * go together. Three graphs, so three answers, looked up in exactly one place: a
 * validate, a reset and a generate pre-flight that disagreed about which file a
 * kind means would report "missing node" against the wrong graph.
 */
const BINDING_KINDS = {
  generate: { map: 'bindings', file: () => P.workflow, label: 'Generate' },
  enhanceless: { map: 'enhancelessBindings', file: () => P.enhancelessWorkflow, label: 'Enhanceless' },
  upscale: { map: 'upscaleBindings', file: () => P.upscaleWorkflow, label: 'Upscale' },
  sprite: { map: 'spriteBindings', file: () => P.spriteWorkflow, label: 'Sprite' },
};
function bindingKind(kind) {
  return BINDING_KINDS[kind] ?? BINDING_KINDS.generate;
}

route('POST', '/api/generate', async (req, res) => {
  // Read the body BEFORE guarding: with the enhanceless workflow, promptEnhance
  // picks which graph the job runs on, so it must also pick which bindings get
  // checked. Guarding the normal map while the runner builds the enhanceless
  // graph would validate nodes that file does not have and refuse every job.
  const body = await readJson(req);
  const kind = bindingKind(body?.promptEnhance === false ? 'enhanceless' : 'generate');
  bindingGuard(state.config[kind.map], kind.file());
  // The kind is stamped here, not read from the body: this route runs the
  // generate graph and checks the generate bindings, so a body claiming to be an
  // upscale would otherwise slip past both.
  const job = runner.enqueue({ ...(body ?? {}), kind: 'generate' });
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

// The Sprite tab. Third graph, third map, same queue - the pre-flight checks
// sprite_api.json because the three graphs share no node ids, so a stale id
// saved in one must not be reported as missing from another. The Filename
// Counter is claimed inside enqueue, after validation, so a refused request
// never burns a number.
route('POST', '/api/sprite', async (req, res) => {
  bindingGuard(state.config.spriteBindings, P.spriteWorkflow);
  const body = await readJson(req);
  const job = runner.enqueue({ ...(body ?? {}), kind: 'sprite' });
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
  // Awaited: the resume reconciles with ComfyUI first (collect what finished
  // while we were away, adopt what is already queued) and only then starts
  // submitting, so the state handed back here is the post-resync one.
  const state = await runner.resume();
  // The connection is known good at this exact moment, which is the moment the
  // retry sweep is worth running.
  sweepDownloads();
  json(res, 200, state);
});

// Reorder the queue: the selected item's row has no buttons of its own, the
// selection bar does, and both arrows land here.
route('POST', '/api/queue/move', async (req, res) => {
  const body = await readJson(req);
  const id = typeof body?.id === 'string' ? body.id : null;
  const delta = Number(body?.delta);
  if (!id || !Number.isFinite(delta) || delta === 0) {
    return json(res, 400, { error: 'id and a non-zero delta are required' });
  }
  if (!runner.move(id, delta)) {
    return json(res, 404, { error: 'that job is not waiting in the queue' });
  }
  json(res, 200, { queue: runner.queueState(), jobs: runner.list() });
});

// Reconcile on demand: what the reconnect does on its own, callable by hand
// (and by the page when it opens against a queue that was restored from disk).
route('POST', '/api/queue/resync', async (req, res) => {
  const report = await runner.resync();
  json(res, 200, { resync: report, queue: runner.queueState(), jobs: runner.list() });
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
  // A write into a socket the phone dropped mid-stream surfaces as an 'error'
  // event on the response. With no listener Node treats it as fatal - which is
  // how a network blip could take the whole server down behind a resume press.
  res.on('error', cleanup);
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
  // Same guard as the job stream: a dead socket must cost one listener, not
  // the process.
  res.on('error', cleanup);
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

/**
 * The verdict the page is given about its own right to press the button, in a
 * shape it can print. The POST below answers with the same thing, so the reason
 * the modal shows before the press and the error it shows after it can never
 * disagree.
 */
function shutdownVerdict(req) {
  const p = shutdownPermission(req);
  const port = config().server.port;
  return p.allowed
    ? { ...p, error: null }
    : {
        ...p,
        error:
          `the shut down button only works from the phone, and ${p.because}. ` +
          `Open the UI at http://127.0.0.1:${port} and press it there, ` +
          `or start the server with MOBILE_CFY_ALLOW_REMOTE_SHUTDOWN=1 to allow it from anywhere`,
      };
}

route('POST', '/api/shutdown', async (req, res) => {
  const verdict = shutdownVerdict(req);
  if (!verdict.allowed) return json(res, 403, { error: verdict.error, shutdown: verdict });
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
 * The last async error that reached a process-level handler.
 *
 * Kept for /api/health: when something fatal enough to need these handlers
 * fires, the console line is the only trace it leaves, and on a phone that
 * trace scrolls away. The health report carries the message and stack so
 * "the server went down" is answerable from the UI, not just from a log file
 * that a restart may have truncated.
 */
let lastFatal = null;

function reportFatal(kind, e) {
  const stack = e instanceof Error ? (e.stack || String(e)) : String(e);
  lastFatal = { kind, at: new Date().toISOString(), message: e?.message ?? String(e), stack };
  // Both streams on purpose: stdout and stderr go to different files depending
  // on how the server was started (server.log vs server.err, or a Termux
  // terminal with no redirect at all), and a crash report in the wrong one is
  // a crash report nobody finds.
  console.error(`[fatal] ${kind}:`, stack);
  console.log(`[fatal] ${kind}: ${e?.message ?? e}`);
}

/**
 * Node kills the process on any async error nobody awaited: a floating
 * promise, a stream callback, a timer that threw. That is exactly the class of
 * bug that made "press resume, server gone, logs empty" undiagnosable - the
 * stack went to stderr, the operator restarted (truncating it), and the queue
 * vanished with the process. For a long-running single-user server the state
 * is worth more than Node's default purity: every job path already has its own
 * try/catch, the queue is on disk, so these handlers log loudly and let the
 * server keep serving instead of dying silently.
 */
process.on('unhandledRejection', (e) => reportFatal('unhandledRejection', e));
process.on('uncaughtException', (e) => reportFatal('uncaughtException', e));

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
  // The queue's last write is debounced, and there is no time left to wait for
  // it. Writing it synchronously here is what makes "shut the server down and
  // start it again" safe: without it, a job queued in the last 300ms of the
  // process's life would be the one job that did not survive.
  runner.flushNow();
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
  // Inside the callback, on purpose: a queue left on disk by a previous run is
  // put back and started only once the port is actually open, so the first
  // client to connect sees the whole queue rather than a half-restored one, and
  // a typo in the config cannot start a generation before anybody can reach the
  // server to cancel it.
  runner.restore();
  console.log(`mobile-cfy  http://${c.server.host}:${c.server.port}`);
  console.log(`  comfyui    http://${c.comfy.host}:${c.comfy.port}   token ${getToken() ? 'configured' : 'MISSING'}`);
  console.log(`  auth env   ${envFilePath()}`);
  console.log(`  downloads  ${P.downloadDir}${fs.existsSync(P.downloadDir) ? '' : '  (created on first run)'}`);
  const bad = validateBindings(c.bindings).filter((r) => !r.ok);
  // Warn about all three, tagged, because the files are different graphs: a
  // broken enhanceless binding would otherwise be reported as a missing node in
  // a graph that does not contain it (and vice versa).
  const enBad = fs.existsSync(P.enhancelessWorkflow)
    ? validateBindings(c.enhancelessBindings, P.enhancelessWorkflow).filter((r) => !r.ok)
    : [];
  const upBad = fs.existsSync(P.upscaleWorkflow)
    ? validateBindings(c.upscaleBindings, P.upscaleWorkflow).filter((r) => !r.ok)
    : [];
  const spBad = fs.existsSync(P.spriteWorkflow)
    ? validateBindings(c.spriteBindings, P.spriteWorkflow).filter((r) => !r.ok)
    : [];
  for (const [label, list] of [
    ['binding', bad],
    ['enhanceless binding', enBad],
    ['upscale binding', upBad],
    ['sprite binding', spBad],
  ]) {
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