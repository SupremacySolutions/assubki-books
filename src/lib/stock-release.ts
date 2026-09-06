import { env } from 'cloudflare:workers';

export const UNPAID = "o.status IN ('requested','awaiting_payment')";
export const HOLD_DUE =
  "o.status='requested' AND o.expires_at IS NOT NULL AND o.expires_at<=unixepoch()";
export const RESERVATION_DUE = `${UNPAID} AND o.pay_by IS NOT NULL AND o.pay_by<=unixepoch()
  AND NOT EXISTS (SELECT 1 FROM order_items x WHERE x.order_id=o.id AND x.from_incoming=1)
  AND NOT EXISTS (SELECT 1 FROM shipment_notices n WHERE n.order_id=o.id AND n.sent_at IS NULL)`;

/**
 * Eligibility is checked by every statement inside the caller's transaction.
 * The status change must be LAST in that same batch. This makes cancellation,
 * payment and expiry mutually exclusive even when their earlier reads race.
 */
export function releaseOrders(
  ids: number[],
  reason: string,
  db: D1Database = env.DB,
  guard = UNPAID,
) {
  const eligible = `SELECT o.id FROM orders o WHERE o.id IN (SELECT value FROM json_each(?1)) AND (${guard})`;
  const lines = `SELECT oi.* FROM order_items oi WHERE oi.order_id IN (${eligible})`;
  const bind = (query: string) => db.prepare(query).bind(JSON.stringify(ids), reason);
  return [
    bind(`UPDATE books SET reserved=reserved-COALESCE((SELECT SUM(qty) FROM (${lines}) i
      WHERE i.book_id=books.id AND i.from_incoming=0),0)
      WHERE id IN (SELECT book_id FROM (${lines}) WHERE from_incoming=0) AND ?2 IS NOT NULL`),
    bind(`INSERT INTO stock_ledger(book_id,delta,field,reason,order_id)
      SELECT book_id,-SUM(qty),'reserved',?2,order_id FROM (${lines})
      WHERE book_id IS NOT NULL AND from_incoming=0 GROUP BY book_id,order_id`),
    bind(`UPDATE books SET reserved_incoming=reserved_incoming-COALESCE((SELECT SUM(qty) FROM (${lines}) i
      WHERE i.book_id=books.id AND i.from_incoming=1),0)
      WHERE id IN (SELECT book_id FROM (${lines}) WHERE from_incoming=1) AND ?2 IS NOT NULL`),
  ];
}

export function releaseHold(
  orderId: number,
  reason: string,
  db: D1Database = env.DB,
  guard = UNPAID,
) {
  return releaseOrders([orderId], reason, db, guard);
}

/** One bounded, atomic sweep; future runs pick up the next page. */
export async function expireOrders(
  db: D1Database,
  reservation = false,
): Promise<{ orders: number; copies: number }> {
  const guard = reservation ? RESERVATION_DUE : HOLD_DUE;
  const { results } = await db
    .prepare(`SELECT o.id FROM orders o WHERE ${guard} ORDER BY o.id LIMIT 100`)
    .all<{ id: number }>();
  if (!results.length) return { orders: 0, copies: 0 };
  const ids = results.map((r) => r.id);
  const done = await db.batch([
    ...releaseOrders(ids, reservation ? 'reservation not paid' : 'hold expired', db, guard),
    db
      .prepare(
        `UPDATE orders SET status='expired',updated_at=unixepoch()
      WHERE orders.id IN (SELECT value FROM json_each(?)) AND (${guard.replaceAll('o.', 'orders.')}) RETURNING id,
      (SELECT COALESCE(SUM(qty),0) FROM order_items WHERE order_id=orders.id) AS copies`,
      )
      .bind(JSON.stringify(ids)),
  ]);
  const expired = done[3].results as { id: number; copies: number }[];
  return { orders: expired.length, copies: expired.reduce((n, r) => n + r.copies, 0) };
}
