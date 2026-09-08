/**
 * How a cover sits in the box the site gives it.
 *
 * Its own module, with no imports, so it can be checked outside a browser -
 * this is the one piece of the change that decides whether a customer sees a
 * clipped title, and it is not something to infer from ratios by eye.
 */

/**
 * Whether this cover can be cropped to fill the cover box without losing any of
 * the book.
 *
 * The boxes are already one size everywhere; what varies is how much of one
 * each cover fills, because covers keep their own proportions. Cropping makes
 * them identical - and on these scans it also removes the white margin they
 * carry, about 3.6% down each side, which is what made the shelf look right.
 *
 * The rule is deliberately narrower than "close enough":
 *
 * - **Only sideways.** A cover wider than the box is filled by scaling to its
 *   height and trimming width, so the trim lands on those side margins. A
 *   cover *taller* than the box would be trimmed top and bottom, which is exactly
 *   where a title sits, so it is never cropped.
 * - **Only a little.** Past MAX_TRIM the trim stops being margin and starts
 *   being the book, so it pads instead.
 * - **Only when the shape is known.** An owner's upload with no stored
 *   dimensions is padded; there is nothing to reason about.
 */
/*
 * 5:7, which is what this catalogue is actually shaped like.
 *
 * It was 3:4, chosen before there were enough covers to measure. Across the
 * 209 primary covers the median is 0.713 and the middle half runs 0.677 to
 * 0.741 - so 3:4 sat above almost all of them and took a slice off the foot of
 * every one. At 5:7 the average cover loses 4.5% to the crop rather than 6.4%,
 * and the number losing more than a tenth of themselves falls from 50 to 12.
 *
 * Worth recording that the obvious answer is wrong here: 2:3, which the shops
 * with the tidiest covers use, measures *worse* on these books than the 3:4 it
 * would replace. Their catalogue is a different shape from this one.
 */
const BOX_RATIO = 5 / 7;
/**
 * Share of the width that may be trimmed.
 *
 * Several otherwise clean catalogue photos are 4:5 (640x800 or 400x500),
 * including the Al-Hidayah set the owner flagged, and those should fill the
 * well - the trim comes off their white side margins and reaches nothing.
 *
 * The figure moved with the box. A narrower box takes a wider slice off the
 * same picture: 4:5 lost 6.25% against 3:4 and loses 10.7% against 5:7, so the
 * old seven percent would now turn away the very shape it was written to
 * admit. Twelve keeps that shape, and still refuses 0.83 and wider, where the
 * trim stops being margin and starts being artwork.
 */
const MAX_TRIM = 0.12;

export function cropsCleanly(
  width: number | null | undefined,
  height: number | null | undefined,
): boolean {
  if (!width || !height || width <= 0 || height <= 0) return false;
  const ratio = width / height;
  if (ratio < BOX_RATIO) return false; // would trim the top and bottom
  return (ratio - BOX_RATIO) / ratio <= MAX_TRIM;
}

/**
 * How far from the box a picture may sit and still be treated as a cover.
 *
 * A spine is about 0.2 and a wide detail shot about 1.5; a cover is within a
 * few percent of 0.714 either way. This is the line between them, and it is
 * the same band the upload's own `frameToBox` uses to decide what not to frame
 * - exported rather than written twice, because the shape a photo is stored at
 * and the shape it is shown at cannot be allowed to disagree.
 */
export const SHAPE_TOLERANCE = 0.88;

/**
 * Whether this picture should fill the cover box rather than sit inside it.
 *
 * A different question from `cropsCleanly`, and the distinction is the whole
 * point. `cropsCleanly` asks "can this be cropped without losing artwork?" -
 * the right question when deciding whether to *trim*. This asks "is this a
 * cover at all?", which is what decides whether to *fill*.
 *
 * Answering the first question with the second is how the shop briefly
 * letterboxed 121 of its 217 covers. The catalogue's median cover is 0.713 and
 * `BOX_RATIO` is 0.714, so more than half of them are a hair narrower than the
 * box - `cropsCleanly` says no to every one of those, correctly, because they
 * would lose a sliver top and bottom. That sliver is a rounding error, not a
 * title; padding the cover away from the edges of its own frame to avoid it is
 * the padded cut-out look that was compared against full bleed and rejected.
 *
 * So an ordinary cover fills its box however slightly it differs from it, and
 * only a genuine outlier - a spine, a photograph of a page - is contained.
 */
export function fillsTheBox(
  width: number | null | undefined,
  height: number | null | undefined,
): boolean {
  // Nothing known, nothing assumed - and filling is what the page did for
  // every cover before any of this, so an unmeasured upload keeps that.
  if (!width || !height || width <= 0 || height <= 0) return true;
  const ratio = width / height;
  return ratio >= BOX_RATIO * SHAPE_TOLERANCE && ratio <= BOX_RATIO / SHAPE_TOLERANCE;
}
