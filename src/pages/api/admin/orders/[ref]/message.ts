import type { APIRoute } from 'astro';
import { getOrderByRef } from '../../../../../lib/admin-db';
import { notifyNewMessage } from '../../../../../lib/notify';
import { BODY_MAX, normaliseBody, postMessage, threadOpen } from '../../../../../lib/messages';
import { THREAD } from '../../../../../lib/order-status';
import { readForm } from '../../../../../lib/request-body';

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
  const wantsJson = (request.headers.get('Accept') ?? '').includes('application/json');
  const ref = params.ref!;
  const order = await getOrderByRef(ref);
  if (!order) return new Response('No such order', { status: 404 });

  const back = (query: string) =>
    new Response(null, { status: 302, headers: { Location: `/admin/orders/${ref}${query}#thread` } });

  const refuse = (code: string, error: string, status = 400) => wantsJson
    ? Response.json({ ok: false, error }, { status, headers: { 'Cache-Control': 'no-store' } })
    : back(`?e=${code}`);

  const form = await readForm(request);
  if (!form) return new Response('Bad request', { status: 400 });
  const raw = String(form.get('body') ?? '').trim();
  if (!raw) return refuse('empty', THREAD.failed);
  if (raw.length > BODY_MAX) return refuse('long', THREAD.tooLong, 413);

  // A finished order is a record, not a conversation. The customer's own page
  // stops taking words at the same point, so neither side can talk into a
  // thread the other cannot answer.
  if (!threadOpen(order.status)) return refuse('closed', THREAD.closed, 409);

  const body = normaliseBody(raw);
  const id = await postMessage({ orderId: order.id, sender: 'owner', via: 'web', body });
  if (id === null) return refuse('empty', THREAD.failed);

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

  if (wantsJson) return Response.json({
    ok: true,
    message: { id, sender: 'owner', via: 'web', body, image_key: null, created_at: Math.floor(Date.now() / 1000) },
  }, { headers: { 'Cache-Control': 'no-store' } });
  return back('?sent=1');
};
