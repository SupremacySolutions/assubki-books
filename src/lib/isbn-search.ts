/**
 * Candidate ISBNs for a title, for a person to choose between.
 *
 * Built the way `cover-search.ts` is, and for the same reason: Open Library is
 * keyless and free, its coverage of what this shop sells is patchy, and the
 * right answer to patchy coverage is to show the owner what came back rather
 * than to guess on their behalf.
 *
 * **It must never fill the field on its own.** One title returns many editions
 * with different numbers - "Riyad as-Salihin" comes back with three works and
 * eight ISBNs - and the shop stocks one of them. A wrong ISBN is worse than an
 * empty one: Google matches the listing to a different book, and the shop's
 * price then looks wrong against a different edition.
 */

const SEARCH = 'https://openlibrary.org/search.json';

export interface IsbnCandidate {
  /** ISBN-13 where the edition has one, otherwise the ISBN-10 it published as. */
  isbn: string;
  title: string;
  /** The publisher and year, which is how a person tells editions apart. */
  detail: string;
}

/** Digits only, so a hyphenated number and a bare one are the same number. */
export function normaliseIsbn(raw: string): string {
  return raw.replace(/[^0-9Xx]/g, '').toUpperCase();
}

/** Length and check-digit, so a typo is caught before it reaches a feed. */
export function validIsbn(raw: string): boolean {
  const n = normaliseIsbn(raw);
  if (n.length === 13) {
    if (!/^\d{13}$/.test(n)) return false;
    const sum = [...n].reduce((t, d, i) => t + Number(d) * (i % 2 ? 3 : 1), 0);
    return sum % 10 === 0;
  }
  if (n.length === 10) {
    if (!/^\d{9}[\dX]$/.test(n)) return false;
    const sum = [...n].reduce(
      (t, d, i) => t + (d === 'X' ? 10 : Number(d)) * (10 - i),
      0,
    );
    return sum % 11 === 0;
  }
  return false;
}

export async function findIsbns(terms: string, signal?: AbortSignal): Promise<IsbnCandidate[]> {
  const query = terms.trim();
  if (query.length < 3) return [];

  try {
    const res = await fetch(
      `${SEARCH}?q=${encodeURIComponent(query)}&limit=10&fields=title,isbn,publisher,first_publish_year`,
      { signal, headers: { 'User-Agent': 'assubki-books (shop ISBN lookup)' } },
    );
    if (!res.ok) return [];

    const body = (await res.json()) as {
      docs?: {
        title?: string;
        isbn?: string[];
        publisher?: string[];
        first_publish_year?: number;
      }[];
    };

    const seen = new Set<string>();
    const out: IsbnCandidate[] = [];

    for (const doc of body.docs ?? []) {
      // Thirteen-digit numbers first: that is what a feed wants, and an
      // edition that has both is the same book either way.
      const numbers = (doc.isbn ?? []).map(normaliseIsbn).filter(validIsbn);
      const preferred = numbers.find((n) => n.length === 13) ?? numbers[0];
      if (!preferred || seen.has(preferred)) continue;
      seen.add(preferred);

      const bits = [doc.publisher?.[0], doc.first_publish_year].filter(Boolean);
      out.push({
        isbn: preferred,
        title: (doc.title ?? '').slice(0, 120),
        detail: bits.join(' · ').slice(0, 60) || 'Open Library',
      });
      if (out.length === 8) break;
    }

    return out;
  } catch {
    // A lookup that cannot reach Open Library is an empty list, not an error:
    // typing the number in by hand is the fallback and always works.
    return [];
  }
}
