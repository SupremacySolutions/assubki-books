import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { setStock } from '../../../../lib/admin-db';
import { forgetCategoryCounts, forgetHomeRows } from '../../../../lib/db';
import { tellWaiting } from '../../../../lib/stock-alerts';
import { validIsbn, normaliseIsbn } from '../../../../lib/isbn-search';

export const prerender = false;

/** Plain text from the owner → the same safe HTML subset the importer produces. */
function toHtml(text: string): string | null {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (!clean) return null;
  const escape = (s: string) =>
    s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
  return clean
    .split(/\n{2,}/)
    .map((para) => `<p>${escape(para).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function slugify(str: string): string {
  return str
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[؀-ۿݐ-ݿﭐ-﻿]/g, '')
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70)
    .replace(/-+$/, '');
}

async function uniqueSlug(base: string, excludeId: number | null): Promise<string> {
  let candidate = base || 'listing';
  for (let n = 1; n < 60; n++) {
    const clash = await env.DB.prepare(
      'SELECT id FROM books WHERE slug = ? AND (?2 IS NULL OR id != ?2)',
    )
      .bind(candidate, excludeId)
      .first<{ id: number }>();
    if (!clash) return candidate;
    candidate = `${base}-${n + 1}`;
  }
  return `${base}-${Date.now()}`;
}

export const POST: APIRoute = async ({ request }) => {
  const form = await request.formData();

  const idRaw = String(form.get('id') ?? '').trim();
  const id = idRaw ? Number.parseInt(idRaw, 10) : null;

  const title = String(form.get('title') ?? '').trim();
  const titleAr = String(form.get('title_ar') ?? '').trim() || null;
  const author = String(form.get('author') ?? '').trim() || null;
  const publisher = String(form.get('publisher') ?? '').trim() || null;
  /*
   * Refused rather than corrected if it is not a real ISBN.
   *
   * A mistyped number is worse than an empty field: it matches the listing to
   * a different book in Google Shopping, where the shop's price then looks
   * wrong against somebody else's edition.
   */
  const isbnRaw = String(form.get('isbn') ?? '').trim();
  const isbn = isbnRaw ? (validIsbn(isbnRaw) ? normaliseIsbn(isbnRaw) : null) : null;
  if (isbnRaw && !isbn) {
    return new Response(null, {
      status: 302,
      headers: { Location: `/admin/books/${id ?? 'new'}?e=isbn` },
    });
  }
  // Null, not 1: "nobody has said" and "one volume" are different, and only
  // the first should leave the card silent.
  const volumesRaw = Math.round(Number(form.get('volumes')) || 0);
  const volumes = volumesRaw > 1 ? Math.min(volumesRaw, 200) : null;
  const description = toHtml(String(form.get('description') ?? ''));
  const pricePence = Math.max(0, Math.round((Number(form.get('price')) || 0) * 100));
  const stock = Math.max(0, Math.round(Number(form.get('stock')) || 0));
  const statusRaw = String(form.get('status') ?? 'live');
  const status = ['live', 'draft', 'archived'].includes(statusRaw) ? statusRaw : 'live';
  const categoryIds = form
    .getAll('categories')
    .map((v) => Number.parseInt(String(v), 10))
    .filter((n) => Number.isInteger(n));

  if (!title) return new Response('A title is required', { status: 400 });

  let bookId = id;

  if (bookId) {
    // Stock goes through setStock so the change is written to the ledger, and
    // so it cannot be dropped below what open orders have already promised.
    await env.DB.prepare(
      `UPDATE books SET title = ?, title_ar = ?, author = ?, publisher = ?, volumes = ?,
                        description_html = ?, price_pence = ?, status = ?, isbn = ?,
                        updated_at = unixepoch()
        WHERE id = ?`,
    )
      .bind(title, titleAr, author, publisher, volumes, description, pricePence, status, isbn, bookId)
      .run();
    await setStock(bookId, stock, 'edited in portal');
    /* Anybody waiting is told once availability has settled - see stock-alerts. */
    await tellWaiting(bookId, new URL(request.url).origin);

  /*
   * The delivery. Floored at what customers have already claimed, the same way
   * stock is floored at what is reserved - lowering it below that would strand
   * people holding a promise the shop has withdrawn.
   */
  // The tick decides. Clearing it is how a delivery is cancelled - there was no
  // other way to say "this is not coming after all" except typing a zero.
  const hasIncoming = form.get('has_incoming') !== null;
  const incomingWanted = hasIncoming
    ? Math.max(0, Math.min(999, Math.round(Number(form.get('incoming')) || 0)))
    : 0;
  const vague = String(form.get('incoming_vague') ?? 'mid').trim() || 'mid';
  const month = String(form.get('incoming_month') ?? '').trim() || null;
  await env.DB.prepare(
    `UPDATE books
        SET incoming = MAX(?, reserved_incoming),
            incoming_vague = ?, incoming_month = ?, updated_at = unixepoch()
      WHERE id = ?`,
  )
    .bind(incomingWanted, vague, month, bookId)
    .run();
  } else {
    const slug = await uniqueSlug(slugify(title), null);
    const created = await env.DB.prepare(
      `INSERT INTO books (slug, title, title_ar, author, publisher, volumes, description_html,
                          price_pence, stock, reserved, status, isbn)
       VALUES (?,?,?,?,?,?,?,?,?,0,?,?) RETURNING id`,
    )
      .bind(slug, title, titleAr, author, publisher, volumes, description, pricePence, stock, status, isbn)
      .first<{ id: number }>();
    bookId = created!.id;

    await env.DB.prepare(
      `INSERT INTO stock_ledger (book_id, delta, field, reason) VALUES (?, ?, 'stock', 'listing created')`,
    )
      .bind(bookId, stock)
      .run();
  }

  await env.DB.prepare('DELETE FROM book_categories WHERE book_id = ?').bind(bookId).run();
  if (categoryIds.length) {
    await env.DB.batch(
      categoryIds.map((cid) =>
        env.DB.prepare(
          'INSERT OR IGNORE INTO book_categories (book_id, category_id) VALUES (?, ?)',
        ).bind(bookId, cid),
      ),
    );
  }

  // The shelf counts are cached for a minute; the owner should see their own
  // change now rather than in a minute.
  forgetCategoryCounts();
  forgetHomeRows();

  return new Response(null, {
    status: 302,
    headers: { Location: `/admin/books/${bookId}?saved=1` },
  });
};
