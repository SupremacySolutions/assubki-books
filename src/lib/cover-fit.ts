/**
 * How a cover sits in the box the site gives it.
 *
 * Its own module, with no imports, so it can be checked outside a browser -
 * this is the one piece of the change that decides whether a customer sees a
 * clipped title, and it is not something to infer from ratios by eye.
 */

/**
 * Whether this cover can be cropped to fill a 3:4 box without losing any of
 * the book.
 *
 * The boxes are already one size everywhere; what varies is how much of one
 * each cover fills, because covers keep their own proportions. Cropping makes
 * them identical - and on these scans it also removes the white margin they
 * carry, about 3.6% down each side, which is what made the shelf look right.
 *
 * The rule is deliberately narrower than "close enough":
 *
 * - **Only sideways.** A cover wider than 3:4 is filled by scaling to its
 *   height and trimming width, so the trim lands on those side margins. A
 *   cover *taller* than 3:4 would be trimmed top and bottom, which is exactly
 *   where a title sits, so it is never cropped.
 * - **Only a little.** Past MAX_TRIM the trim stops being margin and starts
 *   being the book, so it pads instead.
 * - **Only when the shape is known.** An owner's upload with no stored
 *   dimensions is padded; there is nothing to reason about.
 */
const BOX_RATIO = 3 / 4;
/**
 * Share of the width that may be trimmed.
 *
 * Several otherwise clean catalogue photos are 4:5 (640x800 or 400x500),
 * including the Al-Hidayah set the owner flagged. Filling a 3:4 well trims
 * 6.25% of those images in total, all from their white side margins. Seven
 * percent admits that common scan shape while still rejecting meaningfully
 * wider covers.
 */
const MAX_TRIM = 0.07;

export function cropsCleanly(
  width: number | null | undefined,
  height: number | null | undefined,
): boolean {
  if (!width || !height || width <= 0 || height <= 0) return false;
  const ratio = width / height;
  if (ratio < BOX_RATIO) return false; // would trim the top and bottom
  return (ratio - BOX_RATIO) / ratio <= MAX_TRIM;
}
