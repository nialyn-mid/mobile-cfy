import { test } from 'node:test';
import assert from 'node:assert/strict';

import { zoomAboutPoint } from '../public/zoommath.js';

/*
 * The model the maths has to satisfy. The image carries
 * `translate(x, y) scale(s)` with the default transform-origin (its centre), so
 * a content point `u` px from the centre sits `x + s * u` px from the centre on
 * screen. "Zoom towards the focal point" means exactly one thing: the content
 * point that was under the focal stays under it.
 */
const onScreen = (z, u, axis) => z[axis] + z.s * u;
const contentUnder = (z, c, axis) => (c - z[axis]) / z.s;
const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-9, `${what}: ${a} is not ${b}`);

/**
 * Zoom, then check the focal point did not move on screen.
 *
 * The focal is given as an offset from the image AS DRAWN (that is what a
 * bounding rect measures, and what the pinch midpoint naturally is), while the
 * content model counts from the element's own centre - which is one pan width
 * further right. Both are converted here so the assertion cannot be fooled by
 * mixing the two up.
 */
function holdsFocal(start, focalX, focalY, next) {
  const fx = focalX + start.x;          // from the element's centre
  const fy = focalY + start.y;
  const u = contentUnder(start, fx, 'x');
  const v = contentUnder(start, fy, 'y');
  const out = zoomAboutPoint(start, focalX, focalY, next);
  near(onScreen({ ...out, s: next }, u, 'x'), fx, 'focal x drifted');
  near(onScreen({ ...out, s: next }, v, 'y'), fy, 'focal y drifted');
  return out;
}

test('the point under the focal stays under it, at any scale, anywhere on the image', () => {
  const starts = [
    { s: 1, x: 0, y: 0 },
    { s: 2.5, x: 0, y: 0 },
    { s: 3, x: 120, y: -60 },
    { s: 1, x: 0, y: 0 },
  ];
  const focals = [[0, 0], [-300, -200], [180, 90], [0, 260], [-1000, 0], [1000, -1000]];
  for (const start of starts) {
    for (const [fx, fy] of focals) {
      for (const next of [start.s * 1.5, start.s * 4, start.s / 2, start.s / 8]) {
        holdsFocal(start, fx, fy, next);
      }
    }
  }
});

test('zooming about the centre does not pan', () => {
  // A focal at offset (0, 0) IS the drawn centre of the image, so the image may
  // only grow in place - which is what the +/- buttons and the double tap do.
  for (const start of [{ s: 1, x: 0, y: 0 }, { s: 2, x: 90, y: -40 }]) {
    assert.deepEqual(zoomAboutPoint(start, 0, 0, start.s * 2), { x: start.x, y: start.y });
  }
});

test('a focal left of centre pushes the image right, so the left edge comes into view', () => {
  const out = holdsFocal({ s: 1, x: 0, y: 0 }, -100, 0, 2);
  assert.ok(out.x > 0, `expected a rightward pan, got x=${out.x}`);
  const back = holdsFocal({ s: 2, x: out.x, y: out.y }, -100, 0, 1);
  assert.ok(back.x < out.x, 'and pinching back in returns towards the centre');
});

test('many small pinch steps land exactly where one big step would', () => {
  // A pinch arrives as a stream of small moves, so the correction has to compose
  // rather than drift - and the endpoint has to match a single zoom to the same
  // scale, because the scale alone is not what the user asked for.
  const start = { s: 1, x: 0, y: 0 };
  const focal = { x: -160, y: 70 };
  let z = { ...start };
  for (let i = 0; i < 8; i += 1) {
    // The focal is re-measured from the image as drawn on every move, which is
    // what the handler does with getBoundingClientRect.
    const p = zoomAboutPoint(z, focal.x - z.x, focal.y - z.y, z.s * 1.2);
    z = { ...p, s: z.s * 1.2 };
  }
  const oneStep = zoomAboutPoint(start, focal.x, focal.y, z.s);
  near(z.x, oneStep.x, 'stepped x');
  near(z.y, oneStep.y, 'stepped y');
  holdsFocal(start, focal.x, focal.y, z.s);
});

test('a broken scale leaves the pan alone instead of turning it inside out', () => {
  // next = 0 would divide by zero; NaN/Infinity are what a bad caller can hand
  // over. The scale is the caller's own clamp problem, not the pan's.
  const z = { s: 2, x: 30, y: -10 };
  assert.deepEqual(zoomAboutPoint(z, 100, 0, 0), { x: 30, y: -10 });
  assert.deepEqual(zoomAboutPoint(z, 100, 0, NaN), { x: 30, y: -10 });
  assert.deepEqual(zoomAboutPoint(z, 100, 0, Infinity), { x: 30, y: -10 });
  assert.deepEqual(zoomAboutPoint(z, 100, 0, -2), { x: 30, y: -10 });
});

test('regression: panning without the focal correction is what this replaces', () => {
  // The old pinch moved the image by the midpoint delta and changed only the
  // scale, which zooms towards the image centre. Keep the counter-example so a
  // future "simplification" cannot bring it back.
  const start = { s: 1, x: 0, y: 0 };
  const focal = { x: -100, y: 0 };
  const next = 2;
  const old = { x: 0, y: 0, s: next };        // scale only, no correction
  const u = contentUnder(start, focal.x, 'x');
  assert.notEqual(onScreen(old, u, 'x'), focal.x, 'the old behaviour moved the focal point');
  holdsFocal(start, focal.x, focal.y, next);
});

test('a zoom on a panned image still holds its focal point', () => {
  // The subtlety that makes this worth its own test: the focal offset is
  // measured from the image's DRAWN centre, which has already moved by the pan.
  // Measuring from the laid-out centre instead leaves a jump of x * (k - 1).
  const start = { s: 2, x: 50, y: -30 };
  const next = 4;                              // k = 2
  // The focal is a point on the SCREEN, so it stays in that frame for the whole
  // test - otherwise the round trip compares two different points.
  const fx = start.x - 150;                    // 150 px left of the image as drawn
  const fy = start.y + 40;                     // 40 px below it
  const out = zoomAboutPoint(start, fx - start.x, fy - start.y, next);
  assert.equal(out.x, 200, 'pan has to move by twice the focal offset at k = 2');
  assert.equal(out.y, -70);
  near(out.x + next * contentUnder(start, fx, 'x'), fx, 'focal x drifted');
  near(out.y + next * contentUnder(start, fy, 'y'), fy, 'focal y drifted');

  // Zooming back out about the same screen point lands where it started.
  const back = zoomAboutPoint({ ...out, s: next }, fx - out.x, fy - out.y, start.s);
  near(back.x, start.x, 'x round trip');
  near(back.y, start.y, 'y round trip');
});