/**
 * The sizes a book photo is shown at.
 *
 * Each one is stored beside the original in R2 by scripts/resize-covers.mjs,
 * and `?p=<name>` picks it. The photo itself is untouched - same crop, same
 * colours, nothing added. The point is only that the home page should not be
 * sent an 800px cover for an 84px slot.
 *
 * There was a framing pass here once, fitting every cover into a 3:4 frame on
 * the shop's paper colour with the rosette in the corner. The owner did not
 * want it - the books look better as they are - so it was reverted and only
 * the resizing kept.
 *
 * Nothing is transformed per request: that needs Cloudflare Images, which is
 * not enabled on this account and is not free. A size that was never made
 * falls back to the original, so a missing file is a heavy image rather than
 * a broken one.
 */

/**
 * Bumped whenever the stored bytes behind a key change.
 *
 * Covers are served `immutable` for a year, and a pass writes over the keys
 * that are already out there - so without this, anyone who has already loaded
 * the site keeps what they have indefinitely. No purge reaches a browser; only
 * a different URL does.
 *
 * 2: the mark moved off the artwork into a reserved band.
 * 3: the frame and mark removed altogether - back to the photo itself.
 * 4: scanner-white borders removed from covers that carry a full outer frame.
 * 5: every primary cover receives the same full-bleed 3:4 public variants.
 * 6: dark and transparent surrounds trimmed as well as white ones. The pass
 *    that did it rewrote 208 covers in place without bumping this, so a
 *    browser that had already loaded the catalogue kept the bordered card
 *    while the freshly-made detail variant came back clean - the same cover
 *    correct on the product page and wrong one click away.
 */
export const IMAGE_VERSION = 6;

export interface ImagePreset {
  /** Rendered width in CSS pixels - what the layout should reserve. */
  width: number;
  height: number;
  /** Pixels actually requested, so the image is sharp on a retina screen. */
  scale: number;
}

/**
 * A closed set, not free parameters. Transformations are billed per distinct
 * one, so an open `?w=` would let a stranger run up a bill by asking for every
 * width there is.
 */
export const IMAGE_PRESETS = {
  /** The drifting shelf on the home page. */
  hero: { width: 84, height: 112, scale: 2 },
  /** Catalogue grid and basket rows. */
  card: { width: 300, height: 400, scale: 2 },
  /**
   * The cover on a book's own page. A file is stored even when the source is
   * smaller, because this view also needs scanner-white borders removed.
   */
  detail: { width: 420, height: 560, scale: 2 },
  /** Admin lists and the thumbnail strip. */
  thumb: { width: 88, height: 117, scale: 2 },
  /** Telegram, which shows a square well and crops anything taller. */
  social: { width: 600, height: 600, scale: 1 },
} as const;

export type PresetName = keyof typeof IMAGE_PRESETS;

export const isPreset = (name: string): name is PresetName => name in IMAGE_PRESETS;
