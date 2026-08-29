import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getOrderByRef, getOrderItems } from '../../../../../lib/admin-db';
import { paymentDraft } from '../../../../../lib/settings';
import { notifyOrderConfirmed } from '../../../../../lib/notify';

export const prerender = false;

/**
 * The owner confirms an order: postage is set, which is the first moment a real
 * total exists, and the customer is sent that total plus how to pay.
 *
 * The payment message is written per order rather than pulled from a template.
 * Different orders are paid into different accounts depending on size and
 * contents, so a single set of bank details in settings could never be right for
 * all of them - that setting is now only the starting text.
 *
 * The status only advances if at least one channel actually reached them. An
 * order marked "awaiting payment" that the customer never heard about is worse
 * than one still sitting in the queue - it looks handled but isn't.
 */
export const POST: APIRoute = async ({ params, request, url }) => {
  const ref = params.ref!;
  const order = await getOrderByRef(ref);
  if (!order) return new Response('No such order', { status: 404 });

  const form = await request.formData();
  const pounds = Number(form.get('postage') ?? 0);
  const postagePence =
    order.fulfilment === 'collection' ? 0 : Math.max(0, Math.round((pounds || 0) * 100));
  const totalPence = order.subtotal_pence + postagePence;

  const cashPayment = Boolean(order.cash_payment);
  const typed = String(form.get('payment_message') ?? '').trim().slice(0, 4000);
  const paymentInstructions = typed || (await paymentDraft(order.fulfilment, cashPayment));

  /*
   * Claim the order before sending anything.
   *
   * This used to read the status, send, then write - so two quick clicks both
   * saw 'requested' and the customer received two payment messages. A
   * conditional update means only one request can win, and the loser is told
   * the order has moved on. If the send then fails, the claim is released
   * below.
   */
  const claim = await env.DB.prepare(
    `UPDATE orders
        SET status = 'awaiting_payment', postage_pence = ?, total_pence = ?,
            payment_message = ?, confirmed_at = unixepoch(),
            payment_sent_at = unixepoch(), updated_at = unixepoch()
      WHERE id = ? AND status = 'requested'`,
  )
    .bind(postagePence, totalPence, paymentInstructions, order.id)
    .run();

  if (claim.meta.changes !== 1) {
    return new Response(null, { status: 302, headers: { Location: `/admin/orders/${ref}?e=state` } });
  }

  const items = await getOrderItems(order.id);

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
    cashPayment,
    origin: url.origin,
  });

  if (!sent.email && !sent.telegram) {
    // Put it back in the queue. The figures and the typed message are kept, so
    // the owner does not have to write it again, but nothing pretends the
    // customer was told.
    await env.DB.prepare(
      `UPDATE orders
          SET status = 'requested', confirmed_at = NULL, payment_sent_at = NULL,
              updated_at = unixepoch()
        WHERE id = ?`,
    )
      .bind(order.id)
      .run();

    return new Response(null, {
      status: 302,
      headers: { Location: `/admin/orders/${ref}?e=nosend` },
    });
  }

  const via = [sent.telegram && 'telegram', sent.email && 'email'].filter(Boolean).join('+');
  return new Response(null, { status: 302, headers: { Location: `/admin/orders/${ref}?sent=${via}` } });
};
