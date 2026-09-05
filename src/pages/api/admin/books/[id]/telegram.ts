import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { publishListing, publishQuery } from '../../../../../lib/publish';
import { captionToStore } from '../../../../../lib/channel-caption';

export const prerender = false;

/**
 * POST only. This writes to the database and posts publicly, so it must not be
 * reachable by following a URL - see the note in src/lib/publish.ts.
 *
 * The post is written here as well as sent, because the channel post is not
 * part of the listing and asking the owner to save the listing before the
 * button beside the box would do anything was a small lie about how the two
 * relate. Editing the post and sending it is one action, so it is one form
 * and one request.
 */
export const POST: APIRoute = async ({ params, request, url }) => {
  const id = Number.parseInt(params.id ?? '', 10);
  if (!Number.isInteger(id)) return new Response('Bad request', { status: 400 });

  /*
   * A GET or a bodyless POST still reaches this - the button posts a form, but
   * nothing else has to - so an absent field means "do not touch the caption"
   * rather than "clear it".
   */
  const form = await request.formData().catch(() => null);
  if (form?.has('telegram_caption')) {
    await env.DB.prepare('UPDATE books SET telegram_caption = ? WHERE id = ?')
      .bind(captionToStore(form), id)
      .run();
  }

  const result = await publishListing(id, url.origin);

  return new Response(null, {
    status: 302,
    headers: { Location: `/admin/books/${id}?posted=${publishQuery(result)}` },
  });
};
