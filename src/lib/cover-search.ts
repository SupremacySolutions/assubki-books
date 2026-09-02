/**
 * Looking for a cover the shop has no photo of.
 *
 * Open Library, because it is the only book database that is genuinely free
 * to call: no key, no account, no quota. Google Books was the obvious choice
 * and turned out not to work - keyless requests share one anonymous project
 * whose daily quota is routinely exhausted, and it answered 429 rather than
 * anything useful.
 *
 * It will find the well-known titles and miss most of the rest. There are no
 * ISBNs in the shop's stock lists, and Turath, Zamzam, Mustafah and
 * Whitethread are not catalogued anywhere free - Mukhtasar al-Quduri returns
 * thirty-three editions and a cover for none of them. This turns some of the
 * work into one click; it does not finish it, which is why uploading a photo
 * stands beside it as an equal choice rather than a fallback.
 *
 * The search runs on the server, so the site's `connect-src` stays shut.
 */

const SEARCH = 'https://openlibrary.org/search.json';

export interface Candidate {
  /**
   * Open Library's cover id, not a URL.
   *
   * The site's CSP is `img-src 'self'`, so the browser cannot load a cover
   * from another origin however good it is. Everything goes through
   * `/api/admin/covers/image`, and handing out an id rather than a URL is what
   * keeps that from being forgotten.
   */
  id: number;
  title: string;
  source: string;
}

export async function findCovers(terms: string, signal?: AbortSignal): Promise<Candidate[]> {
  const query = terms.trim();
  if (query.length < 3) return [];

  try {
    const res = await fetch(
      `${SEARCH}?q=${encodeURIComponent(query)}&limit=20&fields=title,cover_i,publisher`,
      { signal, headers: { 'User-Agent': 'assubki-books (shop cover lookup)' } },
    );
    if (!res.ok) return [];

    const body = (await res.json()) as {
      docs?: { title?: string; cover_i?: number; publisher?: string[] }[];
    };

    const seen = new Set<number>();
    const out: Candidate[] = [];

    for (const doc of body.docs ?? []) {
      const id = doc.cover_i;
      if (!id || seen.has(id)) continue;
      seen.add(id);

      out.push({
        id,
        title: (doc.title ?? '').slice(0, 120),
        source: doc.publisher?.[0]?.slice(0, 50) ?? 'Open Library',
      });
      if (out.length === 6) break;
    }

    return out;
  } catch {
    // Offline, blocked, rate-limited or malformed - all the same to the owner,
    // who gets the empty state and the upload button either way.
    return [];
  }
}
