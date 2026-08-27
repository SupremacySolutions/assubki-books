import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const prerender = false;

interface UploadEnv {
  UPLOADS?: R2Bucket;
}

/**
 * Serves owner-uploaded photos from R2.
 *
 * Only `uploads/` reaches this route. The 454 migrated covers live under
 * `books/` in public/img and are served as static assets, which shadow this
 * route entirely — so the prefix decides the storage without any branching in
 * the pages themselves.
 */
export const GET: APIRoute = async ({ params, request }) => {
  const key = params.key ?? '';

  // Without this, `/img/../something` or a `books/` key would let this route
  // be used to probe storage it has no business reading.
  if (!key.startsWith('uploads/') || key.includes('..')) {
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
