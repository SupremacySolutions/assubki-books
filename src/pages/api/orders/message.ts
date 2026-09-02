import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getOrder } from '../../../lib/orders';
import { notifyNewMessage } from '../../../lib/notify';
import { THREAD } from '../../../lib/order-status';
import {
  BODY_MAX,
  IMAGES_PER_ORDER,
  PROOF_PREFIX,
  imageCount,
  normaliseBody,
  overHourlyCap,
  postMessage,
  threadOpen,
} from '../../../lib/messages';

export const prerender = false;

/**
 * A customer writing to the shop about their own order.
 *
 * Authority is the token that already reaches this customer's order page -
 * `getOrder` compares it in constant time and returns nothing for a miss, so a
 * wrong token is indistinguishable from a wrong reference. There is no session
 * and no cookie, which is also why there is no CSRF token to check: nothing
 * here can be forged by a page that does not already know the token. Astro's
 * `checkOrigin` is on by default and already refuses a cross-site form post.
 *
 * A plain form post, because the whole flow has to work with JavaScript off.
 * The script layer asks for JSON with an Accept header and gets the message
 * back instead of a redirect; everything else about the route is identical.
 */

const MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
]);

interface UploadEnv {
  UPLOADS?: R2Bucket;
}

export const POST: APIRoute = async ({ request }) => {
  const form = await request.formData();
  const ref = String(form.get('ref') ?? '').trim();
  const token = String(form.get('t') ?? '');

  const wantsJson = (request.headers.get('Accept') ?? '').includes('application/json');
  const back = (query: string) =>
    new Response(null, {
      status: 302,
      headers: {
        Location:
          `/order?ref=${encodeURIComponent(ref)}&t=${encodeURIComponent(token)}${query}#thread`,
      },
    });
  /*
   * One shape for both callers. The form post carries the reason in the query
   * string and the page turns it back into a sentence; the script gets the
   * sentence itself, because it has nowhere to look it up.
   */
  const refuse = (code: string, message: string, status = 400) =>
    wantsJson
      ? Response.json({ ok: false, error: message }, { status, headers: { 'Cache-Control': 'no-store' } })
      : back(`&e=${code}`);

  const order = await getOrder(ref, token);
  if (!order) return new Response('Not found', { status: 404 });

  // A finished order keeps its conversation readable and stops taking words:
  // there is nobody left to answer.
  if (!threadOpen(order.status)) return refuse('closed', THREAD.closed, 409);

  const body = normaliseBody(form.get('body'));
  const raw = String(form.get('body') ?? '').trim();
  if (raw.length > BODY_MAX) return refuse('long', THREAD.tooLong, 413);

  const file = form.get('image');
  const hasImage = file instanceof File && file.size > 0;

  if (!body && !hasImage) return refuse('empty', THREAD.failed);

  if (await overHourlyCap(order.id)) return refuse('rate', THREAD.tooMany, 429);

  // ------------------------------------------------------------------ image
  let imageKey: string | null = null;
  if (hasImage) {
    const image = file as File;
    if (image.size > MAX_BYTES) return refuse('big', THREAD.imageTooBig, 413);

    const ext = ALLOWED.get(image.type);
    if (!ext) return refuse('type', THREAD.imageWrongType, 415);

    if ((await imageCount(order.id)) >= IMAGES_PER_ORDER) {
      return refuse('images', THREAD.imageCapped, 409);
    }

    const bucket = (env as unknown as UploadEnv).UPLOADS;
    if (!bucket) return refuse('nostore', THREAD.failed, 503);

    /*
     * `proofs/`, and nothing else, because src/pages/img/[...key].ts serves
     * `books/` and `uploads/` to the whole internet with a year-long cache. A
     * payment screenshot shows a bank balance, an account number and a real
     * name; it is read back only through the token-gated route beside this one.
     *
     * The order id rather than the reference: a reference is short, guessable
     * and printed on emails, and the key should not be either.
     */
    imageKey = `${PROOF_PREFIX}${order.id}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
    await bucket.put(imageKey, image.stream(), {
      httpMetadata: { contentType: image.type, cacheControl: 'private, no-store' },
    });
  }

  /*
   * If the row cannot be written, take the object back out.
   *
   * The sweep finds screenshots by walking `messages`, so an object with no row
   * pointing at it is never collected - it would sit in the bucket for good,
   * which is precisely what a payment screenshot must not do.
   */
  let id: number | null = null;
  try {
    id = await postMessage({ orderId: order.id, sender: 'customer', via: 'web', body, imageKey });
  } catch (err) {
    if (imageKey) {
      await (env as unknown as UploadEnv).UPLOADS?.delete(imageKey).catch(() => {});
    }
    throw err;
  }
  if (id === null) {
    if (imageKey) {
      await (env as unknown as UploadEnv).UPLOADS?.delete(imageKey).catch(() => {});
    }
    return refuse('empty', THREAD.failed);
  }

  /*
   * The message is committed before this runs, and a Telegram outage must not
   * turn into a 500 that loses what the customer typed - `notifyNewMessage`
   * records its own failures and never throws.
   */
  await notifyNewMessage({
    orderId: order.id,
    ref: order.ref,
    sender: 'customer',
    name: order.customer_name,
    email: order.email,
    telegramChatId: order.telegram_chat_id,
    body,
    hasImage: Boolean(imageKey),
    origin: new URL(request.url).origin,
  });

  if (wantsJson) {
    return Response.json(
      {
        ok: true,
        message: {
          id,
          sender: 'customer',
          via: 'web',
          body,
          image_key: imageKey,
          created_at: Math.floor(Date.now() / 1000),
        },
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }
  return back('&sent=1');
};
