import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { forgetCategoryCounts, forgetHomeRows } from '../../../../../lib/db';

export const prerender = false;

/** The address a shipment import gives a row, and the only one worth replacing. */
const IMPORTED_SLUG = /^sh\d+-\d+$/;

function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70)
    .replace(/-+$/, '');
}

async function uniqueSlug(base: string, excludeId: number): Promise<string> {
  const start = base || 'listing';
  for (let n = 1; n < 60; n++) {
    const candidate = n === 1 ? start : `${start}-${n}`;
    const taken = await env.DB.prepare('SELECT id FROM books WHERE slug = ? AND id != ?')
      .bind(candidate, excludeId)
      .first();
    if (!taken) return candidate;
  }
  return `${start}-${Date.now()}`;
}

/**
 * A shipment's leftovers, made into an ordinary listing.
 *
 * Not a status flip. Three things have to happen together and the third is the
 * reason this is a route of its own:
 *
 *   1. It needs an English title. The shipment carried the book's own name in
 *      Arabic or Urdu, which is right for a list somebody is reading in that
 *      script and wrong for a shop front and a web address.
 *   2. It leaves the shipment. `shipment_id` is what keeps a row out of the
 *      Listings page and off `/book`, so clearing it is what lets the listing
 *      exist - and it is also what stops the arrival logic touching it again.
 *   3. **It is re-slugged**, which nothing else in this codebase does. A slug
 *      is fixed at insert on purpose: Telegram has posted `/book/<slug>` links
 *      and a changed address breaks them. The exception is narrow and checked
 *      rather than assumed - only a slug still matching the shape the importer
 *      assigns. Such a row has never been publicly reachable, so nothing
 *      anywhere points at the old address.
 */
export const POST: APIRoute = async ({ params, request }) => {
  const shipmentId = Number.parseInt(params.id ?? '', 10);
  const form = await request.formData();
  const bookId = Number.parseInt(String(form.get('book') ?? ''), 10);
  const title = String(form.get('title') ?? '').trim().slice(0, 200);

  if (!Number.isInteger(shipmentId) || !Number.isInteger(bookId)) {
    return new Response('Bad request', { status: 400 });
  }

  const back = (query: string) =>
    new Response(null, {
      status: 302,
      headers: { Location: `/admin/shipments/${shipmentId}${query}` },
    });

  if (!title) return back('?e=' + encodeURIComponent('give it an English title first'));

  const book = await env.DB.prepare(
    'SELECT id, slug, stock, reserved FROM books WHERE id = ? AND shipment_id = ?',
  )
    .bind(bookId, shipmentId)
    .first<{ id: number; slug: string; stock: number; reserved: number }>();
  if (!book) return new Response('No such book on this shipment', { status: 404 });

  if (book.stock - book.reserved <= 0) {
    return back('?e=' + encodeURIComponent('every copy of that is spoken for, so there is nothing to list'));
  }

  const slug = IMPORTED_SLUG.test(book.slug)
    ? await uniqueSlug(slugify(title), book.id)
    : book.slug;

  await env.DB.prepare(
    `UPDATE books
        SET title = ?, slug = ?, status = 'live', shipment_id = NULL,
            updated_at = unixepoch()
      WHERE id = ? AND shipment_id = ?`,
  )
    .bind(title, slug, bookId, shipmentId)
    .run();

  forgetCategoryCounts();
  forgetHomeRows();

  return back('?listed=' + encodeURIComponent(title));
};
