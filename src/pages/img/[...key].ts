import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { isPreset } from '../../lib/image-presets';

export const prerender = false;

interface UploadEnv {
  UPLOADS?: R2Bucket;
}

/**
 * Serves book photos from R2.
 *
 * Both prefixes live here now: `books/` for the migrated covers and `uploads/`
 * for anything the owner adds. They were split while R2 was unavailable, which
 * meant deleting a listing removed its database rows but left the files behind
 * forever - and a migrated cover could not really be deleted at all.
 */
const SERVED_PREFIXES = ['books/', 'uploads/'];
export const GET: APIRoute = async ({ params, request }) => {
  const key = params.key ?? '';

  // Keep this route to the two prefixes it owns, and refuse traversal, so it
  // cannot be used to read anything else in the bucket.
  if (!SERVED_PREFIXES.some((p) => key.startsWith(p)) || key.includes('..')) {
    return new Response('Not found', { status: 404 });
  }

  const bucket = (env as unknown as UploadEnv).UPLOADS;
  if (!bucket) return new Response('Not found', { status: 404 });

  // A preset varies the bytes, so it has to vary the etag too - otherwise a
  // browser holding the full-size cover would be told its copy of the 84px one
  // is still good.
  const wanted = new URL(request.url).searchParams.get('p') ?? '';
  const preset = isPreset(wanted) ? wanted : null;

  /*
   * The sizes are made once by scripts/resize-covers.mjs and stored beside the
   * original rather than transformed on the way out: transforming needs
   * Cloudflare Images, which is not enabled on this account and is not free.
   *
   * The variant is asked for *first*. Reading the original and then the
   * variant cost two R2 reads on every sized request, which is every cover on
   * every page; this way the common case is one, and only a size that was
   * never made pays for the miss.
   */
  const variant = preset ? await bucket.get(variantKey(key, preset)) : null;

  // No variant - the original is the right image, just larger than this place
  // needs. Better a heavy cover than a missing one, and `detail` has no file
  // at all by design.
  const object = variant ?? (await bucket.get(key));
  if (!object) return new Response('Not found', { status: 404 });

  // Taken from whatever was actually served, so no second read is needed to
  // build it. A variant has different bytes and therefore a different etag
  // already; the suffix keeps a fallback-to-original distinct from the plain
  // request for the same key.
  const etag = preset ? `${object.httpEtag.slice(0, -1)}-${preset}"` : object.httpEtag;

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  if (variant) headers.set('Content-Type', 'image/webp');
  headers.set('etag', etag);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');

  // Uploads are immutable, so a matching etag can always be answered with 304.
  if (request.headers.get('If-None-Match') === etag) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(object.body, { headers });
};

/**
 * "books/x/1.webp" + "card" → "books/x/1-card.webp".
 *
 * Any extension, not only `.webp`: an owner's upload keeps whatever it
 * arrived as, while every derived size is written as WebP.
 */
function variantKey(key: string, preset: string): string {
  return `${key.replace(/\.[a-z0-9]+$/i, '')}-${preset}.webp`;
}
