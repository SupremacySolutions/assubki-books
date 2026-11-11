import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { readForm } from '../../../../../lib/request-body';
import { forgetHomeRows } from '../../../../../lib/db';
import { forgetDashboard } from '../../../../../lib/dashboard';

export const prerender = false;

/**
 * The order of a listing's photos, as the owner dragged them.
 *
 * The first is the cover: on the shelf, on the book's page, in the sitemap and
 * at the head of the Telegram album. Until now that was whichever photo went up
 * first, and the only way to change it was to delete the others and upload
 * them again.
 *
 * Takes every photo the listing has, in the new order, and numbers them from
 * nought. All of them, not a move of one: the page sends what it shows, so a
 * photo added or removed in another tab since it loaded makes the two lists
 * disagree, and that is refused rather than guessed at. Several checks look
 * for the cover as `sort = 0`, so the numbering is always 0, 1, 2… with no gaps.
 *
 * Saved straight away, like adding or removing a photo - photos are not part of
 * the listing form, so there is nothing for its Save button to carry.
 */
export const POST: APIRoute = async ({ params, request }) => {
  const id = Number.parseInt(params.id ?? '', 10);
  if (!Number.isInteger(id)) return new Response('Bad request', { status: 400 });

  const form = await readForm(request);
  if (!form) return new Response('Bad request', { status: 400 });
  const order = String(form.get('order') ?? '')
    .split(',')
    .map((part) => Number.parseInt(part, 10));
  if (!order.length || order.some((n) => !Number.isInteger(n)) || new Set(order).size !== order.length) {
    return new Response('Bad request', { status: 400 });
  }

  const { results } = await env.DB.prepare('SELECT id FROM book_images WHERE book_id = ?')
    .bind(id)
    .all<{ id: number }>();
  const held = new Set(results.map((r) => r.id));
  if (held.size !== order.length || order.some((n) => !held.has(n))) {
    return Response.json(
      { ok: false, error: 'The photos changed since this page was opened. Reload it and try again.' },
      { status: 409 },
    );
  }

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE book_images
          SET sort = (SELECT CAST(j.key AS INTEGER) FROM json_each(?1) j WHERE j.value = book_images.id)
        WHERE book_id = ?2`,
    ).bind(JSON.stringify(order), id),
    // The channel post is offered for updating when the listing changed after
    // it went out, and a new cover is a change worth posting.
    env.DB.prepare('UPDATE books SET updated_at = unixepoch() WHERE id = ?').bind(id),
  ]);
  forgetHomeRows();
  forgetDashboard();

  return Response.json({ ok: true, cover: order[0] });
};
