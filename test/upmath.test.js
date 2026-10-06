import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  planUpscaleSize,
  describeUpscaleSize,
  warnUpscaleSize,
  fmtDims,
  SCALE_CEILING,
  DIM_MAX,
} from '../public/upmath.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the plain multiplier path multiplies both sides', () => {
  assert.deepEqual(planUpscaleSize(1024, 768, { scale: 2, toDim: false }), {
    width: 2048, height: 1536, k: 2,
  });
  assert.deepEqual(planUpscaleSize(800, 600, { scale: 1.5, toDim: false }), {
    width: 1200, height: 900, k: 1.5,
  });
  // ConvertAny2Int truncates, it does not round. A half pixel is not a pixel.
  assert.deepEqual(planUpscaleSize(1001, 333, { scale: 1.5, toDim: false }), {
    width: 1501, height: 499, k: 1.5,
  });
});

test('the target-size path gives the box’s AREA, in the source’s shape', () => {
  // This is the single rule behind nodes 502/503, and it is easy to state wrong:
  // k = min(4, √(tw·th/(w·h))) scales AREA to the box, not the two sides to the
  // box's sides. So 1024×768 into a 2048×2048 box is 2364×1773 - the same 4.19
  // megapixels, sticking out past the box's width on one side and short of it on
  // the other. A result of 2048×1536 would be the box's height and nothing else.
  const out = planUpscaleSize(1024, 768, { scale: 2, toDim: true, targetWidth: 2048, targetHeight: 2048 });
  assert.ok(Math.abs(out.k - Math.sqrt(16 / 3)) < 1e-9, 'k is the square root of the area ratio');
  assert.deepEqual([out.width, out.height], [2364, 1773]);
  // The area is the target's area, to within the truncation of two edges.
  const area = out.width * out.height;
  assert.ok(Math.abs(area - 2048 * 2048) / (2048 * 2048) < 0.002, `area ${area} should be the target's`);
  // And the shape is the source's, untouched.
  assert.ok(Math.abs(out.width / out.height - 1024 / 768) < 0.01);

  // A wide source into a square box stays wide - and can come out SMALLER than
  // the source, which is what "fit" means when the box is smaller than the art.
  const wide = planUpscaleSize(2000, 1000, { scale: 1, toDim: true, targetWidth: 1024, targetHeight: 1024 });
  assert.deepEqual([wide.width, wide.height], [1448, 724]);
  assert.ok(Math.abs(wide.width / wide.height - 2) < 0.01, 'the 2:1 shape survived');
  assert.ok(wide.width < 2000, 'a 1024² box over a 2000×1000 source is a reduction');
});

test('the target-size path honours the graph’s own 4x ceiling', () => {
  // A 4x factor means SIXTEEN times the area. Asking a 256×256 image for an
  // 8192² box would need k=32; the export clamps at min(4, ...), so the answer
  // is 4 - and saying so beats printing 32.
  assert.equal(SCALE_CEILING, 4);
  const capped = planUpscaleSize(256, 256, { scale: 1, toDim: true, targetWidth: 8192, targetHeight: 8192 });
  assert.equal(capped.k, 4);
  assert.deepEqual([capped.width, capped.height], [1024, 1024]);

  // The clamp bites on the LINEAR factor, not on the area: 2.5x the area is fine.
  const under = planUpscaleSize(1024, 1024, { scale: 1, toDim: true, targetWidth: 1600, targetHeight: 1600 });
  assert.equal(under.k, 1.5625);
  assert.deepEqual([under.width, under.height], [1600, 1600]);

  // ...and it is a cap on k, so an area jump past 16x is what gets cut. 1024→3000
  // is √8.79 ≈ 2.96, under the cap, so the box is honoured exactly.
  const near = planUpscaleSize(1024, 1024, { scale: 1, toDim: true, targetWidth: 3000, targetHeight: 3000 });
  assert.ok(near.k > 2.9 && near.k <= 4);
  assert.deepEqual([near.width, near.height], [3000, 3000], 'a square source in a square box lands exactly');
});

test('nothing is invented from a missing or impossible size', () => {
  assert.equal(planUpscaleSize(null, null, { scale: 2 }), null);
  assert.equal(planUpscaleSize(0, 768, { scale: 2 }), null);
  assert.equal(planUpscaleSize(1024, 768, { scale: 0 }), null);
  assert.equal(planUpscaleSize(1024, 768, { scale: 'two' }), null);
  assert.equal(planUpscaleSize(1024, 768, {}), null);
  // The target boxes are filled in with 2048 by default, so "blank" there has to
  // be a no-answer rather than a divide by zero.
  assert.equal(planUpscaleSize(1024, 768, { toDim: true, targetWidth: NaN, targetHeight: 2048 }), null);
  assert.equal(planUpscaleSize(1024, 768, { toDim: true, targetWidth: 0, targetHeight: 0 }), null);
  assert.equal(planUpscaleSize(Infinity, 768, { scale: 2 }), null);
});

test('the line under the thumbnail reads as input to output', () => {
  assert.equal(describeUpscaleSize({ width: 1024, height: 768 }, { scale: 2 }), '1024 × 768  →  2048 × 1536');
  assert.equal(
    describeUpscaleSize({ width: 1024, height: 768 }, { scale: 2, toDim: true, targetWidth: 2048, targetHeight: 2048 }),
    '1024 × 768  →  2364 × 1773',
  );
  // No image yet means no line at all, which is also what hides the element.
  assert.equal(describeUpscaleSize(null, { scale: 2 }), '');
  // An image with no decided result still gets its own size printed - that part
  // was read off the thumbnail, so it is true regardless.
  assert.equal(describeUpscaleSize({ width: 640, height: 480 }, {}), '640 × 480 — the result is not decided yet');
  assert.equal(fmtDims(1920, 1080), '1920 × 1080');
});

test('an oversized result is called out; a normal one is not', () => {
  assert.equal(warnUpscaleSize({ width: 2048, height: 1536, k: 2 }), '');

  const big = warnUpscaleSize(planUpscaleSize(4000, 3000, { scale: 4, toDim: false }));
  assert.match(big, /16000 × 12000/);
  assert.match(big, /run the card out of memory/);

  // Large but inside the box: acknowledged without crying wolf.
  const large = warnUpscaleSize(planUpscaleSize(6000, 4000, { scale: 1, toDim: false }));
  assert.match(large, /24\.0 megapixels/);

  // Under both thresholds, and nothing to say.
  assert.equal(warnUpscaleSize(null), '');
  assert.equal(DIM_MAX, 8192);
});

test('the module mirrors the graph it is a transcription of', () => {
  // If the workflow changes, this test is the reminder that the printed numbers
  // are now a guess. It pins the facts the transcription depends on.
  const wf = JSON.parse(fs.readFileSync(path.join(ROOT, 'upscale_api.json'), 'utf8'));
  const w502 = wf['502'].inputs;
  const h503 = wf['503'].inputs;

  // ComfyMathExpression stores its four variables under LITERALLY DOTTED keys -
  // `values.a`, not `values['a']` - because the node keeps them as hidden
  // widgets. Easy to get wrong when reading the export by eye.
  assert.match(w502.expression, /a \* min\(4, sqrt\(\(c\*d\)\/\(a\*b\)\)\)/, 'the uniform factor and its 4x cap');
  assert.match(h503.expression, /b \* min\(4, sqrt\(\(c\*d\)\/\(a\*b\)\)\)/, 'the same factor, applied to height');
  assert.deepEqual(w502['values.a'], ['496', 0], 'a is the source WIDTH');
  assert.deepEqual(w502['values.b'], ['496', 1], 'b is the source HEIGHT');
  assert.deepEqual(w502['values.c'], ['528', 0], 'c is Target Width');
  assert.deepEqual(w502['values.d'], ['529', 0], 'd is Target Height');
  assert.deepEqual(h503['values.a'], w502['values.a'], 'both sides read the same four values');
  assert.deepEqual(h503['values.d'], w502['values.d']);
  assert.equal(wf['496'].class_type, 'GetImageSize');
  assert.equal(wf['496'].inputs.image[0], '538', 'the size is read off the LoadImage');

  // The switch that chooses between the multiplier and the target box.
  assert.equal(wf['526'].class_type, 'PrimitiveBoolean');
  assert.deepEqual(wf['527'].inputs.switch, ['526', 0], 'node 527 follows the toggle');
  // Node 530's switch is a hard-wired literal `false` in the export, which is
  // why buildUpscalePayload writes BOTH switches from the one toggle - otherwise
  // a target size would set the width from the box and throw the height away.
  assert.equal(wf['530'].inputs.switch, false, 'node 530 does NOT follow the toggle - the payload drives it too');
  assert.deepEqual(wf['527'].inputs.on_true, ['502', 1], 'target-size width');
  assert.deepEqual(wf['530'].inputs.on_true, ['503', 1], 'target-size height');
  assert.deepEqual(wf['527'].inputs.on_false, ['518', 0], 'plain multiplier width');
  assert.deepEqual(wf['530'].inputs.on_false, ['519', 0], 'plain multiplier height');

  // The multiplier path: 517 (the scale) × 521 (width) -> 518, and the same for
  // height through 520 -> 515 -> 519.
  assert.equal(wf['517'].class_type, 'PrimitiveFloat');
  assert.equal(wf['516'].class_type, 'CyclistMathFloat');
  assert.deepEqual(wf['516'].inputs.float_1, ['517', 0], 'the scale is one factor of the product');
  assert.deepEqual(wf['516'].inputs.float_2, ['521', 0], 'the image width is the other');
  assert.deepEqual(wf['521'].inputs.input1, ['496', 0], 'and that width came from GetImageSize');
  assert.equal(wf['518'].class_type, 'ConvertAny2Int', 'which is where the truncation happens');

  // The result the text encoder is handed - this is what "the size" means here.
  assert.deepEqual(wf['506'].inputs.width, ['527', 0]);
  assert.deepEqual(wf['506'].inputs.height, ['530', 0]);
});