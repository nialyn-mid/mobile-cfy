// Reproduce "press resume -> server dies". Variants differ only in SSE state.
import { mkdtempSync, cpSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { startFakeComfyUI, sleep } from './test/helpers/fakeComfy.js';

const ROOT = process.cwd();
const PORTS = [3091, 3092, 3093, 3094, 3095, 3096];

async function boot(port) {
  const root = mkdtempSync(path.join(tmpdir(), 'repro-'));
  for (const f of ['workflow_api.json', 'upscale_api.json', 'sprite_api.json']) {
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
    } catch { /* not up yet */ }
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

// Raw TCP SSE client so we can RST it (phone losing wifi) instead of a clean close.
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

async function scenario(name, port, { jobs, sseMode }) {
  const s = await boot(port);
  const result = { name, crashed: false, health: null, tail: '' };
  let sse = null;
  try {
    await post(port, '/api/queue/pause');
    if (jobs) {
      await post(port, '/api/generate', { prompt: 'repro one', turbo: false });
      await post(port, '/api/generate', { prompt: 'repro two', turbo: false });
    }
    let sse = null;
    if (sseMode !== 'none') sse = await openSse(port);
    if (sseMode === 'rst' && sse) sse.sock.resetAndDestroy();
    if (sseMode === 'fin' && sse) sse.sock.destroy();

    await post(port, '/api/queue/resume');
    await sleep(2500);

    result.crashed = !s.isAlive();
    try {
      const h = await fetch(`http://127.0.0.1:${port}/api/health`);
      result.health = h.status;
    } catch (e) {
      result.health = `UNREACHABLE ${e.cause?.code ?? e.message}`;
      if (!result.crashed) result.crashed = 'unreachable-but-alive';
    }
  } catch (e) {
    result.error = e.message;
  } finally {
    if (sseStateHasSock(result)) { /* noop */ }
    s.child.kill();
    await s.comfy.close();
    result.tail = s.log().split('\n').slice(-14).join('\n');
    rmSync(s.root, { recursive: true, force: true });
  }
  return result;
}
function sseStateHasSock() { return false; }

const matrix = [
  { name: 'A empty queue, no sse', jobs: false, sseMode: 'none' },
  { name: 'B jobs, live sse', jobs: true, sseMode: 'live' },
  { name: 'C jobs, RST sse before resume', jobs: true, sseMode: 'rst' },
  { name: 'D jobs, FIN sse before resume', jobs: true, sseMode: 'fin' },
  { name: 'E empty, RST sse', jobs: false, sseMode: 'rst' },
  { name: 'F empty, live sse', jobs: false, sseMode: 'live' },
];

const results = [];
for (let i = 0; i < matrix.length; i++) {
  const m = matrix[i];
  const r = await scenario(m.name, PORTS[i], m);
  results.push(r);
  console.log(`${r.crashed ? 'CRASH' : 'ok   '} | ${r.name} | health=${r.health}${r.error ? ' | ' + r.error : ''}`);
  if (r.crashed) console.log(r.tail.replace(/^/gm, '    '));
}
console.log('\n=== summary ===');
console.log(results.map((r) => `${r.name}: ${r.crashed ? 'CRASHED ' + JSON.stringify(r.crashed) : 'alive'}`).join('\n'));
