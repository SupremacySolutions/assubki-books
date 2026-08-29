import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getOrderByRef } from '../../../../../lib/admin-db';
import { notifyStatusChange } from '../../../../../lib/notify';
import { canTransition } from '../../../../../lib/order-status';
import { getSetting } from '../../../../../lib/settings';

export const prerender = false;

/** Statuses where the customer no longer gets the goods, so the hold must go. */
const RELEASES_STOCK = new Set(['cancelled']);

export const POST: APIRoute = async ({ params, request, url }) => {
  const ref = params.ref!;
  const order = await getOrderByRef(ref);
  if (!order) return new Response('No such order', { status: 404 });

  const form = await request.formData();
  const next = String(form.get('status') ?? '');
  const tracking = String(form.get('tracking') ?? '').trim().slice(0, 80) || null;
  const provider = String(form.get('postage_provider') ?? '').trim().slice(0, 40) || null;
  const service = String(form.get('postage_service') ?? '').trim().slice(0, 60) || null;

  // The permitted moves come from the same table that draws the buttons, so the
  // endpoint cannot accept something the portal never offered. This is also what
  // refuses 'dispatched' on a collection order - there is nothing to post, and
  // previously a hand-crafted POST could set a tracking number on one.
  if (!canTransition(order.status, next, order.fulfilment, Boolean(order.cash_payment))) {
    return new Response(null, { status: 302, headers: { Location: `/admin/orders/${ref}?e=state` } });
  }

  /*
   * The owner records payment and posting in one action, so 'paid' is not
   * always a status the order passes through - a delivery usually goes straight
   * from awaiting_payment to dispatched. Payment is therefore recognised by the
   * move *out of* awaiting_payment, not by the destination, or the combined
   * action would post the books without ever taking them off the shelf.
   */
  const recordsPayment =
    order.status === 'awaiting_payment' && (next === 'paid' || next === 'dispatched');

  const sets = ['status = ?', 'updated_at = unixepoch()'];
  const binds: unknown[] = [next];

  // The hold has done its job; clearing the expiry stops the cron re-releasing
  // stock that has already been sold.
  if (recordsPayment) sets.push('paid_at = unixepoch()', 'expires_at = NULL');

  if (next === 'dispatched') {
    sets.push(
      'dispatched_at = unixepoch()',
      'tracking_number = ?',
      'postage_provider = ?',
      'postage_service = ?',
    );
    binds.push(tracking, provider, service);
  }

  if (next === 'completed') sets.push('completed_at = unixepoch()');

  binds.push(order.id);

  const statements = [
    env.DB.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`).bind(...binds),
  ];

  if (RELEASES_STOCK.has(next) && ['requested', 'awaiting_payment'].includes(order.status)) {
    statements.push(
      env.DB.prepare(
        `UPDATE books SET reserved = MAX(0, reserved - COALESCE(
           (SELECT SUM(qty) FROM order_items WHERE order_id = ?1 AND book_id = books.id), 0))
          WHERE id IN (SELECT book_id FROM order_items WHERE order_id = ?1 AND book_id IS NOT NULL)`,
      ).bind(order.id),
      env.DB.prepare(
        `INSERT INTO stock_ledger (book_id, delta, field, reason, order_id)
         SELECT book_id, -SUM(qty), 'reserved', 'order cancelled', ?1
           FROM order_items WHERE order_id = ?1 AND book_id IS NOT NULL GROUP BY book_id`,
      ).bind(order.id),
    );
  }

  // Payment received converts the hold into a real reduction in stock: the
  // copies are leaving the shop, so they come off both counters.
  if (recordsPayment) {
    statements.push(
      env.DB.prepare(
        `UPDATE books
            SET reserved = MAX(0, reserved - COALESCE(
                  (SELECT SUM(qty) FROM order_items WHERE order_id = ?1 AND book_id = books.id), 0)),
                stock = MAX(0, stock - COALESCE(
                  (SELECT SUM(qty) FROM order_items WHERE order_id = ?1 AND book_id = books.id), 0)),
                updated_at = unixepoch()
          WHERE id IN (SELECT book_id FROM order_items WHERE order_id = ?1 AND book_id IS NOT NULL)`,
      ).bind(order.id),
      env.DB.prepare(
        `INSERT INTO stock_ledger (book_id, delta, field, reason, order_id)
         SELECT book_id, -SUM(qty), 'stock', 'order paid', ?1
           FROM order_items WHERE order_id = ?1 AND book_id IS NOT NULL GROUP BY book_id`,
      ).bind(order.id),
      env.DB.prepare(
        `INSERT INTO stock_ledger (book_id, delta, field, reason, order_id)
         SELECT book_id, -SUM(qty), 'reserved', 'hold converted to sale', ?1
           FROM order_items WHERE order_id = ?1 AND book_id IS NOT NULL GROUP BY book_id`,
      ).bind(order.id),
    );
  }

  await env.DB.batch(statements);

  // A collection customer who has just paid needs to know where to come.
  const collectionAddress =
    next === 'paid' && order.fulfilment === 'collection'
      ? await getSetting('collection_address')
      : '';

  await notifyStatusChange({
    ref: order.ref,
    token: order.access_token,
    name: order.customer_name,
    email: order.email,
    telegramChatId: order.telegram_chat_id,
    status: next,
    fulfilment: order.fulfilment,
    origin: url.origin,
    tracking,
    provider,
    collectionAddress,
    cashPayment: Boolean(order.cash_payment),
  }).catch((err) => console.error('[admin] status notification failed', ref, err));

  return new Response(null, { status: 302, headers: { Location: `/admin/orders/${ref}` } });
};
