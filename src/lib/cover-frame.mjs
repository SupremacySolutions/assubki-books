/**
 * How a cover is made to fit the shop's frame.
 *
 * Written once and in plain JavaScript because two very different things have
 * to agree on it: `scripts/resize-covers.mjs`, which runs under Node with
 * sharp over the whole catalogue, and the portal's uploader, which runs in a
 * browser over a canvas. They used to be the same rule written twice, which is
 * how a cover added through the portal ended up framed differently from the
 * same cover put through the script.
 *
 * Nothing here touches pixels. It reads a measurement and returns a plan, so
 * it can be checked without an image library on either side.
 */

/** The public frame. Every primary variant is cut to this. */
export const BOX = 5 / 7;

/**
 * The most width worth inventing, as a share of the cover's own.
 *
 * Past this it stops being a cover with a wider margin and starts being a
 * cover somebody made up.
 */
export const MAX_EXTEND = 0.12;

/** How much an edge may vary and still count as plain enough to continue. */
export const PLAIN_EDGE = 12;

/*
 * There was a guard here that compared the outer column with one a little
 * inside, meaning to catch an edge that was an artefact rather than the
 * cover's own. It could not do it. Measured against real covers, a warp's
 * white line sat 170 from the cover behind it and a perfectly genuine pale
 * edge - Ulama-e-Deoband, which really is near-white down both sides - sat
 * 115. There is no threshold between those that does not throw away real
 * covers to catch a fault that no longer happens: the warp stopped painting
 * that line at source, which is the fix that mattered. Twenty-two covers were
 * being cropped to defend against it.
 */

/**
 * How much of the height may be lost before the title is worth protecting.
 *
 * Under this the trim is shared between both ends, which keeps a printed
 * border looking like a border. Over it the whole trim comes off the foot,
 * because titles sit at the top of nearly every one of these covers and half
 * of a large trim would reach them.
 */
export const SHARE_TRIM = 0.08;

/**
 * @typedef {(y: number) => [number, number, number]} ColumnReader
 *
 * @typedef {{ mode: 'extend', width: number, height: number, left: number, right: number }} Extend
 * @typedef {{ mode: 'crop', anchor: 'centre' | 'north' }} Crop
 * @typedef {Extend | Crop} FramePlan
 */

/**
 * How far one outer column strays from its own average.
 *
 * `read(y)` returns `[r, g, b]` at that row of the column being measured. A
 * low answer means flat colour, which is what makes a column safe to continue
 * outwards; a high one means a pattern or a photograph, where an extension
 * would show its join.
 *
 * @param {ColumnReader} read
 * @param {number} height
 * @param {number} [steps]
 * @returns {number}
 */
export function edgeSpread(read, height, steps = 60) {
  const samples = readColumn(read, height, steps);
  const mean = columnMean(samples);
  return (
    samples.reduce(
      (sum, v) => sum + Math.max(...[0, 1, 2].map((c) => Math.abs(v[c] - mean[c]))),
      0,
    ) / samples.length
  );
}

/** @param {ColumnReader} read @param {number} height @param {number} steps */
function readColumn(read, height, steps) {
  const samples = [];
  for (let i = 0; i < steps; i++) {
    samples.push(read(Math.min(height - 1, Math.round(((i + 0.5) / steps) * height))));
  }
  return samples;
}

/** @param {[number, number, number][]} samples @returns {[number, number, number]} */
function columnMean(samples) {
  const mean = [0, 1, 2].map((c) => samples.reduce((sum, v) => sum + v[c], 0) / samples.length);
  return /** @type {[number, number, number]} */ (mean);
}

/**
 * What to do with a cover of this shape.
 *
 * - `extend`: it is too narrow, and its sides are plain enough to continue
 *   outwards. Nothing is lost - the frame, the title and both printed rules
 *   all survive, which is the whole point.
 * - `crop`: everything else. `anchor` says which end gives way, and follows
 *   SHARE_TRIM above.
 *
 * `leftSpread`/`rightSpread` may be omitted, and then extending is not
 * considered - which is what a caller that cannot measure the edge should do.
 *
 * @param {{ width?: number, height?: number, leftSpread?: number, rightSpread?: number }} cover
 * @returns {FramePlan}
 */
export function framePlan({ width, height, leftSpread, rightSpread }) {
  if (!(typeof width === 'number' && width > 0) || !(typeof height === 'number' && height > 0)) {
    return { mode: 'crop', anchor: 'centre' };
  }

  const ratio = width / height;
  if (ratio < BOX) {
    const want = Math.round(height * BOX);
    const pad = want - width;
    const measured = Number.isFinite(leftSpread) && Number.isFinite(rightSpread);
    const plain = measured && leftSpread <= PLAIN_EDGE && rightSpread <= PLAIN_EDGE;
    if (pad > 0 && pad <= width * MAX_EXTEND && plain) {
      const left = Math.floor(pad / 2);
      return { mode: 'extend', width: want, height, left, right: pad - left };
    }
    // Too narrow to fill and not safe to widen, so height has to go.
    return { mode: 'crop', anchor: (BOX - ratio) / BOX <= SHARE_TRIM ? 'centre' : 'north' };
  }

  // Wider than the box: the trim lands on the sides, where centre is the only
  // sensible reading of it - a cover is not lopsided.
  return { mode: 'crop', anchor: 'centre' };
}
