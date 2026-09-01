import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { releaseHold } from '../../../../../lib/stock-release';
import { getOrderByRef } from '../../../../../lib/admin-db';

export const prerender = false;

/**
 * Deletes one order outright.
 *
 * Separate from the bulk clear, which only ever touches cancelled and lapsed
 * orders. That restriction is right for a tidy-up button - it must not sweep
 * away real sales - but it left no way at all to remove a single order that
 * had reached dispatched, which is where test orders end up.
 *
 * So this is deliberately one order at a time, named in a confirmation. Stock
 * is released first if the order is still holding any; an order that already
 * completed has long since given its copies up, and restoring them here would
 * invent stock that was sold.
 */
const STILL_HOLDING = new Set(['requested', 'awaiting_payment']);

export const POST: APIRoute = async ({ params }) => {
  const ref = params.ref!;
  const order = await getOrderByRef(ref);
  if (!order) return new Response(null, { status: 302, headers: { Location: '/admin/orders' } });

  const statements = [];

  if (STILL_HOLDING.has(order.status)) {
    statements.push(
      ...releaseHold(order.id, 'order deleted'),
    );
  }

  // order_items cascade; the ledger keeps its rows with a null order_id so the
  // stock movements stay auditable after the order itself is gone.
  statements.push(env.DB.prepare('DELETE FROM orders WHERE id = ?').bind(order.id));
  await env.DB.batch(statements);

  return new Response(null, {
    status: 302,
    headers: { Location: `/admin/orders?deleted=${encodeURIComponent(order.ref)}` },
  });
};
