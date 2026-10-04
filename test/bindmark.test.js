import test from 'node:test';
import assert from 'node:assert/strict';
import { bindingMark } from '../public/bindmark.js';

const escapeHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

test('a broken binding never wears a tick', () => {
  // The bug this module exists for: the row said ✓ while the summary line said
  // "1 problem", and the eye believed the row.
  const m = bindingMark({ ok: false, reason: 'node 176 (ImpactConditionalBranch) has no input "switch"' }, escapeHtml);
  assert.match(m.html, /✗/);
  assert.match(m.html, /has no input "switch"/);
  assert.doesNotMatch(m.html, /✓/);
  assert.equal(m.bad, true, 'the row is highlighted so the eye finds it');
});

test('a good binding shows the node it landed on', () => {
  const m = bindingMark({ ok: true, title: 'Prompt Enhance On/Off', classType: 'ImpactConditionalBranch' }, escapeHtml);
  assert.match(m.html, /✓/);
  assert.match(m.html, /Prompt Enhance On\/Off/);
  assert.match(m.html, /ImpactConditionalBranch/);
  assert.equal(m.bad, false);
});

test('unchecked and disabled are shown as neither good nor bad', () => {
  // "Not checked yet" must not read as a pass: it is what a stale map looks like,
  // and a dash next to a tick invites the reader to assume the worst is fine.
  assert.match(bindingMark(null, escapeHtml).html, /not checked yet/);
  assert.equal(bindingMark(null, escapeHtml).bad, false);
  assert.match(bindingMark({ ok: true, disabled: true }, escapeHtml).html, /disabled/);
  assert.equal(bindingMark({ ok: true, disabled: true }, escapeHtml).bad, false);
});

test('a failure reason is escaped on the way in', () => {
  const m = bindingMark({ ok: false, reason: '<img src=x onerror=alert(1)>' }, escapeHtml);
  assert.doesNotMatch(m.html, /<img/);
  assert.match(m.html, /&lt;img/);
});