/**
 * Telling whether two publisher names mean the same publisher.
 *
 * The publisher is free text in the portal, and the catalogue lists one entry
 * per spelling. Capitals and spacing are folded away on save (see
 * `canonicalPublisher` in db.ts), but "Zamzam", "Zam-Zam" and "Zam Zam
 * Publications" are all still distinct strings for the same imprint. This key
 * is what the portal compares them by to ask "did you mean...?". It only ever
 * prompts - it never rewrites a name on its own, because two genuinely
 * different publishers can share a key ("Dar al-Salam" in Cairo and
 * Darussalam in Riyadh), and only the owner knows which one is on the book.
 *
 * Pure, so the portal's browser script imports the same function.
 */

/* Words that describe the kind of business rather than naming it. "Zam Zam"
   and "Zam Zam Publishers" are one imprint. Only stripped from the end. */
const TRAILING = /\b(publishers?|publishing|publications?|press|books|house|ltd|limited|inc|co)\b[\s.,&]*$/i;

export function publisherKey(name: string): string {
  let s = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim();
  // Twice, for "Zam Zam Publishing House".
  for (let i = 0; i < 2; i++) s = s.replace(TRAILING, '').trim();
  return s.replace(/[^\p{L}\p{N}]/gu, '');
}

/** Collapses runs of spaces and trims - how a name is stored. */
export function tidyPublisher(name: string): string {
  return name.replace(/\s+/g, ' ').trim();
}
