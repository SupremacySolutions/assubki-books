/**
 * A delivery landing, for one book.
 *
 * Lifted out of the per-book route so that a whole shipment arriving runs the
 * same code sixty times rather than a second implementation once. The rule
 * that matters is easy to get subtly different, and there should be one of it:
 * copies that were promised become copies on the shelf, and the claims against
 * them become ordinary holds, oldest claim first.
 *
 * **If fewer arrive than were claimed, the overflow stays reserved and waits.**
 * It is never silently cancelled - somebody was told they had a copy, and the
 * shop does not get to quietly take that back because a box was short. Those
 * claims keep their place at the front of the queue for the next delivery.
 */

import { env } from 'cloudflare:workers';
import { setStock } from './admin-db';

export interface Arrival {
  /** How many copies were converted from a promise into a hold. */
  filled: number;
  /** The orders that had a claim filled, for whoever needs to write to them. */
  orderIds: number[];
}

export async function fillClaims(bookId: number, arrived: number): Promise<Arrival> {
  if (arrived <= 0) return { filled: 0, orderIds: [] };

  const book = await env.DB.prepare(
    'SELECT id, stock FROM books WHERE id = ?',
  )
    .bind(bookId)
    .first<{ id: number; stock: number }>();
  if (!book) return { filled: 0, orderIds: [] };

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
  const orderIds: number[] = [];
  let left = arrived;
  let filled = 0;

  for (const claim of claims) {
    if (left < claim.qty) break; // and everything after it keeps waiting
    left -= claim.qty;
    filled += claim.qty;
    orderIds.push(claim.order_id);
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
    .bind(arrived, filled, bookId)
    .run();

  return { filled, orderIds: [...new Set(orderIds)] };
}

/**
 * The seven days, started on the orders this arrival completed.
 *
 * Only on an order with **no unfilled claim left anywhere**. Arrival runs a
 * book at a time, so an order claiming two titles would otherwise start its
 * clock the moment the first one landed, while it is still waiting for the
 * second - and be released for not answering about books it has not been told
 * about yet.
 *
 * `pay_by IS NULL` makes it idempotent: a second arrival does not restart a
 * clock that is already running, and cannot extend one the owner has already
 * given more time.
 */
export async function startPaymentWindow(orderIds: number[], days = 7): Promise<number> {
  if (!orderIds.length) return 0;
  const holes = orderIds.map(() => '?').join(',');
  const done = await env.DB.prepare(
    `UPDATE orders
        SET pay_by = unixepoch() + ? * 86400, updated_at = unixepoch()
      WHERE id IN (${holes})
        AND status IN ('requested', 'awaiting_payment')
        AND pay_by IS NULL
        AND NOT EXISTS (SELECT 1 FROM order_items x
                         WHERE x.order_id = orders.id AND x.from_incoming = 1)`,
  )
    .bind(days, ...orderIds)
    .run();
  return done.meta.changes ?? 0;
}
