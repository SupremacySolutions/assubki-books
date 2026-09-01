import { env } from 'cloudflare:workers';

/**
 * Putting an order's copies back on the shelf.
 *
 * This pair of statements was written out four times - the owner cancelling,
 * the inline expiry sweep, the cron expiry Worker, and deleting an order -
 * differing only in the reason recorded. Customer cancellation would have been
 * the fifth. Four copies of an invariant is four places for it to drift.
 *
 * Two things it must always do together: put the count back, and say why in
 * the ledger. `books.reserved` is asserted against `SUM(delta)` for every
 * book, so a release that moves one without the other breaks an invariant the
 * suite checks.
 *
 * `MAX(0, ...)` because a hold released twice must never drive `reserved`
 * negative and trip `CHECK (reserved >= 0)`. Note the guard protects the
 * column, not the ledger: callers are responsible for not releasing twice, and
 * every one of them gates on the order's status first.
 *
 * Lines claiming a copy from a delivery come off `reserved_incoming` instead,
 * because that is the number they were ever counted against.
 *
 * Takes the database rather than reaching for it, so the cron Worker - which
 * is a separate entrypoint with its own binding - runs the same code as the
 * site instead of its own copy of it.
 */
export function releaseHold(orderId: number, reason: string, db: D1Database = env.DB) {
  return [
    db.prepare(
      `UPDATE books SET reserved = MAX(0, reserved - COALESCE(
         (SELECT SUM(qty) FROM order_items
           WHERE order_id = ?1 AND book_id = books.id AND from_incoming = 0), 0))
        WHERE id IN (SELECT book_id FROM order_items
                      WHERE order_id = ?1 AND book_id IS NOT NULL AND from_incoming = 0)`,
    ).bind(orderId),

    db.prepare(
      `INSERT INTO stock_ledger (book_id, delta, field, reason, order_id)
       SELECT book_id, -SUM(qty), 'reserved', ?2, ?1
         FROM order_items
        WHERE order_id = ?1 AND book_id IS NOT NULL AND from_incoming = 0
        GROUP BY book_id`,
    ).bind(orderId, reason),

    /*
     * Claims on a delivery. No ledger row: `stock_ledger.field` is
     * `CHECK (field IN ('stock','reserved'))` and a claim moved neither - the
     * copies are not in the shop yet. It is recorded on the order itself,
     * which is where anyone asking "who claimed one?" would look.
     */
    db.prepare(
      `UPDATE books SET reserved_incoming = MAX(0, reserved_incoming - COALESCE(
         (SELECT SUM(qty) FROM order_items
           WHERE order_id = ?1 AND book_id = books.id AND from_incoming = 1), 0))
        WHERE id IN (SELECT book_id FROM order_items
                      WHERE order_id = ?1 AND book_id IS NOT NULL AND from_incoming = 1)`,
    ).bind(orderId),
  ];
}
