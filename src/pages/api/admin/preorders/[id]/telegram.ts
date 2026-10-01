import type { APIRoute } from 'astro';
import { publishPreorder } from '../../../../../lib/preorders';

export const prerender = false;

/**
 * Posts a pre-order to the channel, or updates the post it already has.
 *
 * POST only: it writes to a public channel, so it must not be reachable by
 * following a link - see the note in src/lib/publish.ts.
 */
export const POST: APIRoute = async ({ params, url }) => {
  const id = Number.parseInt(params.id ?? '', 10);
  if (!Number.isInteger(id)) return new Response('Bad request', { status: 400 });

  const result = await publishPreorder(id, url.origin);
  return new Response(null, {
    status: 302,
    headers: { Location: `/admin/preorders/${id}?tg=${result}` },
  });
};
