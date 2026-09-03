/**
 * Looking for a cover the shop has no photo of.
 *
 * Open Library is keyless and its Search API can query title and author as
 * separate fields. One literal query was too brittle for this catalogue:
 * transliterated titles move between `Riyāḍ`, `Riyad`, hyphens and apostrophe
 * marks, and an edition suffix can hide an otherwise useful match. We ask a
 * small, bounded set of complementary queries, merge them, and rank the
 * visual candidates locally.
 */

const SEARCH = 'https://openlibrary.org/search.json';
const FIELDS = 'key,title,cover_i,publisher,author_name,first_publish_year,edition_count';
const MAX_RESULTS = 12;

export interface Candidate {
  /** Open Library's cover id, never an off-site URL. */
  id: number;
  title: string;
  /** Author, publisher and year: enough to distinguish nearby editions. */
  source: string;
}

interface SearchDoc {
  key?: string;
  title?: string;
  cover_i?: number;
  publisher?: string[];
  author_name?: string[];
  first_publish_year?: number;
  edition_count?: number;
}

/** Accent-, punctuation- and transliteration-insensitive comparison text. */
export function normaliseCoverSearch(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[ʿʾ‘’'`´]/gu, ' ')
    .replace(/\p{Mark}/gu, '')
    .toLocaleLowerCase('en')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Edition wording that is useful on the listing but weakens title search. */
export function simplifyCoverSearch(value: string): string {
  const withoutEditionBrackets = value
    .replace(/\([^)]*(?:vol(?:ume)?s?|set|hardback|paperback|edition)[^)]*\)/giu, ' ')
    .replace(/\[[^\]]*(?:vol(?:ume)?s?|set|hardback|paperback|edition)[^\]]*\]/giu, ' ');
  return normaliseCoverSearch(withoutEditionBrackets)
    .replace(/\b(?:full|complete)\s+set\b/gu, ' ')
    .replace(/\b(?:hardback|paperback)\b/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The actual Open Library requests, exposed so fallback behavior can be
 * regression-tested without depending on today's search index.
 */
export function coverSearchQueries(title: string, author = ''): string[] {
  const rawTitle = title.trim();
  const rawAuthor = author.trim();
  if (rawTitle.length < 2) return [];

  const foldedTitle = normaliseCoverSearch(rawTitle);
  const foldedAuthor = normaliseCoverSearch(rawAuthor);
  const simpleTitle = simplifyCoverSearch(rawTitle);
  const plans: URLSearchParams[] = [];

  const add = (params: Record<string, string>) => {
    const search = new URLSearchParams({ ...params, limit: '40', fields: FIELDS });
    if (!plans.some((p) => p.toString() === search.toString())) plans.push(search);
  };

  // Best precision first. Open Library documents title and author as
  // independent fields, and relevance ordering remains useful within them.
  add({ title: rawTitle, ...(rawAuthor ? { author: rawAuthor } : {}) });
  // A broad query finds alternate titles and editions that fielded search can
  // miss, and deliberately omits the author on a later pass.
  add({ q: [rawTitle, rawAuthor].filter(Boolean).join(' ') });
  if (foldedTitle && (foldedTitle !== rawTitle.toLocaleLowerCase('en') || foldedAuthor)) {
    add({ q: [foldedTitle, foldedAuthor].filter(Boolean).join(' ') });
  }
  if (simpleTitle && simpleTitle !== foldedTitle) add({ q: simpleTitle });
  else if (rawAuthor) add({ q: foldedTitle || rawTitle });

  return plans.slice(0, 4).map((p) => `${SEARCH}?${p}`);
}

const STOP = new Set(['a', 'al', 'an', 'ar', 'as', 'at', 'fi', 'of', 'the', 'wa']);
const words = (value: string): string[] =>
  normaliseCoverSearch(value).split(' ').filter((word) => word.length > 1 && !STOP.has(word));

function trigrams(value: string): Set<string> {
  const text = `  ${normaliseCoverSearch(value)}  `;
  const out = new Set<string>();
  for (let i = 0; i < text.length - 2; i++) out.add(text.slice(i, i + 3));
  return out;
}

function dice(a: string, b: string): number {
  const aa = trigrams(a);
  const bb = trigrams(b);
  if (!aa.size || !bb.size) return 0;
  let same = 0;
  for (const part of aa) if (bb.has(part)) same++;
  return (2 * same) / (aa.size + bb.size);
}

/** Stable ranking across results returned by the complementary queries. */
export function coverMatchScore(title: string, author: string, doc: SearchDoc): number {
  const wanted = normaliseCoverSearch(title);
  const got = normaliseCoverSearch(doc.title ?? '');
  const wantedWords = words(title);
  const gotWords = new Set(words(doc.title ?? ''));
  const coverage = wantedWords.length
    ? wantedWords.filter((word) => gotWords.has(word)).length / wantedWords.length
    : 0;
  const authorWords = words(author);
  const gotAuthor = new Set(words((doc.author_name ?? []).join(' ')));
  const authorCoverage = authorWords.length
    ? authorWords.filter((word) => gotAuthor.has(word)).length / authorWords.length
    : 0;

  return (
    (wanted === got ? 120 : 0) +
    (got.includes(wanted) || wanted.includes(got) ? 35 : 0) +
    coverage * 70 +
    dice(title, doc.title ?? '') * 40 +
    authorCoverage * 30 +
    Math.min(10, Math.log2(Math.max(1, doc.edition_count ?? 1)))
  );
}

export async function findCovers(
  title: string,
  author = '',
  signal?: AbortSignal,
): Promise<Candidate[]> {
  const queries = coverSearchQueries(title, author);
  if (!queries.length) return [];

  try {
    const responses = await Promise.allSettled(
      queries.map((url) =>
        fetch(url, {
          signal,
          headers: { 'User-Agent': 'assubki-books (shop cover lookup)' },
        }),
      ),
    );

    const docs: SearchDoc[] = [];
    for (const result of responses) {
      if (result.status !== 'fulfilled' || !result.value.ok) continue;
      const body = (await result.value.json()) as { docs?: SearchDoc[] };
      docs.push(...(body.docs ?? []));
    }

    const bestByCover = new Map<number, { doc: SearchDoc; score: number; order: number }>();
    for (const [order, doc] of docs.entries()) {
      const id = doc.cover_i;
      if (!id || !doc.title) continue;
      const score = coverMatchScore(title, author, doc);
      const before = bestByCover.get(id);
      if (!before || score > before.score) bestByCover.set(id, { doc, score, order });
    }

    return [...bestByCover.entries()]
      .sort((a, b) => b[1].score - a[1].score || a[1].order - b[1].order)
      .slice(0, MAX_RESULTS)
      .map(([id, { doc }]) => {
        const detail = [doc.author_name?.[0], doc.publisher?.[0], doc.first_publish_year]
          .filter(Boolean)
          .join(' · ')
          .slice(0, 110);
        return {
          id,
          title: doc.title!.slice(0, 120),
          source: detail || 'Open Library',
        };
      });
  } catch {
    // Offline, aborted or malformed: uploading a photo remains available.
    return [];
  }
}
