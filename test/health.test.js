import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { init, saveConfig, loadEnv } from '../lib/config.js';
import {
  ComfyError,
  AuthError,
  addressProblem,
  classifyComfyHealth,
  comfyHealth,
} from '../lib/comfy.js';
import { startFakeComfyUI, dropRoot } from './helpers/fakeComfy.js';

/**
 * "The dot says unreachable" is the least useful sentence this app can produce,
 * because five different faults produced it and four of them are not outages.
 * These tests pin the difference: no answer, a slow answer, a login page, a
 * refusal and a nonsense address must each arrive under their OWN name, with a
 * next step attached, or the user is sent to the router every time.
 *
 * No server is spawned here on purpose. `comfyHealth()` is a function of the
 * configured address plus one probe, so the whole classification is testable
 * against a fake ComfyUI in-process, with no port of its own to collide with.
 */

/** Point the app at a throwaway root, a ComfyUI port and a token file. */
function useTempRoot(comfy = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-cfy-health-'));
  init(root);
  fs.writeFileSync(path.join(root, '.env'), 'AUTH_TOKEN=test-token\n');
  saveConfig({
    comfy: { host: '127.0.0.1', port: 1, healthTimeoutMs: 1000, ...comfy },
    dataDir: path.join(root, 'data'),
  });
  loadEnv();
  return root;
}

// ------------------------------------------------------------ addressProblem

test('an address that cannot be dialled is named before anything is dialled', () => {
  // The base is built by concatenation, so every one of these used to become an
  // indistinguishable fetch failure.
  assert.equal(addressProblem({ host: '192.168.1.78', port: 8188 }), null);
  assert.equal(addressProblem({ host: 'localhost', port: 8188 }), null);
  assert.equal(addressProblem({ host: '[::1]', port: 8188 }), null, 'bracketed IPv6 is a valid host');

  assert.match(addressProblem({ host: '', port: 8188 }), /host box is empty/);
  assert.match(addressProblem({ host: 'http://192.168.1.78', port: 8188 }), /bare address/);
  assert.match(addressProblem({ host: '192.168.1.78:8188', port: 8188 }), /Port box/);
  assert.match(addressProblem({ host: '192.168.1.78/api', port: 8188 }), /path/);
  assert.equal(addressProblem({ host: '192.168.1.78 ', port: 8188 }), null, 'a trailing space is trimmed first');
  assert.match(addressProblem({ host: 'my comfy', port: 8188 }), /space/);
  assert.match(addressProblem({ host: '::1', port: 8188 }), /brackets/);
  assert.match(addressProblem({ host: '192.168.1.78', port: '' }), /Port box is empty/);
  assert.match(addressProblem({ host: '192.168.1.78', port: 'abc' }), /not a port/);
  assert.match(addressProblem({ host: '192.168.1.78', port: 99999 }), /not a port/);
});

// ------------------------------------------------------- classifyComfyHealth

test('every fault gets its own word and a next step', () => {
  const cases = [
    [new AuthError('/system_stats', 'no'), 'unauthorized', /reload token/],
    [Object.assign(new ComfyError('nope'), { status: 401 }), 'unauthorized', /reload token/],
    [new ComfyError('timeout after 8000ms', { kind: 'timeout' }), 'slow', /starting up/],
    [new ComfyError('ECONNREFUSED', { kind: 'network' }), 'unreachable', /0\.0\.0\.0/],
    [new ComfyError('answered 200 as text/html', { status: 200, kind: 'parse' }), 'not comfyui', /login screen/],
    [new ComfyError('HTTP 403 Forbidden', { status: 403 }), 'http 403', /proxy/],
    [new ComfyError('HTTP 500', { status: 500 }), 'http 500', /proxy/],
    [new Error('something else entirely'), 'unreachable', /.*/],
  ];
  for (const [err, state, hint] of cases) {
    const out = classifyComfyHealth(err);
    assert.equal(out.state, state, `${err.message} should classify as ${state}`);
    // A word is not enough on its own: every case carries something to read, and
    // the message is the server's own wherever it had one.
    assert.ok(out.error, `${err.message} should explain itself`);
    assert.match(out.hint ?? '', hint);
  }
  // The one that started this: a refusal and a web page are not outages, and
  // calling either of them "unreachable" is what sends people to the router.
  assert.notEqual(classifyComfyHealth(new ComfyError('x', { status: 200, kind: 'parse' })).state, 'unreachable');
});

test('a refused token says which side is stale', () => {
  // The client re-reads .env on a 401 before giving up, so the error itself
  // can carry the answer to "did you even see my edit?". Which side is wrong
  // is the entire question a user has after a token change.
  assert.equal(
    new AuthError('/prompt', 'no').message,
    'Authentication required.',
    'no re-read was attempted (websocket path) - just the fact',
  );
  assert.match(
    new AuthError('/prompt', 'no', false).message,
    /\.env still holds the same token/,
    'the file was re-read and still holds the refused token - fix the file',
  );
  assert.match(
    new AuthError('/prompt', 'no', true).message,
    /re-read from \.env and ComfyUI still refuses it/,
    'the file changed and was still refused - ComfyUI caches its own password, so restart it',
  );
  assert.equal(new AuthError('/ws', 'no', true).reloaded, true, 'the side that re-read travels with it');
});

// ------------------------------------------------------------------ the probe

test('a working ComfyUI reports its version and device', async (t) => {
  const comfy = await startFakeComfyUI();
  const root = useTempRoot({ port: comfy.port });
  t.after(async () => { await comfy.close(); dropRoot(root); });
  const h = await comfyHealth();
  assert.equal(h.state, 'ok');
  assert.equal(h.info.comfyui, '0.3.0-test');
  assert.equal(h.host, '127.0.0.1');
  assert.equal(h.port, comfy.port);
  assert.equal(h.error, undefined);
});

test('nothing listening is unreachable, and says where it looked', async (t) => {
  const root = useTempRoot({ port: 1 });
  t.after(() => dropRoot(root));
  const h = await comfyHealth();
  assert.equal(h.state, 'unreachable');
  assert.equal(h.kind, 'network');
  assert.match(h.error, /127\.0\.0\.1:1/);
  assert.match(h.hint, /0\.0\.0\.0/);
});

test('a 200 that is a web page is not an outage', async (t) => {
  // The exact shape of the ComfyUI-Login redirect: fetch follows the 302 to a
  // 200 login page, res.json() throws a bare SyntaxError, and the old code
  // called that "unreachable" with the message "Unexpected token <".
  const comfy = await startFakeComfyUI();
  comfy.state.statsBody = '<!DOCTYPE html><html><body><h1>ComfyUI-Login</h1></body></html>';
  const root = useTempRoot({ port: comfy.port });
  t.after(async () => { await comfy.close(); dropRoot(root); });
  const h = await comfyHealth();
  assert.equal(h.state, 'not comfyui');
  assert.equal(h.kind, 'parse');
  assert.match(h.error, /text\/html/);
  assert.match(h.error, /ComfyUI-Login/, 'the body excerpt is the diagnosis, so it is carried');
  assert.match(h.hint, /check the port/);
});

test('a refused token is its own fault, not an outage', async (t) => {
  const comfy = await startFakeComfyUI();
  comfy.state.authFail = true;
  const root = useTempRoot({ port: comfy.port });
  t.after(async () => { await comfy.close(); dropRoot(root); });
  const h = await comfyHealth();
  assert.equal(h.state, 'unauthorized');
  assert.match(h.hint, /reload token/);
});

test('a refusal that is not 401 keeps its status in the word', async (t) => {
  const comfy = await startFakeComfyUI();
  const root = useTempRoot({ port: comfy.port });
  t.after(async () => { await comfy.close(); dropRoot(root); });
  comfy.state.statsStatus = 403;
  assert.equal((await comfyHealth()).state, 'http 403');
  comfy.state.statsStatus = 502;
  assert.equal((await comfyHealth()).state, 'http 502');
});

test('a slow ComfyUI is slow, and the wait is configurable', async (t) => {
  const comfy = await startFakeComfyUI();
  comfy.state.statsDelayMs = 400;
  t.after(async () => { await comfy.close(); dropRoot(useTempRoot({ port: comfy.port })); });
  const root = useTempRoot({ port: comfy.port, healthTimeoutMs: 120 });
  t.after(() => dropRoot(root));
  const h = await comfyHealth();
  assert.equal(h.state, 'slow');
  assert.equal(h.kind, 'timeout');
  assert.match(h.error, /timeout after 120ms/);
});

test('a host box holding a whole URL never becomes an outage', async (t) => {
  const root = useTempRoot({ host: 'http://192.168.1.78:8188', port: 8188 });
  t.after(() => dropRoot(root));
  const h = await comfyHealth();
  assert.equal(h.state, 'bad address');
  assert.match(h.problem, /bare address/);
  // The point of checking the shape first: no probe was even attempted, so this
  // cannot be mistaken for a socket failure however the fetch would have failed.
  assert.equal(h.error, undefined);
});

test('a port pasted into the host box is caught the same way', async (t) => {
  const root = useTempRoot({ host: '192.168.1.78:8188', port: 8188 });
  t.after(() => dropRoot(root));
  const h = await comfyHealth();
  assert.equal(h.state, 'bad address');
  assert.match(h.problem, /Port box/);
});

test('no token at all is its own word, with the file named', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-cfy-health-'));
  init(root);
  saveConfig({ comfy: { host: '127.0.0.1', port: 8188 }, dataDir: path.join(root, 'data') });
  loadEnv();
  t.after(() => dropRoot(root));
  const h = await comfyHealth();
  assert.equal(h.state, 'no-token');
  assert.match(h.problem, /\.env/);
});
