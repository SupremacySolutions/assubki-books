/**
 * Candidate cover discovery for the owner.
 *
 * Open Library is useful and keyless, but a work search exposes only one
 * representative cover even when several editions have their own artwork.
 * We therefore expand the best work matches through the editions endpoint.
 * Google Books is an optional, independent second source; its API requires a
 * key, and its result order must be preserved rather than mixed into our local
 * Open Library ranking.
 */

import { normaliseIsbn, validIsbn } from './isbn-search.ts';

const OPEN_LIBRARY = 'https://openlibrary.org';
const OPEN_LIBRARY_SEARCH = `${OPEN_LIBRARY}/search.json`;
const GOOGLE_BOOKS = 'https://www.googleapis.com/books/v1/volumes';
const OPEN_LIBRARY_FIELDS =
  'key,title,cover_i,publisher,author_name,first_publish_year,edition_count';
const MAX_PER_PROVIDER = 8;
const REQUEST_TIMEOUT_MS = 7_000;

export type CoverProvider = 'openlibrary' | 'google';
export type ProviderState = 'available' | 'unavailable' | 'not-configured';

export interface Candidate {
  /** A provider-owned id, never an off-site URL. */
  id: string;
  provider: CoverProvider;
  title: string;
  /** Author, publisher and date: enough to distinguish nearby editions. */
  source: string;
}

export interface ProviderReport {
  state: ProviderState;
  count: number;
}

export interface CoverSearchResult {
  covers: Candidate[];
  providers: Record<CoverProvider, ProviderReport>;
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface CoverSearchOptions {
  signal?: AbortSignal;
  googleApiKey?: string;
  /**
   * The listing's ISBN, when it has one.
   *
   * An ISBN names one edition, which is the thing the owner is actually
   * holding; a title and author name a work, and a work can carry a dozen
   * editions whose artwork has nothing in common. Where one is recorded it is
   * asked first and its answers are offered first.
   */
  isbn?: string;
  /** Injectable so complete provider behavior can be tested offline. */
  fetcher?: Fetcher;
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

interface EditionDoc {
  title?: string;
  covers?: number[];
  publishers?: string[];
  publish_date?: string;
}

interface GoogleVolume {
  id?: string;
  volumeInfo?: {
    title?: string;
    authors?: string[];
    publisher?: string;
    publishedDate?: string;
    imageLinks?: Record<string, string>;
  };
}

interface ProviderResult {
  covers: Candidate[];
  state: Exclude<ProviderState, 'not-configured'>;
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

/** The bounded set of complementary Open Library work searches. */
export function coverSearchQueries(title: string, author = ''): string[] {
  const rawTitle = title.trim();
  const rawAuthor = author.trim();
  if (rawTitle.length < 2) return [];

  const foldedTitle = normaliseCoverSearch(rawTitle);
  const foldedAuthor = normaliseCoverSearch(rawAuthor);
  const simpleTitle = simplifyCoverSearch(rawTitle);
  const plans: URLSearchParams[] = [];

  const add = (params: Record<string, string>) => {
    const search = new URLSearchParams({
      ...params,
      limit: '40',
      fields: OPEN_LIBRARY_FIELDS,
    });
    if (!plans.some((plan) => plan.toString() === search.toString())) plans.push(search);
  };

  add({ title: rawTitle, ...(rawAuthor ? { author: rawAuthor } : {}) });
  add({ q: [rawTitle, rawAuthor].filter(Boolean).join(' ') });
  if (foldedTitle && (foldedTitle !== rawTitle.toLocaleLowerCase('en') || foldedAuthor)) {
    add({ q: [foldedTitle, foldedAuthor].filter(Boolean).join(' ') });
  }
  if (simpleTitle && simpleTitle !== foldedTitle) add({ q: simpleTitle });
  else if (rawAuthor) add({ q: foldedTitle || rawTitle });

  return plans.slice(0, 4).map((plan) => `${OPEN_LIBRARY_SEARCH}?${plan}`);
}

/**
 * The Open Library search for one exact edition, or null if there is no usable
 * ISBN. Checked rather than trusted: a mistyped one would otherwise become a
 * request for whatever edition that number happens to belong to.
 */
export function openLibraryIsbnQuery(isbn: string): string | null {
  if (!validIsbn(isbn)) return null;
  const search = new URLSearchParams({
    isbn: normaliseIsbn(isbn),
    limit: '5',
    fields: OPEN_LIBRARY_FIELDS,
  });
  return `${OPEN_LIBRARY_SEARCH}?${search}`;
}

/** The same, for Google Books, using its documented `isbn:` qualifier. */
export function googleIsbnQuery(isbn: string, apiKey: string): string | null {
  if (!validIsbn(isbn) || !apiKey.trim()) return null;
  const search = new URLSearchParams({
    q: `isbn:${normaliseIsbn(isbn)}`,
    maxResults: '5',
    printType: 'books',
    key: apiKey.trim(),
  });
  return `${GOOGLE_BOOKS}?${search}`;
}

/** One relevance-ordered Google query; client code must not reorder it. */
export function googleBooksQuery(title: string, author: string, apiKey: string): string | null {
  const rawTitle = title.trim();
  if (rawTitle.length < 2 || !apiKey.trim()) return null;
  const search = new URLSearchParams({
    q: [rawTitle, author.trim()].filter(Boolean).join(' '),
    maxResults: '20',
    orderBy: 'relevance',
    printType: 'books',
    key: apiKey.trim(),
  });
  return `${GOOGLE_BOOKS}?${search}`;
}

const STOP = new Set(['a', 'al', 'an', 'ar', 'as', 'at', 'fi', 'of', 'the', 'wa']);
const words = (value: string): string[] =>
  normaliseCoverSearch(value)
    .split(' ')
    .filter((word) => word.length > 1 && !STOP.has(word));

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

/** Stable ranking across results returned by complementary queries. */
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

function openLibraryWorkId(key = ''): string | null {
  return key.match(/(?:^|\/)(OL\d+W)$/u)?.[1] ?? null;
}

function openLibrarySource(doc: SearchDoc, edition?: EditionDoc): string {
  return (
    [
      doc.author_name?.[0],
      edition?.publishers?.[0] ?? doc.publisher?.[0],
      edition?.publish_date ?? doc.first_publish_year,
    ]
      .filter(Boolean)
      .join(' · ')
      .slice(0, 110) || 'Open Library'
  );
}

type JsonResult<T> = { ok: true; body: T } | { ok: false };

async function requestJson<T>(
  url: string,
  fetcher: Fetcher,
  outsideSignal?: AbortSignal,
): Promise<JsonResult<T>> {
  const controller = new AbortController();
  const abort = () => controller.abort(outsideSignal?.reason);
  if (outsideSignal?.aborted) abort();
  else outsideSignal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort('cover lookup timed out'), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetcher(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'assubki-books (shop cover lookup)' },
    });
    if (!response.ok) return { ok: false };
    return { ok: true, body: (await response.json()) as T };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timeout);
    outsideSignal?.removeEventListener('abort', abort);
  }
}

async function openLibraryCandidates(
  title: string,
  author: string,
  isbn: string,
  fetcher: Fetcher,
  signal?: AbortSignal,
): Promise<ProviderResult> {
  /*
   * The exact edition first, and kept apart from the ranking below.
   *
   * Its artwork is not a better guess than the title search's, it is a
   * different kind of answer - the cover of the book in the owner's hand
   * rather than the cover of some edition of the same work. Scoring the two
   * together would let a fuzzy title match outrank it, which is exactly
   * backwards, so it is asked separately and its answers go in front.
   */
  const exact = await isbnCovers(isbn, fetcher, signal);

  const queries = coverSearchQueries(title, author);
  if (!queries.length) return { covers: exact, state: 'available' };

  const searches = await Promise.all(
    queries.map((url) => requestJson<{ docs?: SearchDoc[] }>(url, fetcher, signal)),
  );
  const available = searches.filter((result) => result.ok);
  // An ISBN hit still stands when the title search is down, and is worth
  // showing rather than reporting an outage over.
  if (!available.length) {
    return exact.length
      ? { covers: exact, state: 'available' }
      : { covers: [], state: 'unavailable' };
  }

  const ranked = available
    .flatMap((result) => (result.ok ? result.body.docs ?? [] : []))
    .map((doc, order) => ({ doc, order, score: coverMatchScore(title, author, doc) }))
    .filter(({ doc }) => Boolean(doc.title))
    .sort((a, b) => b.score - a.score || a.order - b.order);

  const works: typeof ranked = [];
  const seenWorks = new Set<string>();
  for (const match of ranked) {
    const key =
      openLibraryWorkId(match.doc.key) ??
      `${normaliseCoverSearch(match.doc.title ?? '')}:${normaliseCoverSearch(match.doc.author_name?.[0] ?? '')}`;
    if (!key || seenWorks.has(key)) continue;
    seenWorks.add(key);
    works.push(match);
  }

  const expandable = works.slice(0, 4);
  const editions = await Promise.all(
    expandable.map(async ({ doc }) => {
      const id = openLibraryWorkId(doc.key);
      if (!id) return [];
      const result = await requestJson<{ entries?: EditionDoc[] }>(
        `${OPEN_LIBRARY}/works/${id}/editions.json?limit=20`,
        fetcher,
        signal,
      );
      return result.ok ? result.body.entries ?? [] : [];
    }),
  );

  const covers: Candidate[] = [...exact];
  const seenCovers = new Set<number>(exact.map((cover) => Number(cover.id)));
  const caps = [4, 2, 1, 1];

  for (const [index, match] of expandable.entries()) {
    const possible: Array<{ id: number; edition?: EditionDoc }> = [];
    if (match.doc.cover_i && match.doc.cover_i > 0) possible.push({ id: match.doc.cover_i });
    for (const edition of editions[index] ?? []) {
      for (const id of edition.covers ?? []) {
        if (Number.isInteger(id) && id > 0) possible.push({ id, edition });
      }
    }

    let fromThisWork = 0;
    for (const possibleCover of possible) {
      if (seenCovers.has(possibleCover.id)) continue;
      seenCovers.add(possibleCover.id);
      covers.push({
        id: String(possibleCover.id),
        provider: 'openlibrary',
        title: (possibleCover.edition?.title ?? match.doc.title ?? 'Untitled edition').slice(0, 120),
        source: openLibrarySource(match.doc, possibleCover.edition),
      });
      fromThisWork++;
      if (fromThisWork >= caps[index] || covers.length >= MAX_PER_PROVIDER) break;
    }
    if (covers.length >= MAX_PER_PROVIDER) break;
  }

  // Fill spare spaces from representative work covers when editions are thin.
  for (const { doc } of works) {
    if (covers.length >= MAX_PER_PROVIDER) break;
    const id = doc.cover_i;
    if (!id || id <= 0 || seenCovers.has(id)) continue;
    seenCovers.add(id);
    covers.push({
      id: String(id),
      provider: 'openlibrary',
      title: (doc.title ?? 'Untitled edition').slice(0, 120),
      source: openLibrarySource(doc),
    });
  }

  return { covers, state: 'available' };
}

/** Convert Google API data without changing the API's relevance order. */
export function googleCandidates(body: { items?: GoogleVolume[] }): Candidate[] {
  const covers: Candidate[] = [];
  const seen = new Set<string>();
  for (const item of body.items ?? []) {
    const id = item.id ?? '';
    const info = item.volumeInfo;
    const hasImage = info?.imageLinks && Object.values(info.imageLinks).some(Boolean);
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(id) || seen.has(id) || !info?.title || !hasImage) {
      continue;
    }
    seen.add(id);
    covers.push({
      id,
      provider: 'google',
      title: info.title.slice(0, 120),
      source:
        [info.authors?.[0], info.publisher, info.publishedDate]
          .filter(Boolean)
          .join(' · ')
          .slice(0, 110) || 'Google Books',
    });
    if (covers.length >= MAX_PER_PROVIDER) break;
  }
  return covers;
}

/**
 * Covers for one exact edition. Never an outage on its own - a missing or
 * unknown ISBN is an ordinary result, and the title search still has to run.
 */
async function isbnCovers(
  isbn: string,
  fetcher: Fetcher,
  signal?: AbortSignal,
): Promise<Candidate[]> {
  const query = openLibraryIsbnQuery(isbn);
  if (!query) return [];

  const result = await requestJson<{ docs?: SearchDoc[] }>(query, fetcher, signal);
  if (!result.ok) return [];

  const covers: Candidate[] = [];
  const seen = new Set<number>();
  for (const doc of result.body.docs ?? []) {
    const id = doc.cover_i;
    if (!id || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    covers.push({
      id: String(id),
      provider: 'openlibrary',
      title: (doc.title ?? 'Untitled edition').slice(0, 120),
      source: `${openLibrarySource(doc)} · this ISBN`,
    });
    if (covers.length >= 3) break;
  }
  return covers;
}

async function googleBooksCandidates(
  title: string,
  author: string,
  isbn: string,
  apiKey: string,
  fetcher: Fetcher,
  signal?: AbortSignal,
): Promise<ProviderResult> {
  const exactQuery = googleIsbnQuery(isbn, apiKey);
  const query = googleBooksQuery(title, author, apiKey);
  if (!exactQuery && !query) return { covers: [], state: 'available' };

  const [exact, general] = await Promise.all([
    exactQuery
      ? requestJson<{ items?: GoogleVolume[] }>(exactQuery, fetcher, signal)
      : Promise.resolve(null),
    query
      ? requestJson<{ items?: GoogleVolume[] }>(query, fetcher, signal)
      : Promise.resolve(null),
  ]);

  // Down only when everything asked for came back empty-handed.
  const answered = [exact, general].filter((r) => r?.ok);
  if (!answered.length) return { covers: [], state: 'unavailable' };

  const covers: Candidate[] = [];
  const seen = new Set<string>();
  // Exact first, then relevance order, which Google's terms require us to keep.
  for (const result of [exact, general]) {
    if (!result?.ok) continue;
    for (const cover of googleCandidates(result.body)) {
      if (seen.has(cover.id)) continue;
      seen.add(cover.id);
      covers.push(cover);
      if (covers.length >= MAX_PER_PROVIDER) break;
    }
    if (covers.length >= MAX_PER_PROVIDER) break;
  }
  return { covers, state: 'available' };
}

/** Search providers independently so one outage never hides the other. */
export async function searchCovers(
  title: string,
  author = '',
  options: CoverSearchOptions = {},
): Promise<CoverSearchResult> {
  const fetcher = options.fetcher ?? fetch;
  const googleKey = options.googleApiKey?.trim() ?? '';
  const isbn = options.isbn?.trim() ?? '';
  const [openlibrary, google] = await Promise.all([
    openLibraryCandidates(title, author, isbn, fetcher, options.signal),
    googleKey
      ? googleBooksCandidates(title, author, isbn, googleKey, fetcher, options.signal)
      : Promise.resolve<ProviderResult>({ covers: [], state: 'available' }),
  ]);

  return {
    covers: [...openlibrary.covers, ...google.covers],
    providers: {
      openlibrary: { state: openlibrary.state, count: openlibrary.covers.length },
      google: {
        state: googleKey ? google.state : 'not-configured',
        count: google.covers.length,
      },
    },
  };
}

/**
 * Whether Google will actually answer, as opposed to whether a key is present.
 *
 * A key that exists is not a key that works: the usual way to get this wrong is
 * to put a website or IP restriction on it, which a Worker can never satisfy
 * because it sends no referrer and has no fixed address. That fails every
 * lookup silently while the settings page reports a key is configured, which is
 * the least useful thing it could say. So this asks Google the cheapest real
 * question it can and reports what came back.
 */
export async function googleBooksReachable(
  apiKey: string | undefined,
  options: { fetcher?: Fetcher; signal?: AbortSignal } = {},
): Promise<ProviderState> {
  const key = apiKey?.trim() ?? '';
  if (!key) return 'not-configured';

  const query = googleIsbnQuery('9780062227621', key);
  if (!query) return 'unavailable';
  const result = await requestJson<unknown>(query, options.fetcher ?? fetch, options.signal);
  return result.ok ? 'available' : 'unavailable';
}

/** Backward-compatible Open Library-only helper for existing callers. */
export async function findCovers(
  title: string,
  author = '',
  signal?: AbortSignal,
): Promise<Candidate[]> {
  return (await searchCovers(title, author, { signal })).covers;
}
