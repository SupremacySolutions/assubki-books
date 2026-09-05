import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getOrderByRef } from '../../../../../lib/admin-db';

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

  if (!order.pay_by) {
    return back('?e=' + encodeURIComponent('that order has no deadline to extend'));
  }

  /*
   * Only while it is still live. An order that has been paid, cancelled or
   * already released has nothing to wait for, and moving its date would be a
   * change with no meaning that the sweep might later act on.
   */
  const done = await env.DB.prepare(
    `UPDATE orders SET pay_by = unixepoch() + ? * 86400, updated_at = unixepoch()
      WHERE id = ? AND status IN ('requested', 'awaiting_payment')`,
  )
    .bind(MORE_DAYS, order.id)
    .run();

  return done.meta.changes
    ? back('?extended=1')
    : back('?e=' + encodeURIComponent('that order is no longer waiting on an answer'));
};
