import type { APIRoute } from 'astro';
import { getOrder } from '../../../lib/orders';
import { markRead, thread } from '../../../lib/messages';

export const prerender = false;

/**
 * Current status of an order, and whether the thread has moved.
 *
 * Used by the order page to detect when the owner has marked the order as
 * completed (e.g. collection picked up, or delivery confirmed) and refresh
 * to show the new status without requiring a manual reload.
 *
 * The thread rides along here rather than getting an endpoint of its own.
 * `getOrder` already selects both counters and `last_message_at` from the row
 * it was fetching anyway, so telling the page about a new message costs no
 * extra D1 read - and the page keeps one poll instead of two.
 */
export const GET: APIRoute = async ({ url }) => {
  const ref = url.searchParams.get('ref')?.trim() ?? '';
  const token = url.searchParams.get('t') ?? '';
  const order = ref && token ? await getOrder(ref, token) : null;

  if (!order) {
    return Response.json({ status: null }, { headers: { 'Cache-Control': 'no-store' } });
  }

  /*
   * The messages themselves, and only when there are new ones.
   *
   * `since` is the id of the newest message the page is already showing.
   * Reading the thread on every poll would put a second query behind a
   * five-second timer on every open order page; comparing two integers we
   * already have first means the common case - nothing has happened - stays at
   * the one read `getOrder` was making anyway.
   *
   * An id, not a timestamp. It used to be `created_at`, which is whole seconds,
   * so two messages written inside the same second left the page's cursor equal
   * to `last_message_at` - the early-out said nothing had moved, and the second
   * message did not appear until a reload. Ids are monotonic; seconds are not.
   */
  const since = Number.parseInt(url.searchParams.get('since') ?? '', 10);
  const cursor = Number.isInteger(since) && since >= 0 ? since : null;
  const moved =
    cursor !== null && order.last_message_id !== null && order.last_message_id > cursor;
  const messages = moved ? await thread(order.id, cursor) : [];

  /*
   * Handing the messages over is the read event, exactly as opening the page
   * is. The poll only runs on a visible tab, so this cannot mark a thread read
   * in a window nobody is looking at - and leaving it unread would leave a
   * badge showing next to messages already on the screen.
   *
   * A write on a GET, deliberately: the alternative is a second request whose
   * only job is to say "yes, I saw it".
   */
  if (messages.length > 0) await markRead(order.id, 'customer');

  return Response.json(
    {
      status: order.status,
      completed_at: order.completed_at ?? null,
      unread: order.unread_for_customer,
      lastMessageAt: order.last_message_at ?? null,
      messages,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
};
