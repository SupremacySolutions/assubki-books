import type { APIRoute } from 'astro';
import { forgetHomeRows } from '../../../../../lib/db';
import { tellWaiting } from '../../../../../lib/stock-alerts';
import { fillClaims, startPaymentWindow } from '../../../../../lib/arrival';

export const prerender = false;

/**
 * A delivery has come in, for one listing.
 *
 * The work itself lives in `lib/arrival.ts`, because a whole shipment landing
 * has to do exactly the same thing sixty times and two implementations of
 * "first promised, first served" would eventually disagree.
 */
export const POST: APIRoute = async ({ params, request }) => {
  const bookId = Number.parseInt(params.id ?? '', 10);
  if (!Number.isInteger(bookId)) return new Response('Bad request', { status: 400 });

  const form = await request.formData();
  const arrived = Math.max(0, Math.min(999, Math.round(Number(form.get('arrived')) || 0)));
  const back = new Response(null, {
    status: 302,
    headers: { Location: `/admin/books/${bookId}?arrived=1` },
  });
  if (arrived === 0) return back;

  const { orderIds } = await fillClaims(bookId, arrived);

  /*
   * The seven days start here too, not only for a shipment.
   *
   * The promise is the same either way - a reservation stands until the books
   * land, and then there is a week to answer - so a copy promised through the
   * per-book form should not be held forever while one promised through a
   * shipment is not.
   */
  await startPaymentWindow(orderIds);

  // A landed delivery is exactly what takes a book out of the arriving row.
  forgetHomeRows();

  /*
   * Anybody who asked to be told is told now, at the end, when availability
   * has settled - a delivery raises stock and then hands copies to the people
   * who reserved them, so a check half way through would announce copies that
   * were already spoken for.
   */
  await tellWaiting(bookId, new URL(request.url).origin);

  return back;
};
