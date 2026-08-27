/**
 * Releases stock from order requests the owner never acted on.
 *
 * A request holds its copies for 48 hours so payment can be arranged over
 * Telegram without someone else taking the same book. If nothing happens in
 * that window the hold has to lapse, or a browsing customer who abandons a
 * basket quietly takes the last copy off sale forever.
 *
 * This mirrors expireStaleHolds() in src/lib/orders.ts, which the order API
 * also calls inline — whether a customer can buy the last copy must not depend
 * on when this job last fired. This Worker is the safety net that keeps the
 * catalogue's *displayed* availability honest between orders.
 */

interface Env {
  DB: D1Database;
}

export async function expireHolds(db: D1Database): Promise<{ orders: number; copies: number }> {
  const now = Math.floor(Date.now() / 1000);

  const { results: stale } = await db
    .prepare(
      `SELECT o.id, COALESCE(SUM(oi.qty), 0) AS copies
         FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id
        WHERE o.status = 'requested' AND o.expires_at IS NOT NULL AND o.expires_at <= ?
        GROUP BY o.id`,
    )
    .bind(now)
    .all<{ id: number; copies: number }>();

  if (!stale.length) return { orders: 0, copies: 0 };

  const statements = [];
  for (const { id } of stale) {
    statements.push(
      // MAX(0, …) so a hold released twice can never drive reserved negative
      // and trip the CHECK constraint.
      db.prepare(
        `UPDATE books SET reserved = MAX(0, reserved - COALESCE(
           (SELECT SUM(qty) FROM order_items WHERE order_id = ?1 AND book_id = books.id), 0))
          WHERE id IN (SELECT book_id FROM order_items WHERE order_id = ?1 AND book_id IS NOT NULL)`,
      ).bind(id),
      db.prepare(
        `INSERT INTO stock_ledger (book_id, delta, field, reason, order_id)
         SELECT book_id, -SUM(qty), 'reserved', 'hold expired', ?1
           FROM order_items WHERE order_id = ?1 AND book_id IS NOT NULL GROUP BY book_id`,
      ).bind(id),
      db.prepare(`UPDATE orders SET status = 'expired', updated_at = unixepoch() WHERE id = ?`).bind(id),
    );
  }

  await db.batch(statements);

  return { orders: stale.length, copies: stale.reduce((n, s) => n + s.copies, 0) };
}

export default {
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const { orders, copies } = await expireHolds(env.DB);
    if (orders) console.log(`expired ${orders} hold(s), released ${copies} cop(ies)`);
  },

  // Manual trigger for testing: `wrangler dev` then curl the worker.
  async fetch(_request: Request, env: Env): Promise<Response> {
    const result = await expireHolds(env.DB);
    return Response.json(result);
  },
} satisfies ExportedHandler<Env>;
