import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { IMAGE_PRESETS, isPreset, FRAME_BACKGROUND } from '../../lib/image-presets';

export const prerender = false;

interface UploadEnv {
  UPLOADS?: R2Bucket;
  /**
   * Added by the Astro Cloudflare adapter rather than by wrangler.jsonc, so it
   * is not in the generated Env types. Optional here because it is absent in
   * local dev, where every request simply falls through untransformed.
   */
  /**
   * Off until Cloudflare Images is enabled on the account. Without it, every
   * request would attempt a transform that cannot work, fail, and then read the
   * object from R2 a second time to recover - doubling the reads on every cover
   * to achieve nothing.
   */
  IMAGE_TRANSFORMS?: string;
  IMAGES?: {
    input: (stream: ReadableStream) => {
      transform: (options: Record<string, unknown>) => {
        output: (options: Record<string, unknown>) => Promise<{ image: () => ReadableStream }>;
      };
    };
  };
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

  const frame = IMAGE_PRESETS[preset];
  const cfEnv = env as unknown as UploadEnv;
  const images = cfEnv.IMAGE_TRANSFORMS === '1' ? cfEnv.IMAGES : undefined;

  /*
   * Padded, never cropped: a spine or a landscape scan keeps all of itself and
   * gains background instead. The frame colour is the page's own, so the
   * padding is invisible where it lands.
   *
   * A failure here falls through to the untransformed image rather than
   * erroring. A cover that is the wrong shape is a blemish; a catalogue of
   * broken images is a shop that looks shut.
   */
  // Not enabled: serve the stored image. The preset still shapes the layout
  // through the width and height the page reserves, so nothing looks broken -
  // the covers are simply not yet resized on the way out.
  if (!images) return new Response(object.body, { headers });

  try {
    const result = await images
      .input(object.body)
      .transform({
        width: frame.width * frame.scale,
        height: frame.height * frame.scale,
        fit: 'pad',
        background: FRAME_BACKGROUND,
      })
      .output({ format: 'image/webp' });

    headers.set('Content-Type', 'image/webp');
    return new Response(result.image(), { headers });
  } catch (err) {
    console.error('[img] transform failed, serving the original', key, preset, err);
    // The stream above may be partly consumed, so re-read rather than reuse it.
    const fallback = await bucket.get(key);
    if (!fallback) return new Response('Not found', { status: 404 });
    const plain = new Headers(headers);
    plain.set('etag', object.httpEtag);
    return new Response(fallback.body, { headers: plain });
  }
};
