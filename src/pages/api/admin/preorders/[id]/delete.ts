import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { deleteCover, preorderPhotos, unpostPreorder } from '../../../../../lib/preorders';

export const prerender = false;

/**
 * Deletes a pre-order, everybody's interest in it, its photos, and - where
 * Telegram still allows - its channel post.
 *
 * The names go with it, which is the promise on the privacy page:
 * once the owner is done with a pre-order, the addresses are not kept.
 *
 * The post is taken down first and its failure reported rather than hidden. A
 * bot may only delete its own messages within 48 hours; past that the post has
 * to come down by hand, and the owner can only do that if told.
 */
export const POST: APIRoute = async ({ params }) => {
  const id = Number.parseInt(params.id ?? '', 10);
  if (!Number.isInteger(id)) return new Response('Bad request', { status: 400 });

  const row = await env.DB.prepare(
    'SELECT title, image_key, telegram_message_id, telegram_album_ids FROM preorders WHERE id = ?',
  )
    .bind(id)
    .first<{
      title: string;
      image_key: string | null;
      telegram_message_id: number | null;
      telegram_album_ids: string | null;
    }>();
  if (!row) return new Response(null, { status: 302, headers: { Location: '/admin/preorders' } });

  const unposted = row.telegram_message_id
    ? await unpostPreorder(row.telegram_message_id, row.telegram_album_ids)
    : true;
  // Read before the rows go: the files are found through them.
  const photos = await preorderPhotos(id);
  // The cascade would take the names; saying so outright means the promise
  // does not rest on a pragma.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM preorder_interest WHERE preorder_id = ?').bind(id),
    env.DB.prepare('DELETE FROM preorder_images WHERE preorder_id = ?').bind(id),
    env.DB.prepare('DELETE FROM preorders WHERE id = ?').bind(id),
  ]);
  // The cover is photo 0, so it is in this list; the row's own copy is only
  // read for a pre-order whose photos predate the table.
  const keys = new Set([...photos.map((photo) => photo.image_key), row.image_key]);
  await Promise.all([...keys].map((key) => deleteCover(key)));

  const back = new URLSearchParams({ deleted: row.title });
  if (!unposted) back.set('orphan', '1');
  return new Response(null, { status: 302, headers: { Location: `/admin/preorders?${back}` } });
};
