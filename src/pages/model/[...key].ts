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

  const object = await bucket.get(key);
  if (!object) return new Response('Not found', { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  // A model file never changes under its own name; a new one gets a new name.
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');

  const extension = key.split('.').pop()?.toLowerCase() ?? '';
  if (TYPES[extension]) headers.set('Content-Type', TYPES[extension]);

  if (request.headers.get('If-None-Match') === object.httpEtag) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(object.body, { headers });
};
