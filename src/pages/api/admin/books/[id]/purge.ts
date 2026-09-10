import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { purgeOne } from '../../../../../lib/book-deletion';

export const prerender = false;

interface UploadEnv {
  UPLOADS?: R2Bucket;
}

/**
 * Gives up the rest of a listing's time in the bin and destroys it now.
 *
 * The escape hatch that stops a two-phase delete reading as the shop refusing
 * to obey. It only ever acts on something already in the bin: deleting is still
 * two decisions, and this is the second one, not a way to skip the first.
 */
export const POST: APIRoute = async ({ params, request }) => {
  const id = Number.parseInt(params.id ?? '', 10);
  if (!Number.isInteger(id)) return new Response('Bad request', { status: 400 });

  const url = new URL(request.url);
  const back = new URL('/admin/books', url.origin);
  back.searchParams.set('filter', 'deleted');

  const done = await purgeOne(env.DB, (env as unknown as UploadEnv).UPLOADS, id);
  if (!done) {
    back.searchParams.set('e', 'gone');
    return new Response(null, { status: 302, headers: { Location: back.pathname + back.search } });
  }

  back.searchParams.set('purged', done.title);
  return new Response(null, { status: 302, headers: { Location: back.pathname + back.search } });
};
