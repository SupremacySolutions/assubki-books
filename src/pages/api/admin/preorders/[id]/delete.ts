import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { deleteCover, unpostPreorder } from '../../../../../lib/preorders';

export const prerender = false;

/**
 * Deletes a pre-order, everybody's interest in it, its cover, and - where
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
    'SELECT title, image_key, telegram_message_id FROM preorders WHERE id = ?',
  )
    .bind(id)
    .first<{ title: string; image_key: string | null; telegram_message_id: number | null }>();
  if (!row) return new Response(null, { status: 302, headers: { Location: '/admin/preorders' } });

  const unposted = row.telegram_message_id ? await unpostPreorder(row.telegram_message_id) : true;
  // The cascade would take the names; saying so outright means the promise
  // does not rest on a pragma.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM preorder_interest WHERE preorder_id = ?').bind(id),
    env.DB.prepare('DELETE FROM preorders WHERE id = ?').bind(id),
  ]);
  await deleteCover(row.image_key);

  const back = new URLSearchParams({ deleted: row.title });
  if (!unposted) back.set('orphan', '1');
  return new Response(null, { status: 302, headers: { Location: `/admin/preorders?${back}` } });
};
