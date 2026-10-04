import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
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
import { listEntries, findEntry, clearIndex } from './lib/gallery.js';
import { runner } from './lib/runner.js';
import { downloadImage, uniquePath, renderTemplate, sanitizeFilename } from './lib/download.js';

const ROOT = process.env.MOBILE_CFY_ROOT || process.cwd();
init(ROOT);
const P = paths();
for (const dir of [P.dataDir, P.uploads]) ensureDir(dir);

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
  const pubRoot = path.join(P.root, 'public');
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

route('GET', '/api/health', async (req, res) => {
  const client = new ComfyClient();
  const body = {
    ok: true,
    server: { root: P.root },
    token: { configured: client.hasToken, source: path.basename(envFilePath()) },
    comfy: { host: config().comfy.host, port: config().comfy.port, state: 'unknown' },
    downloadDir: { path: P.downloadDir, exists: fs.existsSync(P.downloadDir) },
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
    resolved: { downloadDir: paths().downloadDir, workflow: paths().workflow },
  });
});

route('POST', '/api/config/validate', async (req, res) => {
  const bindings = validateBindings(state.config.bindings);
  json(res, 200, { bindings, ok: bindings.every((b) => b.ok) });
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

route('GET', '/api/workflow', async (req, res) => {
  try {
    const wf = JSON.parse(fs.readFileSync(P.workflow, 'utf8'));
    json(res, 200, { workflow: wf, path: P.workflow });
  } catch (e) {
    json(res, 500, { error: `cannot read ${P.workflow}: ${e.message}` });
  }
});

route('PUT', '/api/workflow', async (req, res) => {
  const body = await readJson(req);
  const wf = body.workflow ?? body;
  if (!wf || typeof wf !== 'object' || Array.isArray(wf)) {
    return json(res, 400, { error: 'workflow must be a JSON object of nodeId -> node' });
  }
  const tmp = `${P.workflow}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(wf, null, 2), 'utf8');
  fs.renameSync(tmp, P.workflow);
  json(res, 200, { saved: true, nodes: Object.keys(wf).length });
});

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

route('POST', '/api/generate', async (req, res) => {
  // Refuse up front if a binding points at a node the workflow no longer has.
  // Without this the job is accepted, sits in the queue, and every run fails the
  // same cryptic "node 43 is not in the workflow" - which is how a stale node id
  // saved in Settings can go unnoticed for days. Failing here names the setting.
  const broken = validateBindings(state.config.bindings).filter((b) => !b.ok);
  if (broken.length) {
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
  const job = runner.enqueue(await readJson(req));
  json(res, 202, job);
});

route('GET', '/api/jobs', async (req, res) => json(res, 200, { jobs: runner.list().slice(-20) }));

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
  // Replay current state so a page that just loaded is not blind until the next
  // update - several jobs can be in flight and each only emits when it changes.
  for (const snap of runner.list()) send(snap);
  const onUpdate = (snap) => send(snap);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  ping.unref?.();
  const cleanup = () => {
    clearInterval(ping);
    runner.off('update', onUpdate);
  };
  runner.on('update', onUpdate);
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
    json(res, 200, saved);
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

route('DELETE', '/api/gallery', async (req, res) => {
  const cleared = clearIndex();
  json(res, 200, { cleared: cleared.length });
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

export function validateBindings(bindings) {
  let wf;
  try {
    wf = JSON.parse(fs.readFileSync(P.workflow, 'utf8'));
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
  if (bad.length) {
    console.warn(`  ⚠ ${bad.length} binding problem(s):`);
    for (const b of bad) console.warn(`     ${b.binding}${b.slot ? ` #${b.slot}` : ''}: ${b.reason}`);
  }
});

process.on('SIGINT', () => {
  console.log('\nbye');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
});

export { server, routes, route, json, readBody, readJson, renderTemplate, uniquePath };