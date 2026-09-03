import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { setStock } from '../../../../../lib/admin-db';
import { forgetHomeRows } from '../../../../../lib/db';
import { tellWaiting } from '../../../../../lib/stock-alerts';

export const prerender = false;

/**
 * A delivery has come in.
 *
 * Turns copies that were only promised into copies on the shelf, and converts
 * the claims against them into ordinary holds, oldest claim first.
 *
 * **If fewer arrive than were claimed, the overflow stays reserved and waits
 * for the next delivery.** It is never silently cancelled - somebody was told
 * they had a copy, and the shop does not get to quietly take that back because
 * a box was short. Those claims keep their place at the front of the queue.
 */
export const POST: APIRoute = async ({ params, request }) => {
  const bookId = Number.parseInt(params.id ?? '', 10);
  if (!Number.isInteger(bookId)) return new Response('Bad request', { status: 400 });

  const form = await request.formData();
  const arrived = Math.max(0, Math.min(999, Math.round(Number(form.get('arrived')) || 0)));
  const back = new Response(null, {
    status: 302,
    headers: { Location: `/admin/books/${bookId}?arrived=1` },
  });
  if (arrived === 0) return back;

  const book = await env.DB.prepare(
    'SELECT id, stock, incoming, reserved_incoming FROM books WHERE id = ?',
  )
    .bind(bookId)
    .first<{ id: number; stock: number; incoming: number; reserved_incoming: number }>();
  if (!book) return new Response('No such listing', { status: 404 });

  // Claims in the order they were made. First promised, first served.
  const { results: claims } = await env.DB.prepare(
    `SELECT oi.id, oi.order_id, oi.qty
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE oi.book_id = ? AND oi.from_incoming = 1
        AND o.status NOT IN ('cancelled', 'expired')
      ORDER BY o.created_at, oi.id`,
  )
    .bind(bookId)
    .all<{ id: number; order_id: number; qty: number }>();

  const statements = [];
  let left = arrived;
  let converted = 0;

  for (const claim of claims) {
    if (left < claim.qty) break; // and everything after it keeps waiting
    left -= claim.qty;
    converted += claim.qty;
    statements.push(
      // The claim becomes an ordinary hold on a copy that now exists.
      env.DB.prepare('UPDATE order_items SET from_incoming = 0 WHERE id = ?').bind(claim.id),
      env.DB.prepare('UPDATE books SET reserved = reserved + ? WHERE id = ?').bind(claim.qty, bookId),
      env.DB.prepare(
        `INSERT INTO stock_ledger (book_id, delta, field, reason, order_id)
         VALUES (?, ?, 'reserved', 'reservation filled', ?)`,
      ).bind(bookId, claim.qty, claim.order_id),
    );
  }

  /*
   * Stock first, then the holds against it: `CHECK (reserved <= stock)` means a
   * hold added before its copy exists would abort the batch.
   */
  await setStock(bookId, book.stock + arrived, 'delivery arrived');
  if (statements.length) await env.DB.batch(statements);

  // What is left coming, and what is still claimed against it.
  await env.DB.prepare(
    `UPDATE books
        SET incoming = MAX(0, incoming - ?),
            reserved_incoming = MAX(0, reserved_incoming - ?),
            updated_at = unixepoch()
      WHERE id = ?`,
  )
    .bind(arrived, converted, bookId)
    .run();

  // A landed delivery is exactly what takes a book out of the arriving row.
  forgetHomeRows();

  /*
   * Anybody who asked to be told is told now, at the end, when availability
   * has settled - a delivery raises stock and then hands copies to the people
   * who reserved them, so a check half way through would announce copies that
   * were already spoken for.
   */
  await tellWaiting(bookId, new URL(request.url).origin);

  return back;
};
