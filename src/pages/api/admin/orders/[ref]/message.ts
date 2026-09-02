import type { APIRoute } from 'astro';
import { getOrderByRef } from '../../../../../lib/admin-db';
import { notifyNewMessage } from '../../../../../lib/notify';
import { BODY_MAX, normaliseBody, postMessage, threadOpen } from '../../../../../lib/messages';

export const prerender = false;

/**
 * The owner writing to a customer, from the portal.
 *
 * Authentication is the portal session, checked once in src/middleware.ts for
 * everything under /api/admin/ - there is no second check here for the same
 * reason the other order routes have none.
 *
 * The owner cannot attach an image. Only the customer sends photographs, and
 * only of things like a payment reference; there is no shop-side case for it,
 * and every image the shop holds is one more thing to sweep.
 */
export const POST: APIRoute = async ({ params, request }) => {
  const ref = params.ref!;
  const order = await getOrderByRef(ref);
  if (!order) return new Response('No such order', { status: 404 });

  const back = (query: string) =>
    new Response(null, { status: 302, headers: { Location: `/admin/orders/${ref}${query}#thread` } });

  const form = await request.formData();
  const raw = String(form.get('body') ?? '').trim();
  if (!raw) return back('?e=empty');
  if (raw.length > BODY_MAX) return back('?e=long');

  // A finished order is a record, not a conversation. The customer's own page
  // stops taking words at the same point, so neither side can talk into a
  // thread the other cannot answer.
  if (!threadOpen(order.status)) return back('?e=closed');

  const body = normaliseBody(raw);
  const id = await postMessage({ orderId: order.id, sender: 'owner', via: 'web', body });
  if (id === null) return back('?e=empty');

  await notifyNewMessage({
    orderId: order.id,
    ref: order.ref,
    sender: 'owner',
    name: order.customer_name,
    email: order.email,
    telegramChatId: order.telegram_chat_id,
    body,
    hasImage: false,
    origin: new URL(request.url).origin,
  });

  return back('?sent=1');
};
