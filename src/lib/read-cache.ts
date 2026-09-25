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
