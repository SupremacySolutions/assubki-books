import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { deleteChannelPost } from '../../../../../lib/telegram';
import { forgetCategoryCounts, forgetHomeRows } from '../../../../../lib/db';

export const prerender = false;

interface UploadEnv {
  UPLOADS?: R2Bucket;
}

/**
 * Deletes a listing.
 *
 * Order history survives: `order_items.book_id` is ON DELETE SET NULL and each
 * row keeps its own title and price snapshot, so a past order still reads
 * correctly after the book is gone.
 */
export const POST: APIRoute = async ({ params, request }) => {
  const id = Number.parseInt(params.id ?? '', 10);
  if (!Number.isInteger(id)) return new Response('Bad request', { status: 400 });

  const book = await env.DB.prepare(
    'SELECT id, title, reserved, telegram_message_id, telegram_album_ids FROM books WHERE id = ?',
  )
    .bind(id)
    .first<{
      id: number;
      title: string;
      reserved: number;
      telegram_message_id: number | null;
      telegram_album_ids: string | null;
    }>();

  if (!book) return new Response(null, { status: 302, headers: { Location: '/admin/books' } });

  // Copies promised to a live order cannot be deleted out from under it - the
  // customer is still waiting on those books.
  if (book.reserved > 0) {
    return new Response(null, {
      status: 302,
      headers: { Location: `/admin/books/${id}?e=held` },
    });
  }

  // Every photo lives in R2 now, migrated covers included, so deleting a
  // listing actually reclaims its files rather than orphaning them.
  const bucket = (env as unknown as UploadEnv).UPLOADS;
  if (bucket) {
    const { results: images } = await env.DB.prepare(
      'SELECT image_key FROM book_images WHERE book_id = ?',
    )
      .bind(id)
      .all<{ image_key: string }>();
    for (const img of images) {
      await bucket.delete(img.image_key).catch((err) => console.error('[delete] R2', err));
    }
  }

  /*
   * Leaving the announcement up would advertise a book that no longer exists.
   *
   * Every message it occupies, not just the first. A listing posted with
   * several photographs is an album - one message each - and clearing only the
   * captioned one would leave the photographs behind with nothing to click.
   *
   * `telegram_album_ids` is absent on anything posted before albums existed,
   * and those really are a single message, so the id already recorded is the
   * whole post.
   */
  let channelCleared = true;
  if (book.telegram_message_id) {
    let ids: number[] = [book.telegram_message_id];
    try {
      const stored = book.telegram_album_ids ? JSON.parse(book.telegram_album_ids) : null;
      if (Array.isArray(stored) && stored.length) ids = stored.filter((n) => Number.isInteger(n));
    } catch {
      // Unreadable is not a reason to leave the post up: fall back to the id
      // that has always been there and clear what can be cleared.
    }
    channelCleared = await deleteChannelPost(ids);
  }

  // book_images, book_categories and stock_ledger cascade; order_items null out.
  await env.DB.prepare('DELETE FROM books WHERE id = ?').bind(id).run();

  // The shelf counts are cached for a minute; the owner should see their own
  // change now rather than in a minute.
  forgetCategoryCounts();
  forgetHomeRows();

  const url = new URL(request.url);
  const flag = channelCleared ? 'deleted' : 'deleted-orphan';
  return new Response(null, {
    status: 302,
    headers: { Location: `${url.origin}/admin/books?${flag}=${encodeURIComponent(book.title)}` },
  });
};
