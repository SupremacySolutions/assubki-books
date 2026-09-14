import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getOrderByRef } from '../../../../../lib/admin-db';
import { HOLD_HOURS } from '../../../../../lib/orders';

export const prerender = false;

/** A week at a time, which is the same length the arrival gave them. */
const MORE_DAYS = 7;

/**
 * Another week to answer.
 *
 * Without this the owner's only reply to "can I have a few more days" is to
 * cancel the order and ask the customer to start again - which loses their
 * place in the queue for a book somebody else is waiting on.
 *
 * Deliberately not a status change. Nothing about the order moves; only the
 * date the sweep measures against does, so it needs none of the transition
 * machinery and cannot put an order into a state it should not be in.
 *
 * Counted from now rather than from the old deadline, so extending an order
 * that lapsed yesterday gives a full week rather than a day that has already
 * gone.
 */
export const POST: APIRoute = async ({ params }) => {
  const ref = String(params.ref ?? '').toUpperCase();
  const order = await getOrderByRef(ref);
  if (!order) return new Response('No such order', { status: 404 });

  const back = (query: string) =>
    new Response(null, {
      status: 302,
      headers: { Location: `/admin/orders/${encodeURIComponent(ref)}${query}` },
    });

  /*
   * Two deadlines, and which one this moves depends on which the order has.
   *
   * `pay_by` is the reservation's: set when a delivery lands, answerable to the
   * next person in the queue, and a week is what the arrival gave them in the
   * first place. `expires_at` is the shelf hold's - the forty-eight hours the
   * owner has to deal with a new order - and until now nothing could move it at
   * all, so an owner whose hold had run out had no answer to give except cancel
   * and ask the customer to start again.
   *
   * A reservation's deadline wins when an order somehow carries both, because
   * it is the one with somebody else waiting behind it.
   */
  const reservation = Boolean(order.pay_by);
  if (!reservation && !order.expires_at) {
    return back('?e=' + encodeURIComponent('that order has no deadline to extend'));
  }

  /*
   * Only while it is still live. An order that has been paid, cancelled or
   * already released has nothing to wait for, and moving its date would be a
   * change with no meaning that the sweep might later act on.
   *
   * Extending clears `lapsed_at` in the same statement: the whole point of the
   * press is that the owner has now dealt with it, and a flag left standing
   * would keep the order in the portal's "waiting on you" list for a deadline
   * that is no longer passed.
   */
  const done = await env.DB.prepare(
    reservation
      ? `UPDATE orders SET pay_by = unixepoch() + ?1 * 86400, lapsed_at = NULL,
                           updated_at = unixepoch()
          WHERE id = ?2 AND status IN ('requested', 'awaiting_payment')`
      : `UPDATE orders SET expires_at = unixepoch() + ${HOLD_HOURS * 3600}, lapsed_at = NULL,
                           updated_at = unixepoch()
          WHERE id = ?2 AND status = 'requested'`,
  )
    .bind(MORE_DAYS, order.id)
    .run();

  return done.meta.changes
    ? back('?extended=1')
    : back('?e=' + encodeURIComponent('that order is no longer waiting on an answer'));
};
