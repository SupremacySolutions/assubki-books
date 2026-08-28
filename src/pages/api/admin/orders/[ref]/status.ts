import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getOrderByRef } from '../../../../../lib/admin-db';
import { notifyStatusChange } from '../../../../../lib/notify';

export const prerender = false;

/**
 * Only these transitions exist. A free-text status from a form post could
 * otherwise put an order into a state nothing else knows how to handle.
 */
const ALLOWED: Record<string, string[]> = {
  requested: ['cancelled'],
  awaiting_payment: ['paid', 'cancelled'],
  paid: ['dispatched', 'cancelled'],
  dispatched: [],
  cancelled: [],
  expired: [],
};

/** Statuses where the customer no longer gets the goods, so the hold must go. */
const RELEASES_STOCK = new Set(['cancelled']);

export const POST: APIRoute = async ({ params, request, url }) => {
  const ref = params.ref!;
  const order = await getOrderByRef(ref);
  if (!order) return new Response('No such order', { status: 404 });

  const form = await request.formData();
  const next = String(form.get('status') ?? '');
  const tracking = String(form.get('tracking') ?? '').trim().slice(0, 80) || null;

  if (!(ALLOWED[order.status] ?? []).includes(next)) {
    return new Response(null, { status: 302, headers: { Location: `/admin/orders/${ref}?e=state` } });
  }

  // Stamp when each step happened, so the customer's page can show the story
  // rather than just where the order stands now.
  const stamp =
    next === 'paid' ? ', paid_at = unixepoch()'
    : next === 'dispatched' ? ', dispatched_at = unixepoch()'
    : '';

  const statements = [
    env.DB.prepare(
      `UPDATE orders SET status = ?, updated_at = unixepoch()${stamp}` +
        (next === 'dispatched' ? ', tracking_number = ?' : '') +
        ' WHERE id = ?',
    ).bind(...(next === 'dispatched' ? [next, tracking, order.id] : [next, order.id])),
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
  if (next === 'paid') {
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
      // The hold has done its job; clearing it stops the cron re-releasing it.
      env.DB.prepare('UPDATE orders SET expires_at = NULL WHERE id = ?').bind(order.id),
    );
  }

  await env.DB.batch(statements);

  await notifyStatusChange({
    ref: order.ref,
    token: order.access_token,
    name: order.customer_name,
    email: order.email,
    telegramChatId: order.telegram_chat_id,
    status: next,
    origin: url.origin,
    tracking,
  }).catch((err) => console.error('[admin] status notification failed', ref, err));

  return new Response(null, { status: 302, headers: { Location: `/admin/orders/${ref}` } });
};
