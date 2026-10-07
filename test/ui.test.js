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
const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

/**
 * Comments go before scanning: the null-safe helper is *documented* with the very
 * call it exists to prevent (`$('x').onclick = …`), and a scanner that reads it
 * would report an id nobody ever looks up.
 */
const app = appSrc
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  // The `m` is load-bearing for CRLF files: `.` does not match `\r`, so without
  // it `$` cannot reach the end of a line that ends in `\r\n` and the comment
  // survives the strip - which reads as app.js calling the very thing the
  // comment says it deliberately does not call.
  .map((line) => line.replace(/(^|[^:])\/\/.*$/gm, '$1'))
  .join('\n');

/**
 * Every id index.html ACTUALLY declares.
 *
 * HTML comments are stripped first, and that is the whole point of this change.
 * Scanning the raw file counted `lbClose` as present because it appears inside
 * `<!-- <button id="lbClose"> -->`, so the cross-check passed while
 * `$('lbClose').onclick = ...` threw at module scope and took the lightbox's
 * four pointer handlers (swipe, pinch, drag) down with it. A commented-out
 * button is not a button.
 */
const liveHtml = html.replace(/<!--[\s\S]*?-->/g, '');
const htmlIds = new Set([...liveHtml.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

/** Ids that exist in the file but only inside a comment - i.e. switched off. */
const commentedOutIds = [];
for (const c of html.matchAll(/<!--[\s\S]*?-->/g)) {
  // One comment at a time: a regex that lets the match run past the closing
  // `-->` would happily swallow the live markup sitting between two comments.
  for (const id of c[0].matchAll(/\bid="([^"]+)"/g)) commentedOutIds.push(id[1]);
}

// Ids the script creates itself, with the line that makes them. Listed rather
// than guessed at: an id that moves out of one of these into index.html should
// come off the list.
const BUILT_IN_JS = new Set([
  'shWaitText', // written into the modal body while shutting down
]);

/**
 * Ids app.js still binds that the markup deliberately switched off - they exist
 * only inside HTML comments.
 *
 * They are safe now that `$` resolves a missing element to a detached node, and
 * that is the whole feature: commenting one button out used to throw at module
 * scope and take the lightbox's pointer handlers with it. But the list stays
 * explicit so that switching off a NEW id forces an edit right here - a silent
 * disappearance is exactly how the lightbox broke. Each entry is also asserted
 * to still be commented out, so uncommenting or deleting one retires it.
 */
const COMMENTED_OUT_OK = new Set([
  'lbClose', // tap outside the image closes it instead
  'lbZoomIn', // pinch on a phone; the +/− pair gave the room back to ⟳ and ⤒
  'lbZoomOut',
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
  const missing = [...referencedIds(app)]
    .filter((id) => !htmlIds.has(id) && !BUILT_IN_JS.has(id) && !COMMENTED_OUT_OK.has(id))
    .sort();
  assert.deepEqual(missing, [], `app.js uses ids that index.html does not have: ${missing.join(', ')}`);
});

test('a commented-out button cannot take the rest of the page down with it', () => {
  // The crash this guards against was not a crash the user could see: one
  // `$('x').onclick =` against an id that markup no longer has threw at module
  // top level, and because app.js is a module that aborted everything after it.
  // So the check above is a safety net, not the fix - `$` itself is total now.
  assert.match(
    appSrc,
    /const \$ = \(id\) => document\.getElementById\(id\) \?\? document\.createElement\('div'\)/,
    'a missing element must resolve to a detached node, never to null'
  );

  // And the ids that were only ever commented out must stay that way in the
  // cross-check: if one of them is quietly re-introduced, the markup test above
  // would go quiet again unless the comment stripping is doing its job.
  assert.ok(
    commentedOutIds.length >= 1,
    'expected at least one id to live inside an HTML comment, or this test is not testing anything'
  );
  for (const id of commentedOutIds) {
    assert.ok(
      !htmlIds.has(id),
      `${id} is commented out, so it must not also be a live id in the markup`
    );
  }
  // Every acknowledged id must still be in that commented-out set. If it was
  // uncommented, the live markup wins and this list should shrink; if the line
  // was deleted, the acknowledgment should go with it.
  for (const id of COMMENTED_OUT_OK) {
    assert.ok(
      commentedOutIds.includes(id),
      `${id} was acknowledged as commented out but is not inside a comment any more - update COMMENTED_OUT_OK`
    );
  }
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

test('the page asks for the real icon, and the file is where the link points', () => {
  // The link and the file are two halves of one promise: a href to a file that
  // does not exist 404s quietly (the tab keeps a generic glyph) and nobody
  // notices until a phone installs a shortcut with the wrong picture. The old
  // emoji data-URI favicon is gone on purpose - the user shipped a real icon.
  const iconLinks = [...liveHtml.matchAll(/<link rel="(?:icon|apple-touch-icon)" href="([^"]+)"/g)]
    .map((m) => m[1]);
  assert.ok(iconLinks.length >= 1, 'the page declares an icon at all');
  for (const href of iconLinks) {
    assert.equal(href, '/icon.png', 'the icon is a real path the static server can serve');
  }
  assert.equal(fs.existsSync(path.join(ROOT, 'public', 'icon.png')), true,
    'public/icon.png exists - serveStatic resolves /icon.png against public/');
  assert.match(liveHtml, /<link rel="icon" href="\/icon\.png" type="image\/png">/,
    'the type is declared so the browser does not sniff it');
  // No leftover of the previous inline-SVG favicon.
  assert.doesNotMatch(html, /data:image\/svg/);
});

test('the bindings card offers all three graphs, each wired end to end', () => {
  // Three workflows means three rows of Settings: the select picks the kind,
  // app.js maps kind -> map, workflow route, stale report and upload input, and
  // index.html supplies the option, the upload button and its file name. Any
  // layer missing an entry silently falls back to 'generate' - the exact bug
  // this test exists to catch (an enhanceless save writing `bindings`).
  const start = liveHtml.indexOf('id="bindKind"');
  assert.ok(start >= 0, 'the kind select is missing');
  // Slice to the select's OWN closing tag: indexOf('</select>') from 0 finds an
  // earlier dropdown (the aspect one) and yields an empty window.
  const select = liveHtml.slice(start, liveHtml.indexOf('</select>', start));
  const options = [...select.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(options, ['generate', 'enhanceless', 'upscale'],
    'the kind select lists every graph, in Settings order');

  assert.equal(htmlIds.has('enWfUpload'), true, 'the enhanceless workflow needs its own replace button');
  assert.match(liveHtml, /replace workflow_api_enhanceless\.json<input id="enWfUpload"/,
    'the button names the file it replaces');
  assert.match(liveHtml, /replace workflow_api\.json<input id="wfUpload"/);
  assert.match(liveHtml, /replace upscale_api\.json<input id="upWfUpload"/);

  // app.js: every helper is three-way, and the missing entries default to
  // 'generate' - which is why each one has to be listed here explicitly.
  assert.match(app, /const BIND_KINDS = \['generate', 'enhanceless', 'upscale'\]/);
  for (const [snippet, what] of [
    [/kind === 'enhanceless'\s*\? state\.cfg\?\.enhancelessBindings/, 'bindingsFor reads the third map'],
    [/kind === 'enhanceless'\s*\? '\/api\/enhanceless\/workflow'/, 'bindingsPath reads the third route'],
    [/kind === 'enhanceless'\s*\? 'staleEnhancelessBindings'/, 'the stale report has its own key'],
    [/kind === 'enhanceless'\s*\? 'workflow_api_enhanceless\.json'/, 'workflowFileFor names the third file'],
    [/\? \{ enhancelessBindings: collectBindings\(\) \}/, 'saving posts the third map under its own name'],
    [/listen\('enWfUpload', 'change', \(\) => uploadWorkflow\('enhanceless', 'enWfUpload'\)\)/,
      'the third upload input is listened to'],
    [/workflow_api_enhanceless\.json \(no postprompt or prompt refresh\)/,
      'the enhance hint says what the off path runs'],
  ]) {
    assert.match(app, snippet, what);
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

test('the picked image’s own size is read off its thumbnail and printed', () => {
  // No server route and no header parsing: the browser has to decode the image
  // to show it anyway, and naturalWidth/naturalHeight is the decoded size. That
  // makes it work the same for an upload, a paste, a drop and a gallery pick.
  const slot = app.slice(app.indexOf('function renderUpSlot()'), app.indexOf('function setUpImage'));
  assert.match(slot, /img\.naturalWidth/, 'the size comes from the decoded image');
  assert.match(slot, /img\.naturalHeight/);
  // The handler has to be attached BEFORE src: a cached image can finish
  // loading before the next statement runs.
  const loadAt = slot.indexOf('img.onload');
  const srcAt = slot.indexOf('img.src = url');
  assert.ok(loadAt !== -1 && srcAt !== -1 && loadAt < srcAt, 'onload is attached before src is set');
  // And the callback must not rebuild the thumbnail, or it would load again,
  // which would call it again - forever.
  const onload = slot.slice(slot.indexOf('img.onload'), slot.indexOf('img.onerror'));
  assert.match(onload, /updateUpMath\(\)/);
  assert.equal(/renderUpSlot\(\)/.test(onload), false, 'rendering again here would loop');

  // A stale size under a new picture is worse than no size at all: the numbers
  // would describe the wrong image and aim the next upscale wrongly.
  const setter = app.slice(app.indexOf('function setUpImage'), app.indexOf('function setUpImage') + 700);
  assert.match(setter, /state\.upDims = null/, 'changing or clearing the image forgets its size');
  assert.match(app, /upDims: null/, 'it starts unknown, not zero');

  // Both notes are marked up for what they now carry.
  assert.match(html, /class="note dims" id="upSlotNote"/, 'the size line');
  assert.match(html, /class="note warn" id="upSizeNote"/, 'the too-big warning');
  assert.match(css, /\.note\.dims \{[^}]*tabular-nums/, 'lining the digits up');
  assert.match(app, /from '\.\/upmath\.js'/);
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

test('a hold for a refused token says what to fix and that nothing was lost', () => {
  const strip = app.slice(app.indexOf('function renderQueue'), app.indexOf("on('queueToggle'"));
  // The queue knows a token refusal as its own pause reason - not as a
  // connection problem, and not as the generic "paused" that swallows the
  // message the hold was careful to carry.
  assert.match(strip, /q\.reason === 'auth'/);
  assert.match(strip, /held — \$\{q\.message \|\| 'ComfyUI refused the token'\}/);
  assert.match(strip, /job\(s\) are kept in the queue/);
  // It says WHERE to fix it, and that resuming is safe - which is true because
  // the client re-reads .env on the next 401 by itself.
  assert.match(strip, /edit the token in \.env/);
  assert.match(strip, /and press resume/);
  // The detail line of the held job carries the same distinction.
  const detail = app.slice(app.indexOf('const bits = [];'), app.indexOf("$('jobLine').textContent"));
  assert.match(detail, /held - ComfyUI refused the token; fix it in \.env and resume/);
  // And the old per-job flag is gone for good: a refusal never marks a job
  // failed any more, so there is nothing left for it to report.
  assert.equal(/\bauthFailed\b/.test(appSrc), false, 'the dead authFailed flag is back in app.js');
});

test('a queue that cannot be written says so, and a recovered one says what came back', () => {
  assert.match(html, /id="queueSaved"/, 'the warning needs somewhere on the page to live');
  const htmlSlice = html.slice(html.indexOf('id="queueSaved"') - 80, html.indexOf('id="queueSaved"') + 60);
  assert.match(htmlSlice, /id="queueSaved" hidden/);

  const strip = app.slice(app.indexOf('function renderQueue'), app.indexOf("on('queueToggle'"));
  // Shown only when it is both true AND would matter - a failed save while the
  // queue is empty is noise, and so is a quiet one.
  assert.match(strip, /const unsaved = Boolean\(q\.saveError\) && \(busy\.length > 0 \|\| q\.waiting > 0 \|\| paused\);/);
  assert.match(strip, /saved\.hidden = !unsaved;/);
  assert.match(strip, /the queue is not being saved to disk/);
  // "Free some space" is the actual answer on a phone: data/ filling up is the
  // realistic cause, and it is the one the user can do something about.
  assert.match(strip, /Free some space, or check that data\/ is writable/);

  // Recovery is announced once, and keyed on the timestamp so a reload hours
  // later does not claim a recovery that is old news.
  const apply = app.slice(app.indexOf('function applyQueue'), app.indexOf('let pollTimer'));
  assert.match(app, /restoredShown: null,/);
  assert.match(apply, /q\.restored\?\.jobs && q\.restored\.at !== state\.restoredShown/);
  assert.match(apply, /queue recovered — \$\{q\.restored\.jobs\} job/);
  assert.match(apply, /of them mid-run/);
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

test('a shut down that will be refused says so before the button is pressed', () => {
  // The report: the button only works from the phone itself. Asked from another
  // device it answered 403, and the page answered that by closing the dialog and
  // firing a 2.6-second toast - so it read as a button that does nothing at all.
  assert.match(html, /id="shutdownNote"/, 'a permanent line under the button, not just a toast');
  assert.match(html, /class="note warn" id="shutdownNote" hidden/, 'and it says warn, not warn-hidden-by-accident');
  assert.match(app, /function renderShutdownNote\(\)/);

  // The verdict comes from the poll the page already makes, so it is known before
  // anything is pressed.
  const health = app.slice(app.indexOf('async function refreshHealth'), app.indexOf('function healthReportText'));
  assert.match(health, /h\.shutdown/, 'the health answer carries it');
  assert.match(health, /renderShutdownNote\(\)/);

  // Both carriers print the server's own words rather than a local guess, so the
  // pre-press line and the post-press error cannot drift apart.
  const note = app.slice(app.indexOf('function renderShutdownNote'), app.indexOf('function shutdownPermissionParagraph'));
  assert.match(note, /v\.allowed !== false/, 'nothing shown when it is allowed');
  assert.match(note, /note\.hidden = true/);
  assert.match(note, /v\.error/);
  const para = app.slice(app.indexOf('function shutdownPermissionParagraph'), app.indexOf('function openShutdownModal'));
  assert.match(para, /v\.error/);

  // The dialog leads with the refusal...
  const paint = app.slice(app.indexOf('function paintShutdownBody'), app.indexOf('function closeShutdownModal'));
  assert.match(paint, /shutdownPermissionParagraph\(state\.shutdown\)/);
  assert.match(paint, /body\.prepend\(deny\)/, 'above the consequences, not buried under them');

  // ...and a refusal leaves it open. This is the regression: the old catch did
  // closeShutdownModal() + toast(), which is the whole complaint.
  const shGo = app.slice(app.indexOf("on('shGo'"), app.indexOf("on('shAgain'"));
  assert.match(shGo, /if \(e\.status\) \{/);
  assert.match(shGo, /para\(e\.message, 'bad'\)/, 'the refusal stays on screen');
  assert.doesNotMatch(shGo, /closeShutdownModal\(\)/, 'the dialog is not thrown away on a refusal');
  assert.doesNotMatch(shGo, /toast\(e\.message\)/, 'a 2.6-second toast is not the only feedback');
  assert.match(shGo, /setDisabled\('shGo', false\)/, 'and the button is not left dead');
  assert.match(shGo, /setText\('shTitle', 'Not shut down'\)/);
  // The 403 body carries the verdict too, for a page whose first poll has not landed.
  assert.match(shGo, /if \(e\.shutdown\) \{/);
  const apiSrc = app.slice(app.indexOf('const api ='), app.indexOf('const state ='));
  assert.match(apiSrc, /if \(body\?\.shutdown\) e\.shutdown = body\.shutdown;/);

  // Opened before the first poll landed: ask, rather than let the button be blind.
  const open = app.slice(app.indexOf('function openShutdownModal'), app.indexOf('function paintShutdownBody'));
  assert.match(open, /if \(!state\.shutdown\) \{/, 'a missing verdict is fetched, not assumed');
  assert.match(open, /paintShutdownBody\(\)/, 'and the dialog repaints when it lands');
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

test("a waiting job's actions live in one bar under the queue, not on every row", () => {
  // Four buttons per row, repeated down a list of waiting jobs, is a column of
  // tiny targets on a phone - and the row has no room left for its own text.
  // One bar for the one selected job replaces them, so every id it needs must
  // be in the markup (a missing id would silently disable that action, this
  // file's whole reason to exist), the bar must start hidden, and it must sit
  // after the list it acts on.
  for (const id of ['selBar', 'selWho', 'selDetails', 'selUp', 'selDown', 'selCancel']) {
    assert.equal(htmlIds.has(id), true, `#${id} is missing from index.html`);
  }
  assert.match(html, /<div class="btnrow" id="selBar" hidden>/, 'nothing is selected at boot');
  assert.ok(
    html.indexOf('id="selBar"') > html.indexOf('id="queueList"'),
    'the bar belongs below the queue it acts on',
  );

  // The row still says WHICH one is selected, and the bar only appears for a
  // job the four buttons could actually act on - a finished row lets go of its
  // selection rather than offering "move up" on a job that is already gone.
  assert.match(app, /\+ \(state\.sel === j\.id \? ' sel' : ''\);/, 'the selected row is marked');
  assert.match(
    app,
    /state\.sel = inFlight\(j\) \? \(state\.sel === j\.id \? null : j\.id\) : null;/,
    'only a job in flight can hold the selection, and a second tap clears it',
  );
  const strip = app.slice(app.indexOf('function renderQueue'), app.indexOf("on('queueToggle'"));
  assert.match(strip, /const actions = \$\('selBar'\);/);
  assert.match(strip, /actions\.hidden = !selJob;/);
  assert.match(strip, /setText\('selWho'/, 'the bar names the job it is about');
  // Each arrow is disabled exactly where a move would clamp straight back to
  // the same spot, instead of a button that presses and does nothing.
  assert.match(strip, /setDisabled\('selUp', !movable \|\| at <= 1\);/);
  assert.match(strip, /setDisabled\('selDown', !movable \|\| at >= selJob\.queueLength\);/);

  for (const id of ['selDetails', 'selUp', 'selDown', 'selCancel']) {
    assert.match(app, new RegExp(`on\\('${id}'`), `nothing is wired to #${id}`);
  }
  // Details is a jump to the history entry, and the reorder goes through the
  // queue's own move route rather than reshuffling the list locally.
  assert.match(app, /showHistoryForJob\(state\.sel\)/);
  assert.match(app, /await api\('\/api\/queue\/move'/);

  // The per-row controls they replaced must stay gone - in the script...
  assert.equal(/\bqx\b/.test(appSrc), false, 'per-row action buttons are back in app.js');
  // ...and in the stylesheet, where a leftover rule would resurrect the styling.
  assert.equal(/\.qx/.test(css), false, 'and a .qx rule is still in style.css');
  assert.match(css, /\.qrow\.sel \{/, 'the selected row must be visible as such');
});

test('both ways into a history entry land on the row that belongs to that job', () => {
  // Two entry points now: the action bar's Details and the gallery cell's
  // history button. Both hand over the JOB id and one function does the rest,
  // because entries fold by prompt - a job can sit inside a row that remembers
  // several jobIds, so matching on position or on prompt text would miss.
  assert.match(app, /showHistoryForJob\(state\.sel\)/, 'from the queue');
  assert.match(app, /bHist\.textContent = '🕘 history'/, 'a gallery cell offers it');
  assert.match(app, /bHist\.onclick = \(\) => showHistoryForJob\(entry\.jobId\)/);
  assert.match(app, /acts\.append\(bUse, bHist\)/, 'and is actually appended, not just built');
  assert.equal(/\bbUp\b/.test(appSrc), false, 'the dead upscale twin is back in the gallery');

  // The target travels as a flag, never as a position: the list is re-read on
  // every visit, so a row index would point at the wrong entry an hour later.
  const jump = app.slice(app.indexOf('function showHistoryForJob'), app.indexOf('function useEnhancedAsPrompt'));
  const setsFlag = jump.indexOf('state.histFlash = jobId');
  const opensTab = jump.indexOf("showTab('history')");
  assert.ok(setsFlag !== -1, 'the job id is remembered');
  assert.ok(opensTab !== -1, 'and the history tab is opened');
  assert.ok(setsFlag < opensTab, 'the flag is set before the tab opens, or nothing would find it');

  // After the fetch lands, the flash finds the row by id - or by any id folded
  // into it - and says so out loud when there is no such row yet.
  assert.match(app, /e\.jobId === want \|\| \(e\.jobIds \?\? \[\]\)\.includes\(want\)/);
  assert.match(app, /card\.classList\.add\('flash'\)/);
  assert.match(app, /scrollIntoView\(\{ block: 'center' \}\)/, 'it is brought into view');
  assert.match(app, /no history entry for that job \(yet\)/, 'a miss is reported, not swallowed');
  assert.match(css, /\.hrow\.flash \{/, 'the mark itself needs a rule to be seen');
});

test('a history row still shows its prompt now that the delete button is off', () => {
  // The delete button was switched off by commenting out its line, and that
  // line was `top.append(p, x)` - taking the PROMPT (`p`) with it. Every row
  // then built its text and dropped it on the floor, which is exactly the
  // "prompt text disappears" report: a commented-out append is not an append.
  assert.match(app, /\btop\.append\(p\);/, 'the prompt row must be appended on its own');
  assert.equal(/top\.append\(p, x\)/.test(app), false, 'the delete-button append stays off (x is commented out)');
  assert.equal(/hrow-x/.test(app), false, 'the delete button itself stays off');
  assert.match(app, /p\.textContent = /, 'and it carries the text it was built for');
});