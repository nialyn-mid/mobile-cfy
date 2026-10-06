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

test('every toggle keeps its words out of the pill', () => {
  // `.switch > span` is the 42x25 PILL (see the switches block in style.css) -
  // the words belong in a sibling `<div><b>title</b><i>hint</i></div>`, which is
  // how all five generate toggles were written. The two upscale toggles had their
  // label text in that span instead, so the words rendered inside a 42px grey
  // rounded box: "crunched into the left", with the toggle itself invisible.
  // Nothing fails when that happens, it just looks wrong on the phone.
  const bodies = [...html.matchAll(/<label class="switch">([\s\S]*?)<\/label>/g)].map((m) => m[1]);
  assert.ok(bodies.length >= 7, `expected every toggle to be a .switch, found ${bodies.length}`);
  for (const body of bodies) {
    const pill = body.match(/<span>([\s\S]*?)<\/span>/);
    assert.ok(pill, 'a toggle with no pill span');
    assert.equal(pill[1].trim(), '', 'the direct span is the pill and must be empty');
    assert.match(body, /<div><b>[^<]/, 'the words belong in a sibling <div>, as <b>title</b>');
  }
});

test('the upscale Run card gives its toggle a row of its own', () => {
  // It was inside a `.row2` (2fr 1fr), which on a 360px phone is roughly a
  // 100px column - too narrow for a pill plus the words naming what it does.
  const runCard = html.slice(
    html.lastIndexOf('<div class="card-hd"><span>Run</span></div>'),
    html.indexOf('id="upscale"'),
  );
  assert.match(runCard, /id="upSeed"/);
  assert.match(runCard, /id="upDownload"/);
  assert.equal(/class="row[23]"/.test(runCard), false, 'the seed and the toggle must not share a grid column');
});

test('the upscale batch box is on the upscale tab, sent raw, and remembered', () => {
  const up = html.slice(html.indexOf('id="tab-upscale"'), html.indexOf('<section id="tab-', html.indexOf('id="tab-upscale"')));
  assert.match(up, /id="upBatch"/);
  // It shares a row with the seed (two short numbers) and NOT with the toggle,
  // which got its own row after the cramped-column complaint.
  const row = up.match(/<div class="row2 seedrow">([\s\S]*?)<\/div>/);
  assert.ok(row, 'the batch and seed share one grid row');
  assert.match(row[1], /id="upBatch"/);
  assert.match(row[1], /id="upSeed"/);

  // Sent as the string the number input holds, so the server is the one that
  // refuses junk with a message instead of this page rounding it away.
  assert.match(app, /^ {8}batch: \$\('upBatch'\)\.value,$/m);
  assert.match(app, /'upScale', 'upScaleToDim', 'upTargetWidth', 'upTargetHeight', 'upDownload', 'upBatch'/);

  // History brings the count back with everything else about the recipe.
  const restore = app.slice(app.indexOf('function restoreUpscaleHistory'));
  assert.match(restore.slice(0, 900), /\$\('upBatch'\)\.value = s\.batch \?\? 1;/);
});

test('the upscale image and its guidance are spent by the job, the settings are not', () => {
  // The same rule the Generate tab follows, one field over: clear what belongs
  // to THIS job, keep the settings. The picture is the upscale's prompt, and the
  // guidance is a note about that same picture - leaving either armed means the
  // NEXT upscale silently runs against the wrong one, which is the bug the
  // generate tab's references and postprompt had.
  const submit = app.slice(app.indexOf("on('upscale', async () =>"), app.indexOf("$('helpRefresh')"));
  assert.match(submit, /if \(state\.upImage\) \{/, 'the image is cleared once the job has it');
  assert.match(submit, /setUpImage\(null\)/);
  assert.match(submit, /\$\('upGuidance'\)\.value = ''/, 'the guidance goes with the picture it described');

  // ...and the settings stay, because upscaling the next photo the same way is
  // the entire point of a separate tab. Their values must not be reset here.
  for (const id of ['upScale', 'upTargetWidth', 'upTargetHeight', 'upBatch', 'upSeed']) {
    assert.equal(
      new RegExp(`\\$\\('${id}'\\)\\.value =[^=]`).test(submit),
      false,
      `${id} is a setting, not part of this job`,
    );
  }
  assert.equal(/\$\('upScaleToDim'\)\.checked =[^=]|\$\('upDownload'\)\.checked =[^=]/.test(submit), false);
  // The user is told what vanished, in the same words the generate tab uses.
  assert.match(submit, /cleared\.push\('image'\)/);
  assert.match(submit, /toast\(`\$\{cleared\.join\(' and '\)\} cleared`\)/);
});

test('a hold for ComfyUI\'s own queue says so and keeps send all alive', () => {
  const strip = app.slice(app.indexOf('function renderQueue'), app.indexOf("on('queueToggle'"));
  // "Send all to ComfyUI" is the escape hatch the hold was designed around, so
  // it must stay pressable during it - while staying dead for a lost connection,
  // where sending could only fail.
  assert.match(strip, /const busyHold = paused && q\.reason === 'busy';/);
  assert.match(strip, /send\.disabled = handoff === 0 \|\| \(paused && !busyHold\);/);
  // And the strip has to say WHY, in the reason's own words - a row that only
  // says "paused" leaves the user guessing which kind of pause this is.
  assert.match(strip, /held — \$\{q\.message/);
  assert.match(strip, /start on their own as soon as it is free/);
  assert.match(strip, /or press send all/);
  // The same sentence has to reach the queue row, which is what is on screen.
  const row = app.slice(
    app.indexOf("j.status === 'paused' ? '⏸'"),
    app.indexOf("const hint = $('queueHint')"),
  );
  assert.match(row, /waiting for ComfyUI's queue/);
});

test('the health dot leads to a written report, not a tooltip', () => {
  // The failure this exists for: the reason for a red dot lived only in
  // `title=`, which no phone renders and no thumb can hover. Someone whose
  // ComfyUI was right there was told "unreachable" with nothing to act on.
  assert.match(html, /id="healthDetail"/, 'the report needs somewhere on the page to live');
  assert.match(html, /id="healthCheck"/);
  assert.match(html, /id="healthCopy"/);
  assert.match(html, /class="note report"/, 'lines, not one run-on sentence');

  // The answer is kept, not recomputed from a single word.
  assert.match(app, /state\.health = c;/);
  assert.match(app, /function renderHealthDetail\(\)/);
  assert.match(app, /function healthReportText\(\)/);
  const report = app.slice(app.indexOf('function healthReportText'), app.indexOf('function renderHealthDetail'));
  for (const part of ['c.host', 'c.state', 'c.problem', 'c.error', 'c.hint']) {
    assert.ok(report.includes(part), `the report carries ${part}`);
  }

  // The dot itself: tapping it is the only always-available route to the detail,
  // so it must open Settings and scroll there rather than doing nothing on touch.
  const dot = app.slice(app.indexOf("$('healthBtn').onclick"), app.indexOf("$('healthCheck').onclick"));
  assert.match(dot, /\.tabbtn\[data-tab="settings"\]/, 'reuses the tab switcher, so loadSettings still runs');
  assert.match(dot, /scrollIntoView/);
  assert.match(dot, /healthDetail/);

  // The classifier's own word reaches the dot, because "not comfyui" and
  // "bad address" send you to a different box than "unreachable" does.
  const health = app.slice(app.indexOf('async function refreshHealth'), app.indexOf('function healthReportText'));
  assert.match(health, /text\.textContent = c\.state;/);
  // ...and the tooltip is no longer the only carrier of the detail.
  assert.match(health, /c\.error \|\| c\.problem \|\| /);
  // A re-check without waiting for the poll, and a way to get the text out.
  assert.match(app, /\$\('healthCheck'\)\.onclick/);
  assert.match(app, /copyText\(healthReportText\(\)\)/);
  // pre-wrap, or every line but the last runs together.
  assert.match(fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8'), /\.note\.report \{[^}]*white-space: pre-wrap/);
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