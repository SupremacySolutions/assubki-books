import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getOrder } from '../../../lib/orders';
import { messageInOrder } from '../../../lib/messages';

export const prerender = false;

interface UploadEnv {
  UPLOADS?: R2Bucket;
}

/**
 * A photo from a thread, read back by the customer who sent it.
 *
 * This route exists because `src/pages/img/[...key].ts` must not grow a third
 * prefix. That one is public, unauthenticated, and answers with a year-long
 * immutable cache - correct for a book cover and catastrophic for a payment
 * screenshot, which shows a bank balance, an account number and a real name.
 *
 * Two checks, both required: the order token has to be right, and the message
 * has to belong to *that* order. Without the second, a valid token for one
 * order would read every screenshot in the shop by walking the id.
 */
export const GET: APIRoute = async ({ url }) => {
  const ref = url.searchParams.get('ref')?.trim() ?? '';
  const token = url.searchParams.get('t') ?? '';
  const id = Number.parseInt(url.searchParams.get('id') ?? '', 10);

  const missing = new Response('Not found', { status: 404 });
  if (!ref || !token || !Number.isInteger(id)) return missing;

  const order = await getOrder(ref, token);
  if (!order) return missing;

  const message = await messageInOrder(order.id, id);
  if (!message?.image_key) return missing;

  const bucket = (env as unknown as UploadEnv).UPLOADS;
  const object = bucket ? await bucket.get(message.image_key) : null;
  if (!object) return missing;

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  // Never shared, never stored: this is the one image on the site that must not
  // outlive the request in anybody's cache.
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(object.body, { headers });
};
