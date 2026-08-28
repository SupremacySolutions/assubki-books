import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

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

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');

  // Uploads are immutable, so a matching etag can always be answered with 304.
  if (request.headers.get('If-None-Match') === object.httpEtag) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(object.body, { headers });
};
