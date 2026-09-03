import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { releaseHold } from '../../../../../lib/stock-release';
import { getOrderByRef } from '../../../../../lib/admin-db';
import { forgetDashboard } from '../../../../../lib/dashboard';

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

  /*
   * The screenshots have to be read before the order goes, and removed after.
   *
   * `messages` cascades with the order, and those rows are the only record of
   * which objects in the bucket belong to it - the retention sweep finds
   * screenshots by walking them. Deleting an order therefore used to strand a
   * customer's bank details in R2 permanently, which is the exact outcome the
   * six-month sweep exists to prevent. Nothing would ever have collected them.
   */
  const { results: proofs } = await env.DB.prepare(
    'SELECT image_key FROM messages WHERE order_id = ? AND image_key IS NOT NULL',
  )
    .bind(order.id)
    .all<{ image_key: string }>();

  // order_items cascade; the ledger keeps its rows with a null order_id so the
  // stock movements stay auditable after the order itself is gone.
  statements.push(env.DB.prepare('DELETE FROM orders WHERE id = ?').bind(order.id));
  await env.DB.batch(statements);
  forgetDashboard();

  // After the row is gone, so a failure here leaves a collectable object rather
  // than a message pointing at one that has been removed.
  const bucket = (env as unknown as { UPLOADS?: R2Bucket }).UPLOADS;
  for (const proof of proofs) {
    await bucket?.delete(proof.image_key).catch(() => {});
  }

  return new Response(null, {
    status: 302,
    headers: { Location: `/admin/orders?deleted=${encodeURIComponent(order.ref)}` },
  });
};
