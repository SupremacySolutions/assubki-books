import type { APIRoute } from 'astro';
import { booksByIds } from '../../lib/db';
import { whenText } from '../../lib/incoming';

export const prerender = false;

/**
 * Resolves the ids held in localStorage to their current price, availability
 * and cover. The basket never stores prices, so this is what makes a stale tab
 * show today's figures rather than yesterday's.
 */
export const GET: APIRoute = async ({ url }) => {
  const ids = (url.searchParams.get('ids') ?? '')
    .split(',')
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, 100);

  if (!ids.length) return Response.json({ books: [] });

  const books = await booksByIds(ids);

  return Response.json(
    {
      books: books.map((b) => ({
        id: b.id,
        slug: b.slug,
        title: b.title,
        titleAr: b.title_ar,
        pricePence: b.price_pence,
        available: Math.max(0, b.available),
        // A line the shelf cannot cover but a delivery can. Kept separate from
        // `available` so the basket can say which it is rather than quietly
        // treating a promise as a copy in hand.
        reservable: b.reservable,
        expected: whenText(b.incoming_vague, b.incoming_month),
        imageKey: b.image_key,
      })),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
};
