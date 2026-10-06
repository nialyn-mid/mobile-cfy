/**
 * What the upscale graph will actually produce, given the source size.
 *
 * This is a transcription of two ComfyMathExpression nodes and two switches in
 * upscale_api.json, not an invention. It exists so the Upscale tab can print
 * the numbers instead of asking the user to trust the sentence below them:
 *
 *   496 GetImageSize  -> out0 WIDTH, out1 HEIGHT          (the source)
 *   528/529           -> Target Width / Target Height
 *   502 a * min(4, sqrt((c*d)/(a*b)))  a=496.0 b=496.1 c=528.0 d=529.0
 *   503 a * min(4, sqrt((c*d)/(a*b)))  a=496.1 b=496.0 c=528.0 d=529.0
 *   526 PrimitiveBoolean "Scale To Dim" -> 527 (width) and 530 (height)
 *   516/517 scale x width, 516/518 scale x height          (the multiplier path)
 *
 * Two details are easy to get wrong and are load-bearing:
 *
 *   - "Scale to a target size" does NOT fit the image inside the box. It scales
 *     AREA to the box: `k = √(targetW·targetH/(w·h))` multiplies both sides, so
 *     the result has the box's pixel count and the SOURCE's shape, and comes out
 *     taller than the box's height or wider than its width - 1024×768 into a
 *     2048×2048 box is 2364×1773, not 2048×1536. That single factor is what
 *     keeps the aspect ratio; anything else would distort it.
 *   - `min(4, ...)` is a hard ceiling in the export. A factor above 4 is not
 *     reachable, so a 256×256 image asked for an 8192² box gets 1024×1024, and
 *     saying so beats printing a number the graph will never reach.
 *
 * Pure and side-effect free so it can be tested on its own: app.js boots at
 * module scope and cannot be imported by a test at all (see public/zoommath.js
 * for the same arrangement).
 */

/** The graph's own ceiling on the uniform factor - see the header. */
export const SCALE_CEILING = 4;

/** The box the target inputs are limited to, in lib/payload.js's DIM_MAX. */
export const DIM_MAX = 8192;

/**
 * The result's width and height, or null when there is nothing to compute from.
 *
 * @param {number|null} width    source width in pixels
 * @param {number|null} height   source height in pixels
 * @param {object} opts
 * @param {number} opts.scale        the multiplier, for the plain path
 * @param {boolean} opts.toDim       is "scale to a target size" on?
 * @param {number} opts.targetWidth
 * @param {number} opts.targetHeight
 * @param {number} [opts.ceiling]    override the 4x cap, for the tests
 */
export function planUpscaleSize(width, height, { scale, toDim, targetWidth, targetHeight, ceiling = SCALE_CEILING } = {}) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;

  let k;
  if (toDim) {
    if (!Number.isFinite(targetWidth) || !Number.isFinite(targetHeight)) return null;
    if (targetWidth <= 0 || targetHeight <= 0) return null;
    // 502: a * min(4, sqrt((c*d)/(a*b))) with a=width b=height c=tw d=th.
    // This scales AREA to the box, so the result has the box's pixel count and
    // the source's shape - it may overhang the box on one side.
    k = Math.min(ceiling, Math.sqrt((targetWidth * targetHeight) / (width * height)));
  } else {
    if (!Number.isFinite(scale) || scale <= 0) return null;
    k = scale;
  }
  if (!Number.isFinite(k) || k <= 0) return null;
  // The graph hands these to ConvertAny2Int, which truncates rather than rounds.
  return { width: Math.trunc(width * k), height: Math.trunc(height * k), k };
}

/** `1024 × 768` - the multiplication sign, because `x` reads as a variable. */
export const fmtDims = (w, h) => `${w} × ${h}`;

/**
 * The one line under the thumbnail: where it came from, and where it lands.
 * Returns '' when there is no image yet, which is also when the note is hidden.
 */
export function describeUpscaleSize(dims, opts = {}) {
  if (!dims) return '';
  const out = planUpscaleSize(dims.width, dims.height, opts);
  const src = fmtDims(dims.width, dims.height);
  if (!out) return `${src} — the result is not decided yet`;
  return `${src}  →  ${fmtDims(out.width, out.height)}`;
}

/**
 * Is the result big enough to be a problem? The target boxes stop at 8192, and
 * the plain multiplier has no ceiling at all - an 8x on a 2000px image is 16000
 * across, which the text encoder will not fit on a phone-sized card. Worth
 * saying, because the alternative is a run that fails after twenty minutes.
 */
export function warnUpscaleSize(out) {
  if (!out) return '';
  const over = Math.max(out.width, out.height) > DIM_MAX;
  const pixels = out.width * out.height;
  const megapixels = pixels / 1e6;
  if (over) {
    return `That is ${fmtDims(out.width, out.height)} - more than ${DIM_MAX}px on a side. The graph will try it anyway, but it may run the card out of memory.`;
  }
  if (megapixels > 20) {
    return `That is ${megapixels.toFixed(1)} megapixels in one pass. Large, but this is what the upscale graph is for.`;
  }
  return '';
}