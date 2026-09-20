import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { backInStock, publishListing, publishQuery, repostListing } from '../../../../../lib/publish';
import { AVAILABLE_SQL } from '../../../../../lib/availability';
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

  /*
   * Repost or edit, decided here from the same test the page used to label the
   * button - so the default is right with scripting off, and a stale page
   * cannot repost a book the channel already shows in stock.
   *
   * Both directions can be overridden, because the automatic answer only knows
   * about stock. `?mode=edit` is the owner keeping the old post when the shop
   * would have replaced it; `?mode=repost` is the owner replacing it when the
   * shop would have edited - the photographs changed, or the post is simply old
   * and buried, neither of which `backInStock` can see.
   */
  const row = await env.DB.prepare(
    `SELECT b.telegram_message_id, b.telegram_shown_available, b.telegram_sold_out_at,
            ${AVAILABLE_SQL} AS available
       FROM books b WHERE b.id = ?`,
  )
    .bind(id)
    .first<{
      telegram_message_id: number | null;
      telegram_shown_available: number | null;
      telegram_sold_out_at: number | null;
      available: number;
    }>();
  const mode = url.searchParams.get('mode');
  /*
   * A repost needs a post to replace. Asking for one on a listing that has
   * never been announced is the ordinary first post, not an error - there is
   * nothing to take down and `publishListing` does exactly the right thing.
   */
  const repost = row !== null && row.telegram_message_id !== null &&
    (mode === 'repost' || (mode !== 'edit' && backInStock(row, row.available)));

  const result = repost ? await repostListing(id, url.origin) : await publishListing(id, url.origin);

  return new Response(null, {
    status: 302,
    headers: { Location: `/admin/books/${id}?posted=${publishQuery(result)}` },
  });
};
