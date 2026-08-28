import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { setStock } from '../../../../lib/admin-db';
import { publishListing, publishQuery } from '../../../../lib/publish';

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

export const POST: APIRoute = async ({ request, url }) => {
  const form = await request.formData();

  const idRaw = String(form.get('id') ?? '').trim();
  const id = idRaw ? Number.parseInt(idRaw, 10) : null;

  const title = String(form.get('title') ?? '').trim();
  const titleAr = String(form.get('title_ar') ?? '').trim() || null;
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
      `UPDATE books SET title = ?, title_ar = ?, description_html = ?, price_pence = ?,
                        status = ?, updated_at = unixepoch()
        WHERE id = ?`,
    )
      .bind(title, titleAr, description, pricePence, status, bookId)
      .run();
    await setStock(bookId, stock, 'edited in portal');
  } else {
    const slug = await uniqueSlug(slugify(title), null);
    const created = await env.DB.prepare(
      `INSERT INTO books (slug, title, title_ar, description_html, price_pence, stock, reserved, status)
       VALUES (?,?,?,?,?,?,0,?) RETURNING id`,
    )
      .bind(slug, title, titleAr, description, pricePence, stock, status)
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

  // "Save and post" calls the publisher directly. Redirecting to the posting
  // endpoint instead would turn this POST into a GET, and that endpoint changes
  // state — see src/lib/publish.ts.
  if (form.get('publish_telegram') === '1') {
    const result = await publishListing(bookId!, url.origin);
    return new Response(null, {
      status: 302,
      headers: { Location: `/admin/books/${bookId}?saved=1&posted=${publishQuery(result)}` },
    });
  }

  return new Response(null, {
    status: 302,
    headers: { Location: `/admin/books/${bookId}?saved=1` },
  });
};
