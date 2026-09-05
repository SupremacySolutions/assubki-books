import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { fillClaims, startPaymentWindow } from '../../../../../lib/arrival';
import { queueArrivalNotices } from '../../../../../lib/shipment-notify';
import { forgetHomeRows } from '../../../../../lib/db';
import { forgetDashboard } from '../../../../../lib/dashboard';

export const prerender = false;

/** Statements per batch. Keeps one press well inside a Worker's limits. */
const CHUNK = 40;

/**
 * The box has landed.
 *
 * Three things happen, in an order that matters:
 *
 *   1. The shipment is claimed. Everything after this is safe to run once and
 *      only once, which is the whole reason it comes first.
 *   2. Each book's copies become real stock and the claims against them become
 *      ordinary holds, oldest claim first. A short delivery leaves later claims
 *      waiting rather than cancelling them.
 *   3. The seven days start, and everybody who got a copy is queued to be told.
 *
 * The claim is what makes a double press harmless. `arrived.ts` for a single
 * book has never had that guard and did not need one - a slip added stock to
 * one listing and was easy to see. Doing it to sixty at once is not, so the
 * shipment is moved out of 'open' by a conditional update and the rest only
 * runs if that update changed a row.
 */
export const POST: APIRoute = async ({ params, url }) => {
  const shipmentId = Number.parseInt(params.id ?? '', 10);
  if (!Number.isInteger(shipmentId)) return new Response('Bad request', { status: 400 });

  const back = (query: string) =>
    new Response(null, {
      status: 302,
      headers: { Location: `/admin/shipments/${shipmentId}${query}` },
    });

  const claimed = await env.DB.prepare(
    `UPDATE shipments SET status = 'arrived', arrived_at = unixepoch(), updated_at = unixepoch()
      WHERE id = ? AND status = 'open'`,
  )
    .bind(shipmentId)
    .run();
  if (!claimed.meta.changes) {
    return back('?e=' + encodeURIComponent('this shipment is not open, so it cannot arrive'));
  }

  const { results: books } = await env.DB.prepare(
    `SELECT id, incoming FROM books WHERE shipment_id = ? AND incoming > 0`,
  )
    .bind(shipmentId)
    .all<{ id: number; incoming: number }>();

  /*
   * Every copy that was said to be coming is treated as having come.
   *
   * If the box was short the owner corrects the numbers before pressing this;
   * doing it the other way round - arriving, then discovering - would mean
   * unwinding holds that customers have already been told about.
   */
  const touched = new Set<number>();
  for (const book of books) {
    const { orderIds } = await fillClaims(book.id, book.incoming);
    for (const id of orderIds) touched.add(id);
  }

  const orderIds = [...touched];
  await startPaymentWindow(orderIds);

  /*
   * Queued, not sent. Forty customers is forty outbound requests, which is
   * more than one handler may make and more than a day's mail allowance; the
   * sweep drains this a few at a time.
   */
  const notices = queueArrivalNotices(env.DB, shipmentId, orderIds);
  for (let i = 0; i < notices.length; i += CHUNK) {
    await env.DB.batch(notices.slice(i, i + CHUNK));
  }

  forgetHomeRows();
  forgetDashboard();

  return back(`?arrived=${orderIds.length}`);
};
