import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { readForm } from '../../../../lib/request-body';
import { plainTextToHtml } from '../../../../lib/format';
import { canonicalPublisher } from '../../../../lib/db';
import { validIsbn, normaliseIsbn } from '../../../../lib/isbn-search';
import {
  storeCover,
  deleteCover,
  publishPreorder,
  syncPreorderPost,
  type PreorderStatus,
} from '../../../../lib/preorders';

export const prerender = false;

const STATUSES: PreorderStatus[] = ['draft', 'open', 'closed'];

/**
 * Saves a pre-order - new or existing - with its cover, and posts it to the
 * channel when the owner ticked the box.
 *
 * One form and one request for all of it, cover included, so a new pre-order
 * can be written, photographed and announced without saving halfway to unlock
 * the rest of the page.
 *
 * POST only, like every route that writes to the channel: see the note at the
 * top of `lib/publish.ts`.
 */
export const POST: APIRoute = async ({ request, url }) => {
  const form = await readForm(request);
  if (!form) return new Response('Bad request', { status: 400 });

  const idRaw = String(form.get('id') ?? '').trim();
  const id = idRaw ? Number.parseInt(idRaw, 10) : null;
  if (idRaw && !Number.isInteger(id)) return new Response('Bad request', { status: 400 });

  const back = (query: string) =>
    new Response(null, {
      status: 302,
      headers: { Location: `/admin/preorders/${id ?? 'new'}?${query}` },
    });

  const text = (name: string, max: number) =>
    String(form.get(name) ?? '').trim().slice(0, max) || null;

  const title = text('title', 200);
  if (!title) return back('e=title');

  // Refused rather than corrected, for the reason the listing form gives: a
  // wrong ISBN is worse than none.
  const isbnRaw = String(form.get('isbn') ?? '').trim();
  const isbn = isbnRaw ? (validIsbn(isbnRaw) ? normaliseIsbn(isbnRaw) : null) : null;
  if (isbnRaw && !isbn) return back('e=isbn');

  /*
   * Blank is "not known yet", and is stored as NULL rather than nought - the
   * page says "price to be confirmed" for one and would say £0.00 for the
   * other, which reads as free.
   */
  const priceRaw = String(form.get('price') ?? '').trim().replace(/^£/, '');
  const priceNumber = Number(priceRaw);
  if (priceRaw && (!Number.isFinite(priceNumber) || priceNumber < 0)) return back('e=price');
  const pricePence = priceRaw ? Math.round(priceNumber * 100) : null;

  const volumesRaw = Math.round(Number(form.get('volumes')) || 0);
  const volumes = volumesRaw > 1 ? Math.min(volumesRaw, 200) : null;

  const statusRaw = String(form.get('status') ?? 'draft') as PreorderStatus;
  const status = STATUSES.includes(statusRaw) ? statusRaw : 'draft';

  const fields = [
    title,
    text('title_ar', 200),
    text('title_ur', 200),
    text('author', 160),
    await canonicalPublisher(text('publisher', 160), null),
    volumes,
    isbn,
    plainTextToHtml(String(form.get('description') ?? '').slice(0, 6000)),
    pricePence,
    status,
  ];

  let preorderId: number;
  if (id === null) {
    const row = await env.DB.prepare(
      `INSERT INTO preorders
         (title, title_ar, title_ur, author, publisher, volumes, isbn, description_html,
          price_pence, status, closed_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
               CASE WHEN ?10 = 'closed' THEN unixepoch() END)
       RETURNING id`,
    )
      .bind(...fields)
      .first<{ id: number }>();
    if (!row) return new Response('Could not save', { status: 500 });
    preorderId = row.id;
  } else {
    /*
     * `closed_at` is when it closed, kept while it stays closed and cleared if
     * it reopens - it is what the ninety-day clock on the names runs from, and
     * restamping it on every save would keep that clock from ever running out.
     */
    const done = await env.DB.prepare(
      `UPDATE preorders SET
         title = ?1, title_ar = ?2, title_ur = ?3, author = ?4, publisher = ?5, volumes = ?6,
         isbn = ?7, description_html = ?8, price_pence = ?9, status = ?10,
         closed_at = CASE WHEN ?10 = 'closed' THEN COALESCE(closed_at, unixepoch()) END,
         updated_at = unixepoch()
       WHERE id = ?11`,
    )
      .bind(...fields, id)
      .run();
    if (!done.meta.changes) return new Response('No such pre-order', { status: 404 });
    preorderId = id;
  }

  const to = (query: string) =>
    new Response(null, {
      status: 302,
      headers: { Location: `/admin/preorders/${preorderId}?${query}` },
    });
  const query = new URLSearchParams({ saved: '1' });

  /*
   * The cover, after the row exists so a new pre-order has an id to file it
   * under. The old one is removed from the bucket only once the new one is
   * written to the row - the other way round, a failed write would leave the
   * pre-order pointing at a photo that has gone.
   */
  const previous = await env.DB.prepare('SELECT image_key FROM preorders WHERE id = ?')
    .bind(preorderId)
    .first<{ image_key: string | null }>();
  const cover = await storeCover(preorderId, form);
  if (cover?.ok) {
    await env.DB.prepare(
      'UPDATE preorders SET image_key = ?, image_width = ?, image_height = ? WHERE id = ?',
    )
      .bind(cover.key, cover.width, cover.height, preorderId)
      .run();
    await deleteCover(previous?.image_key ?? null);
  } else if (cover && !cover.ok) {
    query.set('photo', cover.why);
  } else if (form.get('remove_cover') === '1' && previous?.image_key) {
    await env.DB.prepare(
      'UPDATE preorders SET image_key = NULL, image_width = NULL, image_height = NULL WHERE id = ?',
    )
      .bind(preorderId)
      .run();
    await deleteCover(previous.image_key);
  }

  if (form.get('post_telegram') === '1') {
    query.set('tg', await publishPreorder(preorderId, url.origin));
  } else {
    await syncPreorderPost(preorderId, url.origin);
  }

  return to(query.toString());
};
