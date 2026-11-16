import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { readForm } from '../../../../../lib/request-body';

export const prerender = false;

interface UploadEnv {
  UPLOADS?: R2Bucket;
}

/** A 1200x630 JPEG is well under this; anything bigger is not the card. */
const MAX_BYTES = 1024 * 1024;

/**
 * The picture a shared shipment link shows.
 *
 * Drawn by the portal page in the owner's browser - origin, date and count in
 * a stamp - because nothing on the edge can draw it. This only stores what it
 * is sent, under a fresh key so no chat app's cached copy of the old card can
 * stand in for the new one, and remembers what it was drawn from (`sig`) so
 * the page can tell when the shipment has changed under it.
 */
export const POST: APIRoute = async ({ params, request }) => {
  const id = Number.parseInt(params.id ?? '', 10);
  if (!Number.isInteger(id)) return new Response('Bad request', { status: 400 });

  const bucket = (env as unknown as UploadEnv).UPLOADS;
  if (!bucket) return new Response('Photo storage is not configured.', { status: 503 });

  const form = await readForm(request);
  if (!form) return new Response('Bad request', { status: 400 });
  const card = form.get('card');
  const sig = String(form.get('sig') ?? '').slice(0, 300);
  if (!(card instanceof File) || card.type !== 'image/jpeg' || card.size === 0 || card.size > MAX_BYTES) {
    return new Response('Expected a JPEG card', { status: 400 });
  }

  const previous = await env.DB.prepare('SELECT card_key FROM shipments WHERE id = ?')
    .bind(id)
    .first<{ card_key: string | null }>();
  if (!previous) return new Response('No such shipment', { status: 404 });

  const key = `uploads/shipments/${id}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.jpg`;
  await bucket.put(key, card.stream(), {
    httpMetadata: { contentType: 'image/jpeg', cacheControl: 'public, max-age=31536000, immutable' },
  });
  await env.DB.prepare('UPDATE shipments SET card_key = ?, card_sig = ? WHERE id = ?')
    .bind(key, sig, id)
    .run();

  /* The old card goes once nothing points at it. A failure only strands a
     small file, so it is logged rather than reported. */
  if (previous.card_key) {
    await bucket.delete(previous.card_key).catch((err) => console.error('[shipments] card delete failed', err));
  }

  return Response.json({ ok: true, key });
};
