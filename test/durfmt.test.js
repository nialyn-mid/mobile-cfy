import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fmtDuration, durationBetween } from '../public/durfmt.js';

test('a duration reads as minutes and seconds, not a pile of seconds', () => {
  assert.equal(fmtDuration(0), '0:00');
  assert.equal(fmtDuration(1000), '0:01');
  assert.equal(fmtDuration(59_000), '0:59');
  assert.equal(fmtDuration(60_000), '1:00');
  assert.equal(fmtDuration(95_000), '1:35');
  assert.equal(fmtDuration(125_000), '2:05');
  assert.equal(fmtDuration(599_000), '9:59');
  // A twenty minute run is normal on an RTX 2060, so minutes must never wrap.
  assert.equal(fmtDuration(1_235_000), '20:35');
});

test('the seconds are always two digits, so the width does not jump', () => {
  assert.equal(fmtDuration(61_000), '1:01');
  assert.equal(fmtDuration(600_000), '10:00');
  assert.equal(fmtDuration(3_600_000), '1:00:00');
  assert.equal(fmtDuration(3_725_000), '1:02:05');
  assert.equal(fmtDuration(36_000_000), '10:00:00');
});

test('rounding is to the nearest second and never negative', () => {
  assert.equal(fmtDuration(1499), '0:01');
  assert.equal(fmtDuration(1500), '0:02');
  assert.equal(fmtDuration(-5000), '0:00');
  // A finished run's end time can land a hair before its start on a phone with a
  // coarse clock; "-0:01" would be worse than no timer at all.
  assert.equal(fmtDuration(-1), '0:00');
});

test('nonsense is 0:00 rather than NaN on the screen', () => {
  assert.equal(fmtDuration(undefined), '0:00');
  assert.equal(fmtDuration(null), '0:00');
  assert.equal(fmtDuration('later'), '0:00');
  assert.equal(fmtDuration(Infinity), '0:00');
});

test('a run that has not started has no timer at all', () => {
  assert.equal(durationBetween(null, null), '');
  assert.equal(durationBetween(undefined, '2026-01-01T00:01:00Z'), '');
  // Submitted, not begun: the server leaves startedAt null and this must not
  // invent one out of now.
  assert.equal(durationBetween(null, null, Date.parse('2026-01-01T00:05:00Z')), '');
  assert.equal(durationBetween('not a date', null), '');
});

test('a running timer counts from the start time to now', () => {
  const start = '2026-01-01T00:00:00.000Z';
  assert.equal(durationBetween(start, null, Date.parse('2026-01-01T00:02:05.000Z')), '2:05');
  assert.equal(durationBetween(start, null, Date.parse('2026-01-01T00:00:00.400Z')), '0:00');
});

test('a finished run stops for good, which is what makes a 1s tick safe', () => {
  const start = '2026-01-01T00:00:00.000Z';
  const end = '2026-01-01T00:02:05.000Z';
  // Minutes later, the same answer: the end time does not move.
  assert.equal(durationBetween(start, end, Date.parse('2026-01-01T01:30:00.000Z')), '2:05');
  assert.equal(durationBetween(start, end, Date.parse('2026-01-01T00:02:05.000Z')), '2:05');
});
