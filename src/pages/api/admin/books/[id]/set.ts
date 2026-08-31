import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { forgetCategoryCounts } from '../../../../../lib/db';

export const prerender = false;

/**
 * Turns one listing into a set that can also be bought in parts.
 *
 * Each part becomes an **ordinary listing** of its own, linked to the same
 * pool. That is the whole design decision: holds, the ledger, cancellation and
 * the 48-hour expiry sweep keep working untouched, because there is no new
 * kind of thing for them to understand. Only availability is read differently,
 * and only the sale has to reach the pool.
 *
 * The shelf count is per volume rather than a single "sets in stock". Selling
 * volumes 1-2 out of three sets leaves two complete sets and three of volumes
 * 3-4, and no single number says both.
 */

/** "Volumes 1-2, 1-2, 17.00" - a name, the volumes it covers, and a price. */
function parsePart(line: string, volumes: number) {
  const [name, range, price] = line.split(',').map((p) => p.trim());
  if (!name || !range || !price) return null;

  const m = /^(\d+)\s*(?:-\s*(\d+))?$/.exec(range);
  if (!m) return null;
  const from = Number.parseInt(m[1], 10);
  const to = m[2] ? Number.parseInt(m[2], 10) : from;

  // Refused rather than clamped: a part that runs past the end of the set, or
  // backwards, is a typo, and quietly correcting it would put a listing on the
  // shop front that nobody meant.
  if (!(from >= 1 && to >= from && to <= volumes)) return null;

  const pence = Math.round(Number(price.replace(/[^0-9.]/g, '')) * 100);
  if (!Number.isFinite(pence) || pence < 0) return null;

  return { name: name.slice(0, 200), from, to, pence };
}

const slugify = (text: string) =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

export const POST: APIRoute = async ({ params, request }) => {
  const id = Number.parseInt(params.id ?? '', 10);
  if (!Number.isInteger(id)) return new Response('Bad request', { status: 400 });

  const book = await env.DB.prepare(
    'SELECT id, slug, title, status, set_id FROM books WHERE id = ?',
  )
    .bind(id)
    .first<{ id: number; slug: string; title: string; status: string; set_id: number | null }>();
  if (!book) return new Response('No such listing', { status: 404 });

  const form = await request.formData();
  const action = String(form.get('action') ?? '');
  const back = `/admin/books/${id}`;
  const fail = (why: string) =>
    new Response(null, { status: 302, headers: { Location: `${back}?e=${why}` } });

  // ------------------------------------------------------------------ restock
  if (action === 'restock') {
    if (!book.set_id) return fail('notaset');
    const sets = Math.max(0, Math.min(999, Math.round(Number(form.get('sets')) || 0)));
    await env.DB.prepare('UPDATE book_set_stock SET have = ? WHERE set_id = ?')
      .bind(sets, book.set_id)
      .run();
    forgetCategoryCounts();
    return new Response(null, { status: 302, headers: { Location: `${back}?saved=1` } });
  }

  // ------------------------------------------------------------------- create
  if (action !== 'create') return fail('badaction');
  if (book.set_id) return fail('alreadyset');

  const volumes = Math.round(Number(form.get('volumes')) || 0);
  if (!(volumes >= 2 && volumes <= 200)) return fail('volumes');
  const sets = Math.max(0, Math.min(999, Math.round(Number(form.get('sets')) || 0)));

  const lines = String(form.get('parts') ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const parts = lines.map((l) => parsePart(l, volumes));
  if (parts.length === 0 || parts.some((p) => p === null)) return fail('parts');

  const created = await env.DB.prepare(
    'INSERT INTO book_sets (name, volumes) VALUES (?, ?) RETURNING id',
  )
    .bind(book.title.slice(0, 200), volumes)
    .first<{ id: number }>();
  const setId = created!.id;

  const statements = [];
  for (let v = 1; v <= volumes; v++) {
    statements.push(
      env.DB.prepare('INSERT INTO book_set_stock (set_id, volume, have) VALUES (?, ?, ?)')
        .bind(setId, v, sets),
    );
  }

  // This listing becomes the complete set - it already has the cover, the
  // description and any channel post, and re-creating all that would be worse
  // than reusing it.
  statements.push(
    env.DB.prepare(
      'UPDATE books SET set_id = ?, set_from = 1, set_to = ?, volumes = ?, stock = ? WHERE id = ?',
    ).bind(setId, volumes, volumes, sets, id),
  );

  for (const part of parts) {
    const p = part!;
    /*
     * `stock` is set on each part too, and it is not what decides availability
     * - the pool is. It is here because `books` carries CHECK (reserved <=
     * stock), so a part with no stock could never be held at all. The
     * availability sum ignores it.
     */
    statements.push(
      env.DB.prepare(
        `INSERT INTO books (slug, title, price_pence, stock, reserved, status,
                            set_id, set_from, set_to, volumes)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
      ).bind(
        `${slugify(book.slug)}-${p.from}-${p.to}`.slice(0, 120),
        p.name,
        p.pence,
        sets,
        book.status,
        setId,
        p.from,
        p.to,
        p.to - p.from + 1,
      ),
    );
  }

  await env.DB.batch(statements);
  forgetCategoryCounts();
  return new Response(null, { status: 302, headers: { Location: `${back}?saved=1` } });
};
