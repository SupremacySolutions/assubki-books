/**
 * Addresses made from a title, for the things that did not have one.
 *
 * Shipments and pre-orders were reached by their row number, which says
 * nothing in a chat - "/shipments/3" could be anything. The title already says
 * where a shipment is from and when it lands, so the address is the title.
 *
 * Arabic and Urdu letters are dropped rather than transliterated: a title with
 * nothing else in it falls back to the caller's `fallback`, which is always
 * something readable.
 */

export function slugify(text: string, max = 70): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[؀-ۿݐ-ݿﭐ-﻿]/g, '')
    .toLowerCase()
    .replace(/['’ʿʾ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
}

/**
 * A slug nothing else holds, trying `base`, `base-2`, `base-3`…
 *
 * Never all digits: a numeric address is how the old links arrive, and the
 * routes read one as a row number to redirect.
 */
export async function freeSlug(
  base: string,
  fallback: string,
  taken: (slug: string) => Promise<boolean>,
): Promise<string> {
  const root = base && !/^\d+$/.test(base) ? base : fallback;
  for (let n = 1; n < 50; n++) {
    const candidate = n === 1 ? root : `${root}-${n}`;
    if (!(await taken(candidate))) return candidate;
  }
  return `${fallback}-${Date.now().toString(36)}`;
}

/** Only what `slugify` can produce - checked before a slug reaches a query. */
export const isSlug = (value: string): boolean => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 80;
