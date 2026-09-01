import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { notifyCancelDeclined } from '../../../../../lib/notify';

export const prerender = false;

/**
 * The owner declining a cancellation the customer asked for.
 *
 * Approving needs nothing of its own: it is the ordinary cancel action, which
 * already releases the copies, records the owner's note and messages the
 * customer. Only saying no needs a route, because saying no leaves the order
 * exactly as it was and the customer has to be told - otherwise they are left
 * on a page saying "still live until we reply" forever.
 */
export const POST: APIRoute = async ({ params, request }) => {
  const ref = String(params.ref ?? '');
  const form = await request.formData();
  const note = String(form.get('note') ?? '').trim().slice(0, 600) || null;

  const order = await env.DB.prepare(
    `SELECT id, ref, customer_name, email, telegram_chat_id, access_token
       FROM orders WHERE ref = ? AND cancel_requested_at IS NOT NULL`,
  )
    .bind(ref)
    .first<{
      id: number; ref: string; customer_name: string; email: string;
      telegram_chat_id: string | null; access_token: string;
    }>();

  if (!order) return new Response('No such request', { status: 404 });

  await env.DB.prepare(
    `UPDATE orders SET cancel_requested_at = NULL, updated_at = unixepoch() WHERE id = ?`,
  )
    .bind(order.id)
    .run();

  await notifyCancelDeclined({
    ref: order.ref,
    token: order.access_token,
    name: order.customer_name,
    email: order.email,
    telegramChatId: order.telegram_chat_id,
    note,
    origin: new URL(request.url).origin,
  }).catch(() => {
    /* the flag is cleared either way; the portal is the record */
  });

  return new Response(null, { status: 302, headers: { Location: `/admin/orders/${ref}` } });
};
