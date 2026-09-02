import type { APIRoute } from 'astro';
import { listBooks } from '../../../lib/db';
import { imageUrl, price } from '../../../lib/format';

export const prerender = false;

/**
 * The handful of titles behind the search box, as somebody types.
 *
 * The catalogue's own search already did the hard part: `ftsQuery` puts a
 * prefix wildcard on the last word precisely so results narrow as you type,
 * and nothing had ever used it. This is that, six rows at a time.
 *
 * Costed deliberately, because the read budget is where this project has been
 * bitten before. `withTotal: false` drops the COUNT - a suggestion list has no
 * pager and needs no total - so a keystroke is one FTS lookup returning six
 * rows, against a category listing that was recently costing 1,493. The client
 * debounces and caches on top of that, so a typed word is a few requests, not
 * one per letter.
 */

/** Enough to recognise the book you meant, few enough to read at a glance. */
const LIMIT = 6;

/** Below this, everything matches and the list is noise. */
const MIN_CHARS = 2;

export const GET: APIRoute = async ({ url }) => {
  const q = (url.searchParams.get('q') ?? '').trim().slice(0, 80);

  const empty = Response.json(
    { q, results: [] },
    { headers: { 'Cache-Control': 'no-store' } },
  );
  if (q.length < MIN_CHARS) return empty;

  const { books } = await listBooks({
    q,
    sort: 'relevance',
    perPage: LIMIT,
    withTotal: false,
  });

  return Response.json(
    {
      q,
      results: books.map((b) => ({
        slug: b.slug,
        title: b.title,
        titleAr: b.title_ar,
        price: price(b.price_pence),
        // The card's own word for it, so the dropdown and the grid cannot
        // disagree about whether something is in stock.
        inStock: b.available > 0,
        image: imageUrl(b.image_key, 'thumb'),
      })),
    },
    {
      /*
       * A short private cache, not `no-store`. Backspacing over a word replays
       * queries the browser asked seconds ago, and there is nothing personal
       * in a list of book titles - but it is still per-visitor, so `private`
       * keeps it out of any shared cache.
       */
      headers: { 'Cache-Control': 'private, max-age=30' },
    },
  );
};
