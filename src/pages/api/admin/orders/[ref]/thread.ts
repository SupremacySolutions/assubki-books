import type { APIRoute } from 'astro';
import { getOrderByRef } from '../../../../../lib/admin-db';
import { markRead, thread } from '../../../../../lib/messages';

export const prerender = false;

/**
 * The owner's side of the order poll.
 *
 * The customer's order page has watched its own status and thread for a while;
 * the portal never did. That left the asymmetry backwards - a customer saw the
 * shop's reply within seconds, while the shop, which is the side expected to
 * answer, had to reload to see theirs. The owner is told out of band by
 * Telegram or email, but that is no use to somebody already looking at the
 * conversation.
 *
 * Named for the thread rather than the status, because `status.ts` next door is
 * the POST that *moves* an order and this only reports. The response shape is
 * deliberately the customer's, so `src/scripts/thread.ts` drives either side
 * without knowing which it is on.
 *
 * Authority is the portal session, checked in middleware for everything under
 * `/api/admin/`, rather than the customer's token - the owner should never need
 * to hold one of those to do their job.
 */
export const GET: APIRoute = async ({ params, url }) => {
  const ref = params.ref ?? '';
  const order = ref ? await getOrderByRef(ref) : null;

  if (!order) {
    return Response.json({ status: null }, { headers: { 'Cache-Control': 'no-store' } });
  }

  /*
   * An id, not a timestamp, for the same reason the customer's route uses one:
   * `created_at` is whole seconds, and two messages written inside one second -
   * a Telegram media group is the easy way there - made a time cursor
   * ambiguous, so the second one stayed invisible until a reload.
   *
   * Comparing two integers we already have first means the common case,
   * nothing having happened, stays at the single read `getOrderByRef` was
   * making anyway.
   */
  const since = Number.parseInt(url.searchParams.get('since') ?? '', 10);
  const cursor = Number.isInteger(since) && since >= 0 ? since : null;
  const moved =
    cursor !== null && order.last_message_id !== null && order.last_message_id > cursor;
  const messages = moved ? await thread(order.id, cursor) : [];

  /*
   * Handing the messages over is the read event, exactly as opening the order
   * is. The poll runs only on a visible tab, so this cannot clear the badge in
   * a window nobody is looking at - and leaving it set would show a count
   * beside messages already on the screen.
   */
  if (messages.length > 0) {
    /* Only through the newest message actually returned - anything written
       while this ran is still unread, and still counted. */
    await markRead(order.id, 'owner', messages.reduce((n, m) => Math.max(n, m.id), 0));
  }

  return Response.json(
    {
      status: order.status,
      unread: order.unread_for_owner,
      lastMessageAt: order.last_message_at ?? null,
      messages,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
};
