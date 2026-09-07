import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const prerender = false;

interface UploadEnv {
  UPLOADS?: R2Bucket;
}

/**
 * Serves the background-removal model from R2.
 *
 * Self-hosted rather than pulled from Hugging Face at run time: the portal
 * then depends on nothing outside this origin, and an upstream URL changing
 * cannot silently break the feature months later. R2 charges nothing for
 * egress, and the file is downloaded once per browser and then cached for a
 * year, so it costs nothing to keep here.
 *
 * Only the weights. The runtime is bundled with the site and served as an
 * ordinary hashed asset, so hosting a second copy of it here would have been
 * 13MB of the same file under a different name.
 *
 * The model is U²-Netp, Apache-2.0. Deliberately not BRIA RMBG, which every
 * example reaches for and which is licensed for non-commercial use only - a
 * shop is not that.
 */
const SERVED_PREFIX = 'models/';

const TYPES: Record<string, string> = {
  onnx: 'application/octet-stream',
  wasm: 'application/wasm',
  mjs: 'text/javascript',
  json: 'application/json',
};

export const GET: APIRoute = async ({ params, request }) => {
  const key = params.key ?? '';

  // One prefix, and no traversal, so this cannot be turned into a reader for
  // the rest of the bucket - which also holds every customer's cover photos.
  if (!key.startsWith(SERVED_PREFIX) || key.includes('..')) {
    return new Response('Not found', { status: 404 });
  }

  const bucket = (env as unknown as UploadEnv).UPLOADS;
  if (!bucket) return new Response('Not found', { status: 404 });

  /*
   * Ranges are honoured, which matters for exactly one file.
   *
   * The better weights are 168MB. Served without this the browser has one
   * attempt at all of them in a single response, and a phone that changes cell
   * on the way through starts again from nothing - which, on the connection an
   * owner is likely to be on, it may never finish doing. R2 can hand back a
   * slice, so let it: a resumed download picks up where it stopped.
   */
  const wanted = request.headers.get('Range');
  const object = await bucket.get(key, wanted ? { range: request.headers } : undefined);
  if (!object) {
    // R2 returns null for a missing key, including when Range was supplied.
    return new Response('Not found', { status: 404 });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  // A model file never changes under its own name; a new one gets a new name.
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('Accept-Ranges', 'bytes');

  const extension = key.split('.').pop()?.toLowerCase() ?? '';
  if (TYPES[extension]) headers.set('Content-Type', TYPES[extension]);

  if (request.headers.get('If-None-Match') === object.httpEtag) {
    return new Response(null, { status: 304, headers });
  }

  // `range` is present on the object only when R2 actually served a slice.
  const served = (object as R2ObjectBody & { range?: { offset: number; length: number } }).range;
  if (wanted && served) {
    const start = served.offset;
    const finish = start + served.length - 1;
    headers.set('Content-Range', `bytes ${start}-${finish}/${object.size}`);
    headers.set('Content-Length', String(served.length));
    return new Response(object.body, { status: 206, headers });
  }

  return new Response(object.body, { headers });
};
