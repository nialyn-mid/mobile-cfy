// The markup and the script are two files that have to agree, and nothing in the
// build checks that they do.
//
// It matters more here than in a normal app: app.js is a module, so a single
// `$('x').onclick = ...` on an element that index.html does not have throws at
// top level and aborts *everything after it* - commenting one button out of the
// markup silently killed the settings tab and the boot sequence once already.
// The null-safe helpers stop that particular crash, but the page is then quietly
// missing that feature, so the ids are checked here instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

/**
 * Comments go before scanning: the null-safe helper is *documented* with the very
 * call it exists to prevent (`$('x').onclick = …`), and a scanner that reads it
 * would report an id nobody ever looks up.
 */
const app = appSrc
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
  .join('\n');

/** Every id index.html declares, including ones written into markup strings. */
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

// Ids the script creates itself, with the line that makes them. Listed rather
// than guessed at: an id that moves out of one of these into index.html should
// come off the list.
const BUILT_IN_JS = new Set([
  'shWaitText', // written into the modal body while shutting down
]);

/**
 * Literal ids only. `$()` and the helpers are also called with expressions in a
 * few places (a loop over a list of ids), and those are covered by the tests that
 * exercise the code rather than by this static check.
 */
function referencedIds(src) {
  const ids = new Set();
  const patterns = [
    /\$\(\s*'([A-Za-z][\w-]*)'\s*\)/g,
    /\bon\(\s*'([A-Za-z][\w-]*)'\s*,/g,
    /\blisten\(\s*'([A-Za-z][\w-]*)'\s*,/g,
    /\bset(?:Disabled|Hidden|Text)\(\s*'([A-Za-z][\w-]*)'\s*,/g,
  ];
  for (const re of patterns) for (const m of src.matchAll(re)) ids.add(m[1]);
  return ids;
}

test('every id app.js reaches for exists in index.html', () => {
  const missing = [...referencedIds(app)].filter((id) => !htmlIds.has(id) && !BUILT_IN_JS.has(id)).sort();
  assert.deepEqual(missing, [], `app.js uses ids that index.html does not have: ${missing.join(', ')}`);
});

test('the upscale tab and its shared queue panel are wired into the markup', () => {
  // The queue strip and the job panel cannot be copied into the second tab -
  // ids must stay unique - so both tabs name the one section they share.
  const shared = html.match(/<section class="tab[^"]*" data-for="([^"]+)"/);
  assert.ok(shared, 'the shared queue section is missing');
  assert.deepEqual(shared[1].split(' ').sort(), ['generate', 'upscale']);
  for (const id of ['queueBar', 'queueList', 'jobPanel', 'genErr']) {
    const inside = html.slice(html.indexOf('data-for=')).includes(`id="${id}"`);
    assert.equal(inside, true, `${id} must live in the shared section, not in one tab`);
  }
  assert.equal(htmlIds.has('tab-upscale'), true);
  assert.match(html, /class="tabbtn" data-tab="upscale"/);
});

test('the tabs list every section that is reachable', () => {
  const buttons = [...html.matchAll(/data-tab="([\w-]+)"/g)].map((m) => m[1]);
  const sections = [...html.matchAll(/<section id="tab-([\w-]+)"/g)].map((m) => m[1]);
  for (const name of sections) {
    assert.ok(buttons.includes(name), `no tab button for #tab-${name}`);
  }
});

test('the postprompt box is on the generate tab, sent, cleared, and not remembered', () => {
  // Placement: it belongs to the prompt, not to the other tab.
  const genStart = html.indexOf('id="tab-generate"');
  const gen = html.slice(genStart, html.indexOf('<section id="tab-', genStart));
  assert.match(gen, /id="postprompt"/);
  assert.equal(gen.indexOf('id="postprompt"') < gen.indexOf('id="generate"'), true, 'it sits above the Generate button');

  // Submitted with the job, exactly as typed: node 257 joins it to the prompt
  // with no delimiter, so the user's leading newlines ARE the separator and a
  // trim() here would glue it onto the last word of the prompt.
  assert.match(app, /^ {4}postprompt: \$\('postprompt'\)\.value,$/m);

  // ...cleared when it is spent, so the next prompt cannot inherit it.
  const clearBlock = app.slice(app.indexOf('if ($(\'postprompt\').value.trim() !== \'\')'));
  assert.match(clearBlock, /\$\('postprompt'\)\.value = ''/, 'the box is emptied after submit');

  // History puts it back: tapping a row means "run this again".
  const restore = app.slice(app.indexOf('function restoreHistory'));
  assert.match(restore.slice(0, 1200), /\$\('postprompt'\)\.value = typeof s\.postprompt/);

  // NOT in the stored form. Toggles and numbers survive a reload; text that
  // belongs to one prompt does not, or a reload would silently append yesterday's
  // tail to today's idea.
  const form = app.slice(app.indexOf('const FORM_IDS'), app.indexOf('];', app.indexOf('const FORM_IDS')));
  assert.equal(form.includes("'postprompt'"), false, 'the postprompt must not be persisted in localStorage');
  assert.equal(form.includes("'seed'"), false, 'nor the seed, which is the same kind of one-shot field');
});

test('the server has a route for every api path the page calls', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  // Paths built at runtime (`/api/jobs/${id}/cancel`) are not literals and are
  // covered by the tests that exercise them; query strings are dropped because
  // the route table never carries them.
  const calls = [...app.matchAll(/api\(\s*'\/api\/([^'${}]+)'/g)].map((m) => m[1].split('?')[0]);
  const missing = [...new Set(calls)].filter((p) => !server.includes(`'/api/${p}'`)).sort();
  assert.deepEqual(missing, [], `the page calls routes the server does not register: ${missing.join(', ')}`);
});