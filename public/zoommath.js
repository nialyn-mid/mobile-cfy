/**
 * The lightbox zoom maths, on its own so it can be tested without a DOM.
 *
 * The image carries `translate(x, y) scale(s)` with the default
 * transform-origin (its centre), so with the element's own centre at the screen
 * point C, a content point `u` px from that centre ends up at `C + x + s * u`.
 * The image as it is drawn right now therefore has its centre at `C + x`.
 *
 * `focalX`/`focalY` are the focal point's offset from THAT drawn centre - which
 * is what `getBoundingClientRect()` gives you for free. Pinch-zoom and
 * wheel-zoom both want the content point currently under the finger or cursor
 * to stay under it while the scale changes to `next`:
 *
 *     f = C + x  + s * u  =  C + x' + next * u,   u = focalX / s
 *  => x' = x + focalX * (1 - next/s)
 *
 * Note the sign: the focal point drags the image TOWARDS it, so the point under
 * the fingers stays put. Zooming without moving the pan at all is `focal = 0`,
 * i.e. growing the image in place.
 */
export function zoomAboutPoint(zoom, focalX, focalY, nextScale) {
  const k = nextScale / zoom.s;
  // A zero or non-finite scale would turn the image inside out; leave the pan
  // alone and let the caller's own clamp deal with the scale.
  if (!Number.isFinite(k) || k <= 0) return { x: zoom.x, y: zoom.y };
  const shift = 1 - k;
  return { x: zoom.x + focalX * shift, y: zoom.y + focalY * shift };
}