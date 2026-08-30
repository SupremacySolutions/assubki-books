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
