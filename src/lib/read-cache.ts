import { env } from 'cloudflare:workers';

/**
 * Reads whose answer outlives the isolate that worked it out.
 *
 * `categoryCounts` and `publisherCounts` already hold their answer in a module
 * variable for a minute, and that was worth doing. But a Workers isolate is
 * short-lived and there are many of them, so a cold one pays the whole read
 * again - and on 25 September the shelf roll-up still ran 851 times at 1,492
 * rows a call. That is 1.27M rows, a quarter of D1's daily allowance, spent
 * re-deriving an answer that changes a few times a day. It is why the shop went
 * offline two days running.
 *
 * The Cache API outlives the isolate, so the second cold isolate in a data
 * centre reads the first one's answer instead of the database. It deliberately
 * sits *behind* the module variable rather than replacing it: memory is free
 * and this is not.
 *
 * Two properties to hold in mind, both consequences of what the Cache API is:
 *
 * - **It does not replicate between data centres.** The first request in each
 *   is still a real read. That is fine here - the number of data centres is
 *   small and fixed, while the number of isolates is neither.
 * - **Staleness is bounded by the TTL and nothing else.** `cache.delete` reaches
 *   only the data centre it runs in, so an owner's edit cannot be pushed to the
 *   others. Hence short TTLs, and hence `fresh` - the portal reads past this
 *   entirely, so the owner always sees their own edit.
 *
 * Every cache operation is wrapped, because a cache that cannot be reached must
 * cost a read rather than a page: the API is absent in dashboard previews, and
 * unavailable to Workers fronted by Cloudflare Access.
 */

/** Named so it can never collide with the zone's own HTTP cache entries. */
const STORE = 'catalogue-reads';

/**
 * A hostname that resolves nowhere.
 *
 * The key only has to be a well-formed URL that no request can arrive at. A
 * path on the real hostname would be reachable, and one day somebody would
 * find a cached JSON blob answering a URL the shop appears to own.
 */
const KEY_ROOT = 'https://read-cache.assubki.invalid/';

async function store(): Promise<Cache | null> {
  try {
    return await caches.open(STORE);
  } catch {
    return null;
  }
}

/**
 * The answer to `read()`, from the cache when it is there and fresh.
 *
 * `pack` and `unpack` exist because the two things worth caching here both
 * carry `Map`s, which JSON does not survive. A caller whose value is already
 * plain JSON omits them.
 */
export async function cachedRead<T>(
  key: string,
  ttlSeconds: number,
  read: () => Promise<T>,
  pack: (value: T) => unknown = (value) => value,
  unpack: (raw: unknown) => T = (raw) => raw as T,
): Promise<T> {
  const cache = await store();
  const request = new Request(`${KEY_ROOT}${encodeURIComponent(key)}`);

  if (cache) {
    try {
      const hit = await cache.match(request);
      if (hit) return unpack(await hit.json());
    } catch {
      // A malformed or truncated entry is not worth a page. Read it properly.
    }
  }

  const value = await read();

  /*
   * A failure is not an answer, so it is not kept.
   *
   * `null` is how the callers here say "could not find out" - no token yet, a
   * refused one, an API having a bad minute. Cached, that momentary state is
   * repeated for the whole TTL, so switching the token on appears not to work
   * and a one-second blip becomes five minutes of blank.
   */
  if (value === null || value === undefined) return value;

  if (cache) {
    try {
      await cache.put(
        request,
        new Response(JSON.stringify(pack(value)), {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': `max-age=${ttlSeconds}`,
          },
        }),
      );
    } catch {
      // The answer is already in hand; failing to keep it is not a failure.
    }
  }

  return value;
}

/**
 * Put a freshly-read answer in, replacing whatever was there.
 *
 * This is what a change does, rather than a delete. A delete is asynchronous
 * and the read that follows it does not wait, so the caller would find the
 * stale entry it had just asked to be rid of and believe it - which is exactly
 * the bug the suite caught when this module was first written. Reading fresh
 * and writing through leaves no window: the caller already holds the truth, and
 * the data centre gets it too.
 *
 * Still only this data centre. The others wait out the TTL, which is why it is
 * five minutes and why the portal reads past all of it.
 */
export async function writeCachedRead<T>(
  key: string,
  ttlSeconds: number,
  value: T,
  pack: (value: T) => unknown = (v) => v,
): Promise<void> {
  const cache = await store();
  if (!cache) return;
  try {
    await cache.put(
      new Request(`${KEY_ROOT}${encodeURIComponent(key)}`),
      new Response(JSON.stringify(pack(value)), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `max-age=${ttlSeconds}`,
        },
      }),
    );
  } catch {
    /* best effort: the caller already has the answer */
  }
}

// ---------------------------------------------------------------------------
// The catalogue, keyed by its version
// ---------------------------------------------------------------------------


/**
 * How long the catalogue's answers may sit in a data centre's cache.
 *
 * Hours rather than the minute the entries above live, and the difference is
 * the whole fix. A minute was chosen for freshness - an edit could not reach
 * other data centres any faster - and it set a floor of one D1 read per entry
 * per minute all day long. With the version in every key, freshness no longer
 * depends on expiry at all, so this only decides how long an abandoned
 * version's entries take to be cleared away.
 */
const CATALOGUE_TTL_SECONDS = 6 * 60 * 60;

/**
 * How long one Worker instance may reuse the version it last read.
 *
 * Long enough that the half-dozen catalogue reads one page fires together share
 * a single lookup; short enough that it is gone before any person, or any test,
 * could make a change and then look for it. The instance that makes a change
 * does not wait even this long - the forget hooks clear it.
 */
const VERSION_REUSE_MS = 250;

let version: { at: number; value: Promise<number> } | null = null;

/**
 * The catalogue's version: one row, bumped by a trigger on every write to every
 * table the catalogue is read from (migration 0051).
 *
 * This is what a cached page view costs. Everything else it shows comes from
 * the cache under this number, so a change anywhere - however it was made - is
 * seen on the next page view, in every data centre at once.
 */
export function catalogueVersion(): Promise<number> {
  const now = Date.now();
  if (version && now - version.at < VERSION_REUSE_MS) return version.value;
  const value = env.DB.prepare('SELECT n FROM catalogue_version WHERE id = 1')
    .first<{ n: number }>()
    .then((row) => row?.n ?? 0);
  version = { at: now, value };
  // A refusal is not a version. Do not hand it to the next caller as one.
  value.catch(() => {
    if (version?.value === value) version = null;
  });
  return value;
}

/** Called by the same hooks that run after an edit, so its own instance sees it. */
export function forgetCatalogueVersion(): void {
  version = null;
}

/** SQL and its arguments, reduced to a key that fits any URL. */
async function keyFor(kind: string, sql: string, args: unknown[]): Promise<string> {
  const text = `${kind}\n${sql}\n${JSON.stringify(args)}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A cached catalogue answer: the version it belongs to, then the question. */
async function catalogueRead<T>(kind: string, sql: string, args: unknown[], read: () => Promise<T>): Promise<T> {
  const [v, key] = await Promise.all([catalogueVersion(), keyFor(kind, sql, args)]);
  return cachedRead(`catalogue:v${v}:${key}`, CATALOGUE_TTL_SECONDS, read);
}

/**
 * The statements `src/lib/db.ts` prepares, answered from the cache.
 *
 * Shaped like the slice of D1 that db.ts uses - `prepare`, `bind`, `all`,
 * `first` - so the cache sits under every catalogue query without one of them
 * changing. That is deliberate, and it is the lesson of the attempt shelved on
 * 25 September: it answered the catalogue by reimplementing its WHERE and ORDER
 * BY in JavaScript, and a reimplementation that drifts does not fail, it
 * quietly shows the catalogue in the wrong order. Here the SQL stays the only
 * statement of what the catalogue is. The cache stores its answers, keyed by
 * the exact text and arguments, and cannot disagree with it.
 *
 * Read-only by construction. db.ts does not write, and there is no `run` here
 * to tempt anybody: a write through a cache is a bug waiting for a reason.
 */
export interface CatalogueStatement {
  bind(...args: unknown[]): CatalogueStatement;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

export function catalogueDb(d1: D1Database): { prepare(sql: string): CatalogueStatement } {
  const statement = (sql: string, args: unknown[]): CatalogueStatement => {
    const real = () => (args.length ? d1.prepare(sql).bind(...args) : d1.prepare(sql));
    return {
      bind: (...next: unknown[]) => statement(sql, next),
      all: async <T>() => ({
        results: await catalogueRead('all', sql, args, async () => (await real().all<T>()).results),
      }),
      /*
       * Boxed, because "no such row" is an answer and `cachedRead` declines to
       * keep a bare null - rightly, for the reads it was written for, where null
       * means "could not find out". A slug that does not exist is not that, and
       * under a versioned key it cannot go stale: adding the book moves the
       * version.
       */
      first: async <T>() =>
        (await catalogueRead('first', sql, args, async () => ({ row: await real().first<T>() }))).row,
    };
  };
  return { prepare: (sql: string) => statement(sql, []) };
}
