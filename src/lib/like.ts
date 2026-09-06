/**
 * Safe LIKE patterns for D1.
 *
 * SQLite refuses a pattern over `SQLITE_MAX_LIKE_PATTERN_LENGTH` with "LIKE or
 * GLOB pattern too complex", and on D1 that ceiling is 50 bytes - counted in
 * UTF-8, not in characters, and counting the wildcards.
 *
 * That distinction is the whole bug this module exists to prevent. A
 * 40-character stem is 40 bytes of English and about 80 of Arabic, because
 * Arabic sits in the two-byte range. So every listing whose title ran past
 * roughly twenty-four Arabic letters threw a 500 on the portal's own page for
 * it, while every English one was fine - and a shipment list is nothing but
 * long Arabic titles.
 *
 * Every search box that reaches a LIKE goes through here, so the ceiling is
 * enforced in one place rather than remembered in several.
 */

/**
 * The budget for the text itself, leaving room for the wildcards around it.
 *
 * Forty rather than forty-eight because a caller may wrap the result in `%…%`
 * and escape a wildcard or two, and a pattern that is refused is a 500 on a
 * page rather than a narrower search.
 */
export const LIKE_BYTES = 40;

/** Cut to at most `bytes` UTF-8 bytes, never through the middle of a letter. */
export function clipToBytes(value: string, bytes: number = LIKE_BYTES): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).length <= bytes) return value;
  let out = '';
  let used = 0;
  /* Iterating the string yields whole code points, so a surrogate pair is
     never split - which would leave a lone half and a broken pattern. */
  for (const ch of value) {
    const size = encoder.encode(ch).length;
    if (used + size > bytes) break;
    out += ch;
    used += size;
  }
  return out;
}

/**
 * Arabic as it is typed, versus Arabic as it is stored.
 *
 * A supplier's list carries full pointing - fatha, damma, shadda - and an
 * owner hunting for a title types the bare letters. Stripping the marks from
 * both sides is what lets one find the other. The alef family and the two
 * final letters that are written either way are folded for the same reason:
 * أ إ آ are all typed as ا, ى as ي, and ة as ه, and which one a supplier used
 * is not something anyone should have to guess at while searching.
 */
const MARKS = /[ً-ٰٟۖ-ۭـ]/g;

export function foldArabic(value: string): string {
  return value
    .replace(MARKS, '')
    .replace(/[آأإٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .toLowerCase();
}

/**
 * A `%needle%` pattern that D1 will accept, or null when there is nothing to
 * search for.
 *
 * The LIKE wildcards inside the query text are escaped, so a search for "50%"
 * looks for a percent sign rather than matching everything. Callers pair this
 * with `ESCAPE '\'`.
 */
export function likeNeedle(query: string, bytes: number = LIKE_BYTES): string | null {
  const trimmed = query.trim();
  if (!trimmed) return null;
  /*
   * Escaping and clipping have to happen together, not one then the other.
   *
   * Escaping grows the pattern - a `%` becomes two bytes, not one - so
   * clipping first can still overrun the ceiling, and clipping afterwards can
   * cut between a backslash and the character it escapes, which leaves a
   * dangling escape at the end of the pattern. Measuring each escaped
   * character against the budget before adding it avoids both.
   */
  const encoder = new TextEncoder();
  let out = '';
  let used = 0;
  for (const ch of trimmed) {
    const piece = /[\\%_]/.test(ch) ? `\\${ch}` : ch;
    const size = encoder.encode(piece).length;
    if (used + size > bytes) break;
    out += piece;
    used += size;
  }
  if (!out) return null;
  return `%${out}%`;
}
