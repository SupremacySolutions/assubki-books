import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { deleteChannelMessage } from '../../../../../lib/telegram';

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
    'SELECT id, title, reserved, telegram_message_id FROM books WHERE id = ?',
  )
    .bind(id)
    .first<{ id: number; title: string; reserved: number; telegram_message_id: number | null }>();

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

  // Leaving the announcement up would advertise a book that no longer exists.
  let channelCleared = true;
  if (book.telegram_message_id) {
    channelCleared = await deleteChannelMessage(book.telegram_message_id);
  }

  // book_images, book_categories and stock_ledger cascade; order_items null out.
  await env.DB.prepare('DELETE FROM books WHERE id = ?').bind(id).run();

  const url = new URL(request.url);
  const flag = channelCleared ? 'deleted' : 'deleted-orphan';
  return new Response(null, {
    status: 302,
    headers: { Location: `${url.origin}/admin/books?${flag}=${encodeURIComponent(book.title)}` },
  });
};
