/**
 * Straightening a photographed book cover.
 *
 * A cover photographed on a phone is shot at a slight angle on whatever
 * surface was to hand, so it arrives keystoned with a table, a sleeve or a
 * shelf around it. This finds the book, warps its four corners back to a true
 * rectangle, and drops everything outside - which removes the unwanted
 * background *by construction* rather than by erasing anything, so the worst
 * it can do is nothing.
 *
 * All of it is plain arithmetic on pixels: no model, no download, no service,
 * and nothing to pay for. The detection is deliberately modest, because the
 * portal always shows the four corners as draggable handles - if this guesses
 * wrong the owner moves them, and the preview re-warps. That is what makes it
 * safe to ship a detector that is right most of the time rather than one that
 * has to be right always.
 *
 * The functions are exported and free of the DOM so they can be checked
 * outside a browser, which is the only way any of this gets tested - the
 * portal cannot be driven from the HTTP suite.
 */

export interface Point {
  x: number;
  y: number;
}

/** Working size for detection. Big enough to find a book, small enough to scan. */
export const DETECT_EDGE = 240;

/**
 * The book in this photo, as four corners - or null if it cannot tell.
 *
 * Works from the background rather than from edges: the border of the frame is
 * assumed to be the surface the book is lying on, and anything far enough from
 * that colour is the subject. On the case this exists for - a book on a table -
 * that is a far steadier signal than edge detection, which finds the grain of
 * the table just as happily as the edge of the book.
 *
 * Returns corners in the coordinates of the ImageData it was given.
 */
export function detectQuad(image: {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}): Point[] | null {
  const { data, width: w, height: h } = image;
  if (w < 16 || h < 16) return null;

  const bg = borderColour(data, w, h);

  // Distances of every pixel from the background, so the threshold can be set
  // from the picture itself rather than from a number chosen in advance - a
  // dark book on a dark table needs a different one from a white book on wood.
  const dist = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const p = i * 4;
    dist[i] = Math.abs(data[p] - bg[0]) + Math.abs(data[p + 1] - bg[1]) + Math.abs(data[p + 2] - bg[2]);
  }

  const cut = threshold(dist);
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = dist[i] > cut ? 1 : 0;

  const region = largestRegion(mask, w, h);
  // Too little to be a book. Better to offer the whole frame and let the owner
  // drag than to crop confidently to a shadow.
  if (!region || region.length < w * h * 0.08) return null;

  const quad = extremes(region, w);
  return isSane(quad, w, h) ? quad : null;
}

/** The median colour of a ring around the edge: whatever it is lying on. */
function borderColour(data: Uint8ClampedArray, w: number, h: number): [number, number, number] {
  const band = Math.max(2, Math.round(Math.min(w, h) * 0.04));
  const r: number[] = [];
  const g: number[] = [];
  const b: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= band && x < w - band && y >= band && y < h - band) continue;
      const p = (y * w + x) * 4;
      r.push(data[p]);
      g.push(data[p + 1]);
      b.push(data[p + 2]);
    }
  }
  // Median, not mean: a hand or a corner of something else intruding on the
  // border should not drag the whole model towards it.
  return [median(r), median(g), median(b)];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Where to cut between background and subject.
 *
 * Otsu's method: the split that best separates the two groups of distances.
 * A fixed threshold fails in both directions - too low and the table's own
 * texture becomes subject, too high and a muted cover disappears.
 */
function threshold(dist: Float32Array): number {
  const bins = 256;
  let max = 0;
  for (let i = 0; i < dist.length; i++) if (dist[i] > max) max = dist[i];
  if (max <= 0) return Infinity;

  const hist = new Float64Array(bins);
  for (let i = 0; i < dist.length; i++) hist[Math.min(bins - 1, Math.round((dist[i] / max) * (bins - 1)))]++;

  const total = dist.length;
  let sum = 0;
  for (let i = 0; i < bins; i++) sum += i * hist[i];

  let sumB = 0;
  let wB = 0;
  let best = 0;
  let bestVar = -1;
  for (let i = 0; i < bins; i++) {
    wB += hist[i];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += i * hist[i];
    const between = wB * wF * Math.pow(sumB / wB - (sum - sumB) / wF, 2);
    if (between > bestVar) {
      bestVar = between;
      best = i;
    }
  }
  return (best / (bins - 1)) * max;
}

/** The biggest connected blob in the mask, as pixel indices. */
function largestRegion(mask: Uint8Array, w: number, h: number): Int32Array | null {
  const seen = new Uint8Array(mask.length);
  const stack = new Int32Array(mask.length);
  let best: Int32Array | null = null;

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;

    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    const found: number[] = [];

    while (top > 0) {
      const i = stack[--top];
      found.push(i);
      const x = i % w;
      const y = (i / w) | 0;
      if (x > 0 && mask[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack[top++] = i - 1; }
      if (x < w - 1 && mask[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack[top++] = i + 1; }
      if (y > 0 && mask[i - w] && !seen[i - w]) { seen[i - w] = 1; stack[top++] = i - w; }
      if (y < h - 1 && mask[i + w] && !seen[i + w]) { seen[i + w] = 1; stack[top++] = i + w; }
    }

    if (!best || found.length > best.length) best = Int32Array.from(found);
  }
  return best;
}

/**
 * Four corners from a blob.
 *
 * The extremes of x+y and x-y: for anything roughly rectangular, however it is
 * rotated, those four points are its corners. Cheap, and it does not care that
 * the blob's outline is ragged.
 */
function extremes(region: Int32Array, w: number): Point[] {
  let tl = 0, br = 0, tr = 0, bl = 0;
  let tlV = Infinity, brV = -Infinity, trV = -Infinity, blV = Infinity;

  for (let n = 0; n < region.length; n++) {
    const i = region[n];
    const x = i % w;
    const y = (i / w) | 0;
    const sum = x + y;
    const diff = x - y;
    if (sum < tlV) { tlV = sum; tl = i; }
    if (sum > brV) { brV = sum; br = i; }
    if (diff > trV) { trV = diff; tr = i; }
    if (diff < blV) { blV = diff; bl = i; }
  }

  const at = (i: number): Point => ({ x: i % w, y: (i / w) | 0 });
  return [at(tl), at(tr), at(br), at(bl)];
}

/** A quad worth using: big enough, and not folded in on itself. */
function isSane(quad: Point[], w: number, h: number): boolean {
  const area = Math.abs(polygonArea(quad));
  if (area < w * h * 0.06) return false;
  // Every side has to have some length, or the "quad" is a triangle and the
  // warp would divide by nothing.
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    if (Math.hypot(b.x - a.x, b.y - a.y) < Math.min(w, h) * 0.05) return false;
  }
  return true;
}

export function polygonArea(pts: Point[]): number {
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

/** Clockwise from the top left, whatever order they arrived in. */
export function orderCorners(pts: Point[]): Point[] {
  const cx = pts.reduce((n, p) => n + p.x, 0) / pts.length;
  const cy = pts.reduce((n, p) => n + p.y, 0) / pts.length;
  return [...pts].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
}

/**
 * The output size a quad deserves.
 *
 * From the longest opposing sides, so a cover photographed at an angle comes
 * out at the size of its nearer edge rather than squashed to its further one.
 */
export function quadSize(quad: Point[], maxEdge: number): { width: number; height: number } {
  const side = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);
  const width = Math.max(side(quad[0], quad[1]), side(quad[3], quad[2]));
  const height = Math.max(side(quad[0], quad[3]), side(quad[1], quad[2]));
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * The 3x3 that maps `from` onto `to`, as nine numbers, row by row.
 *
 * Eight unknowns from four point pairs, solved by elimination. Returns null if
 * the points are degenerate rather than producing infinities that would paint
 * a blank canvas.
 */
export function solveHomography(from: Point[], to: Point[]): number[] | null {
  const a: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i];
    const { x: u, y: v } = to[i];
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }

  // Gauss-Jordan with partial pivoting.
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let row = col + 1; row < 8; row++) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) < 1e-10) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];

    const lead = a[col][col];
    for (let k = col; k < 9; k++) a[col][k] /= lead;

    for (let row = 0; row < 8; row++) {
      if (row === col) continue;
      const factor = a[row][col];
      if (factor === 0) continue;
      for (let k = col; k < 9; k++) a[row][k] -= factor * a[col][k];
    }
  }

  return [...a.map((row) => row[8]), 1];
}

/** Applies a 3x3 to a point. */
export function project(m: number[], p: Point): Point {
  const d = m[6] * p.x + m[7] * p.y + m[8];
  return {
    x: (m[0] * p.x + m[1] * p.y + m[2]) / d,
    y: (m[3] * p.x + m[4] * p.y + m[5]) / d,
  };
}

/**
 * The quad, flattened into a rectangle of `out`.
 *
 * Sampled the other way round - for every output pixel, ask where it came
 * from - because mapping forwards leaves holes wherever the source is being
 * stretched. Bilinear, so an angled edge does not come out as stairs.
 */
export function warp(
  source: { data: Uint8ClampedArray; width: number; height: number },
  quad: Point[],
  out: { data: Uint8ClampedArray; width: number; height: number },
): boolean {
  const { width: w, height: h } = out;
  const inverse = solveHomography(
    [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }],
    quad,
  );
  if (!inverse) return false;

  const src = source.data;
  const sw = source.width;
  const sh = source.height;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = project(inverse, { x: x + 0.5, y: y + 0.5 });
      const o = (y * w + x) * 4;

      // Outside the source: white, so a corner dragged past the edge reads as
      // paper rather than as a black wedge.
      if (p.x < 0 || p.y < 0 || p.x > sw - 1 || p.y > sh - 1) {
        out.data[o] = out.data[o + 1] = out.data[o + 2] = 255;
        out.data[o + 3] = 255;
        continue;
      }

      const x0 = Math.floor(p.x);
      const y0 = Math.floor(p.y);
      const x1 = Math.min(sw - 1, x0 + 1);
      const y1 = Math.min(sh - 1, y0 + 1);
      const fx = p.x - x0;
      const fy = p.y - y0;

      for (let c = 0; c < 3; c++) {
        const tl = src[(y0 * sw + x0) * 4 + c];
        const tr = src[(y0 * sw + x1) * 4 + c];
        const bl = src[(y1 * sw + x0) * 4 + c];
        const br = src[(y1 * sw + x1) * 4 + c];
        out.data[o + c] =
          tl * (1 - fx) * (1 - fy) + tr * fx * (1 - fy) + bl * (1 - fx) * fy + br * fx * fy;
      }
      out.data[o + 3] = 255;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Erasing what is left behind the book
// ---------------------------------------------------------------------------
//
// The crop removes everything outside the book. This is for what survives
// inside it: a thumb over a corner, a shadow, a strip of table past a curled
// edge. A saliency model (U²-Netp, Apache-2.0) says which pixels are the
// subject; everything else becomes white.
//
// White rather than transparent because that is what the shop's other covers
// already sit on - the publisher scans it has to sit beside - and because a
// slightly rough cut-out edge disappears into white and would show against
// the navy of the hero strip.
//
// The model's own numbers, from its preprocessor_config: fit inside a 320
// square keeping the aspect, pad the rest, rescale to 0-1, normalise with the
// ImageNet statistics, feed NCHW.

export const MASK_EDGE = 320;
const MASK_MEAN = [0.485, 0.456, 0.406];
const MASK_STD = [0.229, 0.224, 0.225];

export interface MaskFit {
  /** Where the photo actually is inside the padded square. */
  width: number;
  height: number;
}

/** How a photo of this shape sits inside the model's square. */
export function maskFit(width: number, height: number): MaskFit {
  const scale = Math.min(MASK_EDGE / width, MASK_EDGE / height);
  return {
    width: Math.max(1, Math.min(MASK_EDGE, Math.round(width * scale))),
    height: Math.max(1, Math.min(MASK_EDGE, Math.round(height * scale))),
  };
}

/**
 * The 320x320 RGBA square as the NCHW float tensor the model wants.
 *
 * Channel-planar, not pixel-interleaved: all the reds, then all the greens,
 * then all the blues. Feeding it interleaved produces a plausible-looking
 * tensor of the right length and a mask that is complete nonsense.
 */
export function toTensor(square: { data: Uint8ClampedArray }): Float32Array {
  const pixels = MASK_EDGE * MASK_EDGE;
  const out = new Float32Array(3 * pixels);
  for (let i = 0; i < pixels; i++) {
    for (let c = 0; c < 3; c++) {
      out[c * pixels + i] = (square.data[i * 4 + c] / 255 - MASK_MEAN[c]) / MASK_STD[c];
    }
  }
  return out;
}

/**
 * Whether this mask is worth applying - the mask itself, or null.
 *
 * The model's output is already 0..1: on a book photographed on a table the
 * cover reads 1.0 and the table 0.0. It needs no rescaling, and rescaling it
 * is actively dangerous. An earlier version stretched the output across its
 * own range, the way most implementations of this do, which is fine until the
 * crop is *all book* and there is no background left to find. The model then
 * correctly returns almost nothing - a maximum around 0.017 - and stretching
 * that turns pure noise into a confident mask that whites out the cover.
 *
 * So: refuse rather than invent. A mask is refused when nothing in it stands
 * out at all, or when it keeps so little that applying it would white out the
 * whole picture.
 *
 * Note what is *not* a reason to refuse: keeping only a small share of the
 * frame. A first attempt rejected any mask keeping under a quarter, on the
 * reasoning that erasing most of a photo cannot be right - but a loosely
 * cropped shot of a book on a table is mostly table, and erasing most of it is
 * precisely the point. That threshold refused the exact case this feature
 * exists for. The owner sees the result before accepting it, which is the real
 * safeguard; this one only has to catch the absurd.
 */
export function checkMask(mask: Float32Array, fit: MaskFit): Float32Array | null {
  let max = 0;
  let kept = 0;
  for (let y = 0; y < fit.height; y++) {
    for (let x = 0; x < fit.width; x++) {
      const v = mask[y * MASK_EDGE + x];
      if (v > max) max = v;
      if (v > 0.5) kept++;
    }
  }
  if (max < 0.5) return null; // nothing stood out from anything else
  if (kept / (fit.width * fit.height) < 0.02) return null; // keeps nothing at all
  return mask;
}

/**
 * Tightens a mask before it is applied.
 *
 * This is where the trailing colour came from. The mask is 320px and the crop
 * can be 800, and the model's boundary is soft - so around the whole cover
 * there is a band of half-claimed pixels that are part book, part table.
 * Keeping them keeps a fringe of the table, smeared along every edge.
 *
 * Two passes fix it. **Shrink** takes the smallest alpha in a small
 * neighbourhood, which pulls the boundary inwards so the half-and-half band
 * falls outside it. **Harden** then pushes what is left away from the middle,
 * so a pixel is the book or it is not, rather than a blend of the book and
 * what was behind it.
 */
export function refineMask(mask: Float32Array, shrink = 1, harden = 6): Float32Array {
  const eroded = new Float32Array(mask.length);
  for (let y = 0; y < MASK_EDGE; y++) {
    for (let x = 0; x < MASK_EDGE; x++) {
      let lowest = 1;
      for (let dy = -shrink; dy <= shrink; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= MASK_EDGE) continue;
        for (let dx = -shrink; dx <= shrink; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= MASK_EDGE) continue;
          const v = mask[yy * MASK_EDGE + xx];
          if (v < lowest) lowest = v;
        }
      }
      // Steepened about the middle, then clamped.
      const pushed = (lowest - 0.5) * harden + 0.5;
      eroded[y * MASK_EDGE + x] = pushed < 0 ? 0 : pushed > 1 ? 1 : pushed;
    }
  }
  return eroded;
}

/**
 * Paints everything the mask does not claim white, in place.
 *
 * The mask is 320x320 with the photo occupying only `fit` of it, so sampling
 * has to map through that rather than across the whole square - otherwise the
 * padding drags the mask sideways and the book is erased instead of the
 * background.
 */
export function eraseBackground(
  image: { data: Uint8ClampedArray; width: number; height: number },
  mask: Float32Array,
  fit: MaskFit,
): void {
  const { width: w, height: h } = image;
  for (let y = 0; y < h; y++) {
    // Sampled bilinearly. Nearest neighbour stretched each mask pixel across
    // two or three of the image's, so the boundary came out as steps and each
    // step carried a little of the background with it.
    const fy = Math.min(fit.height - 1, (y / h) * fit.height);
    const y0 = Math.floor(fy);
    const y1 = Math.min(fit.height - 1, y0 + 1);
    const wy = fy - y0;

    for (let x = 0; x < w; x++) {
      const fx = Math.min(fit.width - 1, (x / w) * fit.width);
      const x0 = Math.floor(fx);
      const x1 = Math.min(fit.width - 1, x0 + 1);
      const wx = fx - x0;

      const alpha =
        mask[y0 * MASK_EDGE + x0] * (1 - wx) * (1 - wy) +
        mask[y0 * MASK_EDGE + x1] * wx * (1 - wy) +
        mask[y1 * MASK_EDGE + x0] * (1 - wx) * wy +
        mask[y1 * MASK_EDGE + x1] * wx * wy;
      const p = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        image.data[p + c] = image.data[p + c] * alpha + 255 * (1 - alpha);
      }
      image.data[p + 3] = 255;
    }
  }
}
