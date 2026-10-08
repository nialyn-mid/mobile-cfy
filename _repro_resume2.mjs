// v2: exercise the resync SWEEP on resume (v1 never reached it - queued jobs
// have no promptId/fp, so the sweep returns before any HTTP).
// G: run submitted (promptId exists), pause, resume  -> sweep reads /queue+/history
// H: connection hold - ComfyUI stopped, resume       -> sweep readQueue fails
// I: huge /history                                     -> loadHistory path
// J: SSE open + RST racing the resume emit burst
// K: double-tap resume (two POSTs in flight)
// L: auth 401 from /queue during sweep
import { mkdtempSync, cpSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { startFakeComfyUI, sleep, waitFor } from './test/helpers/fakeComfy.js';

const ROOT = process.cwd();
const PORTS = [3091, 3092, 3093, 3094, 3095, 3096, 3097];

async function boot(port) {
  const root = mkdtempSync(path.join(tmpdir(), 'repro2-'));
  for (const f of ['workflow_api.json', 'workflow_api_enhanceless.json', 'upscale_api.json', 'sprite_api.json']) {
    cpSync(path.join(ROOT, f), path.join(root, f));
  }
  const comfy = await startFakeComfyUI({ mode: 'manual', saveNode: 8, textNode: 181 });
  writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    server: { host: '127.0.0.1', port },
    comfy: { host: '127.0.0.1', port: comfy.port, timeoutMs: 5000 },
    downloadDir: path.join(root, 'dl'),
    dataDir: path.join(root, 'data'),
  }, null, 2));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, MOBILE_CFY_ROOT: root },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  let alive = true;
  child.on('exit', (code, sig) => { alive = false; out += `\n[CHILD EXIT code=${code} sig=${sig}]\n`; });
  for (let i = 0; i < 60 && alive; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) break;
    } catch { /* booting */ }
    await sleep(100);
  }
  return { root, comfy, child, port, isAlive: () => alive, log: () => out };
}

const post = (port, p, body) =>
  fetch(`http://127.0.0.1:${port}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }).then((r) => r.json());

const get = (port, p) => fetch(`http://127.0.0.1:${port}${p}`).then((r) => r.json());

function openSse(port) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write('GET /api/events HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/event-stream\r\n\r\n');
    });
    let buf = '';
    let done = false;
    const finish = () => { if (!done) { done = true; resolve({ sock, saw: () => buf.includes('data:') }); } };
    sock.on('data', (d) => { buf += d; finish(); });
    sock.on('error', finish);
    sock.on('close', finish);
    setTimeout(finish, 2000);
  });
}

async function scenario(name, port, fn) {
  const s = await boot(port);
  const result = { name, crashed: false, health: null };
  const ctx = {
    port,
    post: (p, b) => post(port, p, b),
    sse: null,
    get alive() { return s.isAlive(); },
  };
  try {
    await fn(ctx, s);
    result.crashed = !s.isAlive();
    try {
      const h = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) });
      result.health = h.status;
    } catch (e) {
      result.health = `UNREACHABLE ${e.cause?.code ?? e.name ?? e.message}`;
      if (!result.crashed) result.crashed = 'unreachable-but-alive';
    }
  } catch (e) {
    result.error = `${e.message}`;
    result.crashed = result.crashed || !s.isAlive();
  } finally {
    s.child.kill();
    await s.comfy.close().catch(() => {});
    result.tail = s.log().split('\n').slice(-16).join('\n');
    rmSync(s.root, { recursive: true, force: true });
  }
  return result;
}

/** Submit one job so its run gets a real promptId, wait for the POST to land. */
async function submitOne(ctx) {
  const r = await ctx.post('/api/generate', {
    prompt: 'sweep me',
    batch: 1,
    shuffle: 1,
    megapixels: 1,
    promptEnhance: true,
    turbo: false,
    stepsOverride: null,
    consistency: true,
  });
  if (r.error) throw new Error(`generate refused: ${r.error}`);
  // manual-mode fake holds the prompt; poll until the runner has handed it over
  const end = Date.now() + 15000;
  for (;;) {
    const q = await get(ctx.port, '/api/queue').catch(() => null);
    if (q && (q.waiting >= 1 || q.running >= 1)) return;
    if (Date.now() > end) throw new Error('job never reached the queue');
    await sleep(60);
  }
}

const scenarios = [
  ['G submitted run, sse live, pause->resume', async (ctx, s) => {
    await submitOne(ctx);
    ctx.sse = await openSse(ctx.port);
    await ctx.post('/api/queue/pause');
    await sleep(400);
    await ctx.post('/api/queue/resume');
    await sleep(2500);
  }],
  ['H connection hold: comfy STOPPED, resume', async (ctx, s) => {
    await submitOne(ctx);
    // simulate the link dropping: close the fake ComfyUI entirely
    await s.comfy.close();
    await sleep(600); // runner notices, holds for 'connection'
    const st = await ctx.post('/api/queue/resume').catch((e) => ({ threw: e.message }));
    ctx.st = st;
    await sleep(2500);
  }],
  ['I sweep reads /queue -> 500', async (ctx, s) => {
    await submitOne(ctx);
    s.comfy.state.queueFail = true;
    await ctx.post('/api/queue/pause');
    await sleep(300);
    await ctx.post('/api/queue/resume');
    await sleep(3500);
  }],
  ['J sse RST racing the resume burst', async (ctx) => {
    await submitOne(ctx);
    const sse = await openSse(ctx.port);
    const [r] = await Promise.all([
      ctx.post('/api/queue/resume'),
      (async () => { await sleep(5); sse.sock.resetAndDestroy(); })(),
    ]);
    ctx.st = r;
    await sleep(2500);
  }],
  ['K double-tap resume', async (ctx) => {
    await submitOne(ctx);
    ctx.sse = await openSse(ctx.port);
    await ctx.post('/api/queue/pause');
    await sleep(300);
    await Promise.all([ctx.post('/api/queue/resume'), ctx.post('/api/queue/resume'), ctx.post('/api/queue/resume')]);
    await sleep(2500);
  }],
  ['L auth 401 from /queue during sweep', async (ctx, s) => {
    await submitOne(ctx);
    s.comfy.state.authFail = true;
    await ctx.post('/api/queue/pause');
    await sleep(300);
    await ctx.post('/api/queue/resume');
    await sleep(2500);
  }],
  ['M pause->resume x10 rapid', async (ctx) => {
    await submitOne(ctx);
    ctx.sse = await openSse(ctx.port);
    for (let i = 0; i < 10; i++) {
      await ctx.post('/api/queue/pause');
      await ctx.post('/api/queue/resume');
    }
    await sleep(2500);
  }],
];

const results = [];
for (let i = 0; i < scenarios.length; i++) {
  const [name, fn] = scenarios[i];
  const r = await scenario(name, PORTS[i], fn);
  results.push(r);
  console.log(`${r.crashed ? 'CRASH' : 'ok   '} | ${r.name} | health=${r.health}${r.error ? ' | err: ' + r.error : ''}`);
  if (r.crashed) console.log(r.tail.replace(/^/gm, '    '));
}
console.log('\n=== summary ===');
for (const r of results) console.log(`${r.crashed ? 'CRASHED' : 'alive  '} | ${r.name}`);
