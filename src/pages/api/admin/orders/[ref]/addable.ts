import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getOrderByRef } from '../../../../../lib/admin-db';
import { sellable } from '../../../../../lib/availability';
import { canAmend, howToAdd } from '../../../../../lib/amend';
import { ftsQuery } from '../../../../../lib/db';
import { imageUrl, price } from '../../../../../lib/format';
import { salePrice } from '../../../../../lib/sales';

export const prerender = false;

/** Enough to recognise the book you meant, few enough to read at a glance. */
const LIMIT = 8;

/** Below this everything matches and the list is noise. */
const MIN_CHARS = 2;

/**
 * Titles that could go on *this* order, as the owner types.
 *
 * Hung off the order rather than being a general book search, which is the
 * whole point of it: the order decides what may be added - shelf copies for an
 * ordinary order, claims on its own shipment for a reservation - and a generic
 * picker would hand back books the endpoint then has to refuse, one at a time,
 * after the owner has chosen them.
 *
 * Two reads, deliberately. The first finds candidates by name, the second asks
 * `lib/availability` - the read checkout itself uses - what they cost and how
 * many are free. Counting availability in the search query would be a second
 * copy of the set-pool arithmetic, and a second copy is how the portal comes to
 * believe in copies the shelf does not have.
 *
 * The numbers here are a snapshot for the owner's benefit and nothing more.
 * Adding re-reads all of it, so a copy sold in between is caught there.
 */
export const GET: APIRoute = async ({ params, url }) => {
  const order = await getOrderByRef(params.ref!);
  if (!order) return new Response('No such order', { status: 404 });

  const q = (url.searchParams.get('q') ?? '').trim().slice(0, 80);
  const empty = Response.json({ q, results: [] }, { headers: { 'Cache-Control': 'no-store' } });

  // Not a refusal worth a status code: the panel is not rendered on an order
  // that cannot take books, and a stale page asking anyway gets nothing back.
  if (!canAmend(order.status)) return empty;

  const match = q.length >= MIN_CHARS ? ftsQuery(q) : null;
  if (!match) return empty;

  /*
   * Candidates by name, inside the order's own world.
   *
   * The scope clause is narrower than `howToAdd` and is only an optimisation -
   * every row that survives it is put through `howToAdd` below anyway. What it
   * saves is reading a hundred shelf titles to answer a search on a
   * reservation, which would show the owner a list of books they cannot pick.
   */
  const scope =
    order.shipment_id === null
      ? `b.shipment_id IS NULL AND b.status = 'live'`
      : 'b.shipment_id = ?2';

  const { results: candidates } = await env.DB.prepare(
    `SELECT b.id, b.title, b.title_ar,
            (SELECT image_key FROM book_images
              WHERE book_id = b.id ORDER BY sort, id LIMIT 1) AS image_key
       FROM books b JOIN books_fts f ON f.rowid = b.id
      WHERE books_fts MATCH ?1 AND b.deleted_at IS NULL AND ${scope}
      ORDER BY f.rank LIMIT ${LIMIT}`,
  )
    .bind(...(order.shipment_id === null ? [match] : [match, order.shipment_id]))
    .all<{ id: number; title: string; title_ar: string | null; image_key: string | null }>();

  const priced = await sellable(candidates.map((b) => b.id));

  const results = [];
  for (const candidate of candidates) {
    const book = priced.get(candidate.id);
    if (!book) continue;
    const verdict = howToAdd(order.shipment_id, book);
    // Out of stock, or the wrong kind for this order. Both are simply absent:
    // a picker that lists what it will then refuse teaches the owner to ignore
    // it.
    if (!verdict.ok) continue;

    const pence = salePrice(book.price_pence, book.sale_percent);
    results.push({
      id: book.id,
      title: candidate.title,
      titleAr: candidate.title_ar,
      /* Pre-formatted, so the panel never does money arithmetic of its own. */
      price: price(pence),
      pricePence: pence,
      wasPrice: pence === book.price_pence ? null : price(book.price_pence),
      free: verdict.free,
      fromIncoming: verdict.fromIncoming,
      image: imageUrl(candidate.image_key, 'thumb'),
    });
  }

  return Response.json({ q, results }, { headers: { 'Cache-Control': 'no-store' } });
};
