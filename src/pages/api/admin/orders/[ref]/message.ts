import type { APIRoute } from 'astro';
import { getOrderByRef } from '../../../../../lib/admin-db';
import { notifyNewMessage } from '../../../../../lib/notify';
import {
  BODY_MAX,
  OWNER_IMAGES_PER_ORDER,
  dropImage,
  imageCount,
  normaliseBody,
  postMessage,
  storeImage,
  threadOpen,
} from '../../../../../lib/messages';
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
 * The owner can attach a photo. It was customer-only on the reasoning that the
 * shop had nothing to show, and the shop turned out to have plenty: which
 * edition is on the shelf, what a set looks like, the label on the parcel. It
 * goes in the same private store as the customer's screenshots, is read back
 * through the same order-gated routes, and is swept with them.
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
  if (raw.length > BODY_MAX) return refuse('long', THREAD.tooLong, 413);

  const file = form.get('image');
  const hasImage = file instanceof File && file.size > 0;
  if (!raw && !hasImage) return refuse('empty', THREAD.failed);

  // A finished order is a record, not a conversation. The customer's own page
  // stops taking words at the same point, so neither side can talk into a
  // thread the other cannot answer.
  if (!threadOpen(order.status)) return refuse('closed', THREAD.closed, 409);

  let imageKey: string | null = null;
  if (hasImage) {
    if ((await imageCount(order.id, 'owner')) >= OWNER_IMAGES_PER_ORDER) {
      return refuse('images', THREAD.ownerImageCapped, 409);
    }
    const stored = await storeImage(order.id, file as File);
    if ('refusal' in stored) {
      const why = {
        big: [THREAD.imageTooBig, 413],
        type: [THREAD.imageWrongType, 415],
        nostore: [THREAD.failed, 503],
      } as const;
      const [message, status] = why[stored.refusal];
      return refuse(stored.refusal, message, status);
    }
    imageKey = stored.key;
  }

  const body = normaliseBody(raw);
  let id: number | null = null;
  try {
    id = await postMessage({ orderId: order.id, sender: 'owner', via: 'web', body, imageKey });
  } catch (err) {
    await dropImage(imageKey);
    throw err;
  }
  if (id === null) {
    await dropImage(imageKey);
    return refuse('empty', THREAD.failed);
  }

  await notifyNewMessage({
    orderId: order.id,
    ref: order.ref,
    sender: 'owner',
    name: order.customer_name,
    email: order.email,
    telegramChatId: order.telegram_chat_id,
    body,
    hasImage: Boolean(imageKey),
    origin: new URL(request.url).origin,
  });

  if (wantsJson) return Response.json({
    ok: true,
    message: {
      id, sender: 'owner', via: 'web', body, image_key: imageKey,
      had_image: imageKey ? 1 : 0, created_at: Math.floor(Date.now() / 1000),
    },
  }, { headers: { 'Cache-Control': 'no-store' } });
  return back('?sent=1');
};
