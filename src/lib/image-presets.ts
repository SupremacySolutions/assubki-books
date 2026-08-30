/**
 * One frame for every book photo.
 *
 * The covers arrived in every shape there is - 617×800 for most, but also
 * 88×800 spines and 800×450 landscape scans - so the grid showed ragged
 * whitespace and the hero, the only place that crops, cut the spines to
 * nothing.
 *
 * They are all framed now, and framed *before* they are stored, by
 * scripts/standardise-covers.mjs: a 3:4 frame on the paper colour, the cover
 * fitted whole inside it, and the shop's mark in a reserved band along the
 * bottom. Every preset below is a separate stored object; the route falls back
 * to the master for any that is missing. Nothing is transformed per request -
 * Cloudflare Images is not enabled on this account, and is not free.
 *
 * Padding rather than cropping keeps a wide format or a spine whole, and
 * because every frame is filled with the same colour, the hero can go on
 * cropping without ever eating a cover.
 */

/** The site's own paper colour, so a padded cover sits on the page invisibly. */
export const FRAME_BACKGROUND = '#f5f4f0';

/**
 * Bumped whenever the frame itself changes.
 *
 * A re-run writes over the same keys, and those keys are served `immutable`
 * for a year - so without this, anyone who had already seen a cover would keep
 * the old frame long after it was replaced, and there is no purge that reaches
 * a browser. Carrying the version in the URL makes a new frame a new cache
 * entry instead.
 *
 * 2: the mark moved off the artwork and into a reserved band.
 */
export const FRAME_VERSION = 2;

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
  /** The cover on a book's own page. */
  detail: { width: 420, height: 560, scale: 2 },
  /** Admin lists and the thumbnail strip. */
  thumb: { width: 88, height: 117, scale: 2 },
  /** Telegram, which shows a square well and crops anything taller. */
  social: { width: 600, height: 600, scale: 1 },
} as const;

export type PresetName = keyof typeof IMAGE_PRESETS;

export const isPreset = (name: string): name is PresetName => name in IMAGE_PRESETS;
