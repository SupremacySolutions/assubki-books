/**
 * One frame for every book photo.
 *
 * The covers arrived in every shape there is - 617×800 for most, but also
 * 88×800 spines and 800×450 landscape scans - so the grid showed ragged
 * whitespace and the hero, the only place that crops, cut the spines to
 * nothing.
 *
 * Rather than rewrite 454 stored images, each is padded into a 3:4 frame **as
 * it is served**. The stored bytes never change, which matters: their keys are
 * cached `immutable`, and Telegram keeps its own copy of any cover it has
 * posted and cannot be made to replace it. Reprocessing in place would reach
 * nobody; new keys would break every channel post.
 *
 * Padding rather than cropping keeps a wide format or a spine whole, and
 * because every frame is filled with the same colour, the hero can go on
 * cropping without ever eating a cover.
 */

/** The site's own paper colour, so a padded cover sits on the page invisibly. */
export const FRAME_BACKGROUND = '#f5f4f0';

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
