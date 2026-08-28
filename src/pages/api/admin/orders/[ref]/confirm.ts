import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getOrderByRef, getOrderItems } from '../../../../../lib/admin-db';
import { getSetting } from '../../../../../lib/settings';
import { notifyOrderConfirmed } from '../../../../../lib/notify';

export const prerender = false;

/**
 * The owner confirms an order: postage is set, which is the first moment a real
 * total exists, and the customer is sent that total plus how to pay.
 *
 * The status only advances if at least one channel actually reached them. An
 * order marked "awaiting payment" that the customer never heard about is worse
 * than one still sitting in the queue - it looks handled but isn't.
 */
export const POST: APIRoute = async ({ params, request, url }) => {
  const ref = params.ref!;
  const order = await getOrderByRef(ref);
  if (!order) return new Response('No such order', { status: 404 });

  if (order.status !== 'requested') {
    return new Response(null, { status: 302, headers: { Location: `/admin/orders/${ref}?e=state` } });
  }

  const form = await request.formData();
  const pounds = Number(form.get('postage') ?? 0);
  const postagePence =
    order.fulfilment === 'collection' ? 0 : Math.max(0, Math.round((pounds || 0) * 100));
  const totalPence = order.subtotal_pence + postagePence;

  const [items, paymentInstructions] = await Promise.all([
    getOrderItems(order.id),
    getSetting('payment_instructions'),
  ]);

  const sent = await notifyOrderConfirmed({
    ref: order.ref,
    token: order.access_token,
    name: order.customer_name,
    email: order.email,
    telegramChatId: order.telegram_chat_id,
    items: items.map((i) => ({
      title: i.title_snapshot,
      qty: i.qty,
      pricePence: i.price_pence_snapshot,
    })),
    subtotalPence: order.subtotal_pence,
    postagePence,
    totalPence,
    fulfilment: order.fulfilment,
    paymentInstructions,
    origin: url.origin,
  });

  if (!sent.email && !sent.telegram) {
    // Record the figures so the work is not lost, but leave the order in the
    // queue and say plainly that nothing went out.
    await env.DB.prepare(
      `UPDATE orders SET postage_pence = ?, total_pence = ?, updated_at = unixepoch() WHERE id = ?`,
    )
      .bind(postagePence, totalPence, order.id)
      .run();

    return new Response(null, {
      status: 302,
      headers: { Location: `/admin/orders/${ref}?e=nosend` },
    });
  }

  await env.DB.prepare(
    `UPDATE orders
        SET status = 'awaiting_payment', postage_pence = ?, total_pence = ?,
            confirmed_at = unixepoch(), payment_sent_at = unixepoch(), updated_at = unixepoch()
      WHERE id = ?`,
  )
    .bind(postagePence, totalPence, order.id)
    .run();

  const via = [sent.telegram && 'telegram', sent.email && 'email'].filter(Boolean).join('+');
  return new Response(null, { status: 302, headers: { Location: `/admin/orders/${ref}?sent=${via}` } });
};
