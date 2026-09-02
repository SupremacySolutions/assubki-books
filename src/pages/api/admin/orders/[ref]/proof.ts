import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getOrderByRef } from '../../../../../lib/admin-db';
import { messageInOrder } from '../../../../../lib/messages';

export const prerender = false;

interface UploadEnv {
  UPLOADS?: R2Bucket;
}

/**
 * The owner reading a photo a customer sent.
 *
 * The same object as `/api/orders/proof`, reached with the portal session
 * instead of the order token. It exists separately rather than the portal
 * borrowing the customer's link because the owner should never need to hold a
 * customer's token to do their job.
 *
 * The message is still checked against the order in the URL: the portal has no
 * business reading a screenshot by walking message ids either.
 */
export const GET: APIRoute = async ({ params, url }) => {
  const ref = params.ref!;
  const id = Number.parseInt(url.searchParams.get('id') ?? '', 10);
  const missing = new Response('Not found', { status: 404 });
  if (!Number.isInteger(id)) return missing;

  const order = await getOrderByRef(ref);
  if (!order) return missing;

  const message = await messageInOrder(order.id, id);
  if (!message?.image_key) return missing;

  const bucket = (env as unknown as UploadEnv).UPLOADS;
  const object = bucket ? await bucket.get(message.image_key) : null;
  if (!object) return missing;

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(object.body, { headers });
};
