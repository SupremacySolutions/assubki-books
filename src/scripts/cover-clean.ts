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
  const raw = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) raw[i] = dist[i] > cut ? 1 : 0;

  /*
   * Corners come from the cover's four *sides*, not from its four furthest
   * pixels.
   *
   * Taking the extremes of x+y and x-y is the obvious way to corner a blob and
   * it was what this did, but it stakes each corner on a single pixel: one
   * speck of anything joined to the cover, and that corner leaves for the far
   * side of the frame, which is where the wrong-shaped crops came from.
   * Fitting a line to each edge instead puts every boundary pixel to work, so
   * no single one can move the answer - and intersecting the fitted lines
   * recovers the true corner even when the photo has rounded it off.
   */
  const attempt = (radius: number): Point[] | null => {
    // Opened before anything is measured. A cast shadow, a sleeve or the edge
    // of the next book along reaches the mask as a limb joined to the cover;
    // eroding then dilating by the same amount snaps anything narrower than
    // twice the radius and leaves the cover itself its own size.
    const region = largestRegion(open(raw, w, h, radius), w, h);
    // Too little to be a book. Better to offer the whole frame and let the
    // owner drag than to crop confidently to a shadow.
    if (!region || region.length < w * h * 0.08) return null;

    const edge = outline(region, w, h);
    const rect = minAreaRect(convexHull(edge));
    if (!rect) return null;

    const quad = refineSides(edge, rect);
    return isSane(quad, w, h, region.length) ? canonical(quad) : null;
  };

  /*
   * Widened until it works, rather than opened hard from the start.
   *
   * How thick a limb has to be before it stops mattering is a property of the
   * photo, not something to settle in advance: open too little and a shadow
   * still steers the crop, too much and a slim book is thinned away. So take
   * the narrowest opening that yields a book-shaped answer, and only reach for
   * a broader one when the cheaper reading did not produce one.
   */
  const base = Math.max(1, Math.round(Math.min(w, h) / 160));
  for (const radius of [base, base * 2, base * 4]) {
    const quad = attempt(radius);
    // A fitted line can cross outside the picture when the cover runs off the
    // edge of it. There is nothing out there to sample, so bring it back in.
    if (quad) {
      return quad.map((p) => ({
        x: Math.min(w, Math.max(0, p.x)),
        y: Math.min(h, Math.max(0, p.y)),
      }));
    }
  }
  return null;
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

/**
 * Morphological opening: erode `r` times, then dilate `r` times.
 *
 * Anything thinner than 2r across does not survive the erosion and so is gone
 * for good; everything wider is put back to the size it started at.
 */
function open(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  let m = mask;
  for (let i = 0; i < r; i++) m = morph(m, w, h, true);
  for (let i = 0; i < r; i++) m = morph(m, w, h, false);
  return m;
}

/**
 * One pass of erosion or dilation over the four neighbours.
 *
 * Off the edge of the picture counts as whatever the pixel itself is, so a
 * cover running off the frame is not eaten away from that side.
 */
function morph(mask: Uint8Array, w: number, h: number, erode: boolean): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const self = mask[i];
      const at = (nx: number, ny: number) =>
        nx < 0 || ny < 0 || nx >= w || ny >= h ? self : mask[ny * w + nx];
      const n = [at(x - 1, y), at(x + 1, y), at(x, y - 1), at(x, y + 1), self];
      out[i] = erode ? (n.every((v) => v) ? 1 : 0) : n.some((v) => v) ? 1 : 0;
    }
  }
  return out;
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
 * The outline of a blob: the first and last pixel of every row and column.
 *
 * For anything convex that set contains the whole boundary that matters,
 * corners included, at O(w + h) points rather than the region's own size -
 * which is what makes hulling it cheap enough to run on every frame.
 */
function outline(region: Int32Array, w: number, h: number): Point[] {
  const minX = new Int32Array(h).fill(-1);
  const maxX = new Int32Array(h).fill(-1);
  const minY = new Int32Array(w).fill(-1);
  const maxY = new Int32Array(w).fill(-1);

  for (let n = 0; n < region.length; n++) {
    const i = region[n];
    const x = i % w;
    const y = (i / w) | 0;
    if (minX[y] < 0 || x < minX[y]) minX[y] = x;
    if (maxX[y] < 0 || x > maxX[y]) maxX[y] = x;
    if (minY[x] < 0 || y < minY[x]) minY[x] = y;
    if (maxY[x] < 0 || y > maxY[x]) maxY[x] = y;
  }

  const pts: Point[] = [];
  for (let y = 0; y < h; y++) {
    if (minX[y] >= 0) pts.push({ x: minX[y], y }, { x: maxX[y], y });
  }
  for (let x = 0; x < w; x++) {
    if (minY[x] >= 0) pts.push({ x, y: minY[x] }, { x, y: maxY[x] });
  }
  return pts;
}

/** Andrew's monotone chain. Collinear points are dropped. */
function convexHull(pts: Point[]): Point[] {
  if (pts.length < 3) return pts.slice();
  const sorted = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: Point, a: Point, b: Point) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const chain = (order: Point[]): Point[] => {
    const out: Point[] = [];
    for (const p of order) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };

  return [...chain(sorted), ...chain([...sorted].reverse())];
}

/**
 * The smallest rectangle enclosing the hull, at any rotation.
 *
 * Rotating calipers: the minimum-area rectangle always shares an edge with the
 * hull, so trying each hull edge as the rectangle's direction and keeping the
 * cheapest is exact. This is only a starting frame - it fixes the orientation
 * and tells `refineSides` which points belong to which edge - so the fact that
 * a rectangle cannot express perspective does not matter here.
 */
function minAreaRect(hull: Point[]): Point[] | null {
  if (hull.length < 3) return null;
  let best: Point[] | null = null;
  let bestArea = Infinity;

  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-9) continue;

    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const vx = -uy;
    const vy = ux;

    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of hull) {
      const u = p.x * ux + p.y * uy;
      const v = p.x * vx + p.y * vy;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }

    const area = (maxU - minU) * (maxV - minV);
    if (area >= bestArea) continue;
    bestArea = area;
    const at = (u: number, v: number): Point => ({ x: u * ux + v * vx, y: u * uy + v * vy });
    best = [at(minU, minV), at(maxU, minV), at(maxU, maxV), at(minU, maxV)];
  }
  return best;
}

interface Line {
  nx: number;
  ny: number;
  o: number;
}

/**
 * The rectangle's four sides, each pulled onto the hull points lying along it,
 * then intersected back into corners.
 *
 * This is the step that restores perspective: four independent lines can meet
 * as a trapezoid, which is what a cover photographed at an angle actually is,
 * where the enclosing rectangle could only ever be square-on.
 *
 * Fitted to the outline rather than to the hull it came from. The hull is the
 * right input for finding the rectangle and the wrong one for fitting to it:
 * building it discards every point that lies along a side, which is precisely
 * the set each side needs, and leaves only the corners this then excludes.
 */
function refineSides(edge: Point[], rect: Point[]): Point[] {
  const diag = Math.hypot(rect[2].x - rect[0].x, rect[2].y - rect[0].y);
  const band = Math.max(2, diag * 0.06);

  const lines = rect.map((a, i): Line | null => {
    const b = rect[(i + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-9) return null;
    const side: Line = { nx: -(b.y - a.y) / len, ny: (b.x - a.x) / len, o: 0 };
    side.o = side.nx * a.x + side.ny * a.y;

    // Points are taken from the middle of the side, never its ends. Within a
    // band this wide the corners belong to two sides at once, and letting each
    // fit claim them bends both lines towards the corner they share.
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const along = (p: Point) => ((p.x - a.x) * ux + (p.y - a.y) * uy) / len;
    const near = edge.filter((p) => {
      const t = along(p);
      return t > 0.1 && t < 0.9 && Math.abs(side.nx * p.x + side.ny * p.y - side.o) <= band;
    });
    if (near.length < 2) return side;

    // Fitted twice, the second time without whatever sat furthest from the
    // first line. One pass is enough to shrug off a nick in the cover's edge
    // without letting a genuinely curved edge be whittled down to a chord.
    const first = fitLine(near);
    const off = near.map((p) => Math.abs(first.nx * p.x + first.ny * p.y - first.o));
    const limit = 2 * median([...off]) + 1;
    const kept = near.filter((_, i) => off[i] <= limit);
    return kept.length >= 2 ? fitLine(kept) : first;
  });

  return rect.map((corner, i) => intersect(lines[(i + 3) % 4], lines[i]) ?? corner);
}

/**
 * The line of best fit through some points, by total least squares.
 *
 * Total least squares rather than the usual kind because a cover's edge can be
 * vertical, and fitting y from x has no answer there.
 */
function fitLine(pts: Point[]): Line {
  let mx = 0;
  let my = 0;
  for (const p of pts) {
    mx += p.x;
    my += p.y;
  }
  mx /= pts.length;
  my /= pts.length;

  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of pts) {
    const dx = p.x - mx;
    const dy = p.y - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }

  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const nx = -Math.sin(theta);
  const ny = Math.cos(theta);
  return { nx, ny, o: nx * mx + ny * my };
}

/** Where two lines meet, or null if they are parallel. */
function intersect(a: Line | null, b: Line | null): Point | null {
  if (!a || !b) return null;
  const det = a.nx * b.ny - a.ny * b.nx;
  if (Math.abs(det) < 1e-9) return null;
  return {
    x: (a.o * b.ny - b.o * a.ny) / det,
    y: (a.nx * b.o - b.nx * a.o) / det,
  };
}

/**
 * A quad worth offering: the shape a book can actually be.
 *
 * The old version asked only that it was big enough and not folded up, which
 * let through wedges and slivers - the crops that came back at proportions
 * nothing on a shelf has. A cover is a rectangle, so under perspective its
 * opposite sides stay comparable, its corners stay near square, and it stays
 * within the range of shapes a book is printed in. Anything else is the
 * detector having found something that is not the book, and the honest answer
 * then is the whole frame and four handles to drag.
 */
function isSane(quad: Point[], w: number, h: number, regionArea: number): boolean {
  const area = Math.abs(polygonArea(quad));
  if (area < w * h * 0.06) return false;

  const side = (i: number) =>
    Math.hypot(quad[(i + 1) % 4].x - quad[i].x, quad[(i + 1) % 4].y - quad[i].y);

  // Every side has to have some length, or the "quad" is a triangle and the
  // warp would divide by nothing.
  for (let i = 0; i < 4; i++) if (side(i) < Math.min(w, h) * 0.05) return false;

  const paired = (a: number, b: number) => a / b >= 0.6 && a / b <= 1 / 0.6;
  if (!paired(side(0), side(2)) || !paired(side(1), side(3))) return false;

  for (let i = 0; i < 4; i++) {
    const prev = quad[(i + 3) % 4];
    const here = quad[i];
    const next = quad[(i + 1) % 4];
    let turn = Math.abs(
      Math.atan2(prev.y - here.y, prev.x - here.x) - Math.atan2(next.y - here.y, next.x - here.x),
    );
    if (turn > Math.PI) turn = 2 * Math.PI - turn;
    const degrees = (turn * 180) / Math.PI;
    if (degrees < 55 || degrees > 125) return false;
  }

  const across = (side(0) + side(2)) / 2;
  const down = (side(1) + side(3)) / 2;
  if (Math.max(across, down) / Math.min(across, down) > 2.4) return false;

  // And it has to hug what it came from. A quad much larger than the blob it
  // was fitted to means the blob was not rectangular in the first place.
  return regionArea / area >= 0.7;
}

/**
 * Clockwise from the top left, which is the order the warp reads.
 *
 * `minAreaRect` starts from whichever hull edge happened to win, so its corners
 * arrive at any rotation - and `warp` sends the first one to the output's top
 * left, so an unspun quad would come out of the cleaner lying on its side.
 */
function canonical(quad: Point[]): Point[] {
  // Shoelace is positive for clockwise order once y points down the screen.
  const turned = polygonArea(quad) > 0 ? quad : [...quad].reverse();
  let first = 0;
  for (let i = 1; i < turned.length; i++) {
    if (turned[i].x + turned[i].y < turned[first].x + turned[first].y) first = i;
  }
  return turned.map((_, i) => turned[(first + i) % turned.length]);
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
