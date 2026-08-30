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

  const object = await bucket.get(key);
  if (!object) return new Response('Not found', { status: 404 });

  // A preset varies the bytes, so it has to vary the etag too - otherwise a
  // browser holding the full-size cover would be told its copy of the 84px one
  // is still good.
  const wanted = new URL(request.url).searchParams.get('p') ?? '';
  const preset = isPreset(wanted) ? wanted : null;
  const etag = preset ? `${object.httpEtag.slice(0, -1)}-${preset}"` : object.httpEtag;

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', etag);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');

  // Uploads are immutable, so a matching etag can always be answered with 304.
  if (request.headers.get('If-None-Match') === etag) {
    return new Response(null, { status: 304, headers });
  }

  if (!preset) return new Response(object.body, { headers });

  /*
   * The sizes are made once by scripts/standardise-covers.mjs and stored beside
   * the master, rather than transformed as they are served: transforming needs
   * Cloudflare Images, which is not enabled on this account and is not free.
   *
   * Only standardised covers have variants, so only they are looked up - an
   * older key or an owner's upload would otherwise cost a second R2 read on
   * every request to discover something that was never there.
   */
  const master = key.endsWith('-std.webp');
  if (master) {
    const variant = await bucket.get(key.replace(/\.webp$/, `-${preset}.webp`));
    if (variant) {
      const framed = new Headers(headers);
      variant.writeHttpMetadata(framed);
      framed.set('etag', etag);
      framed.set('Cache-Control', 'public, max-age=31536000, immutable');
      framed.set('Content-Type', 'image/webp');
      return new Response(variant.body, { headers: framed });
    }
  }

  // No variant: the master is the right image, just larger than this place
  // needs. Better a heavy cover than a missing one.
  return new Response(object.body, { headers });
};
