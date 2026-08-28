import type { APIRoute } from 'astro';
import { publishListing, publishQuery } from '../../../../../lib/publish';

export const prerender = false;

/**
 * POST only. This writes to the database and posts publicly, so it must not be
 * reachable by following a URL - see the note in src/lib/publish.ts.
 */
export const POST: APIRoute = async ({ params, url }) => {
  const id = Number.parseInt(params.id ?? '', 10);
  if (!Number.isInteger(id)) return new Response('Bad request', { status: 400 });

  const result = await publishListing(id, url.origin);

  return new Response(null, {
    status: 302,
    headers: { Location: `/admin/books/${id}?posted=${publishQuery(result)}` },
  });
};
