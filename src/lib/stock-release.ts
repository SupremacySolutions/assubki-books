import { env } from 'cloudflare:workers';

export const UNPAID = "o.status IN ('requested','awaiting_payment')";

/**
 * A shelf hold whose forty-eight hours have run out and which nobody has been
 * told about yet.
 *
 * `lapsed_at IS NULL` is what makes the flagging idempotent: the sweep runs
 * every quarter of an hour, and without it every run would re-stamp the same
 * orders and the portal could not tell a hold that lapsed a minute ago from one
 * the owner has been sitting on for a week.
 *
 * `status='requested'` is load-bearing for a second reason beyond "still
 * waiting". `confirm.ts` does not clear `expires_at`, so every order in
 * awaiting_payment still carries the stale forty-eight hour value it was
 * created with, long in the past - matching on the date alone would flag every
 * confirmed order in the shop the first time this ran.
 */
export const HOLD_LAPSED =
  `o.status='requested' AND o.expires_at IS NOT NULL
   AND o.expires_at<=unixepoch() AND o.lapsed_at IS NULL`;
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

/**
 * Marks the shelf holds that have run out, and does nothing else to them.
 *
 * This used to cancel them: release the copies, set `status='expired'`, done.
 * It stopped being the right answer once an order carried a conversation. The
 * order that made the case was amended by the owner at 15:13 and swept away at
 * 16:00 - thirty-two minutes later - with an open thread on it. The sweep was
 * working exactly as written; what it could not see was that somebody was in
 * the middle of dealing with it.
 *
 * So the deadline still passes and the owner is still told, but the decision is
 * theirs. The order keeps its status, its lines, its messages **and its held
 * copies** until a person confirms it, extends it, or cancels it.
 *
 * That last part is the cost, and it is deliberate: copies on a lapsed order
 * stay off the shelf. The portal has to say so loudly enough that an ignored
 * order is an obvious thing rather than a quiet one, which is what
 * `lapsedOrders` and the banner on the order page are for.
 *
 * Reservations are untouched by this and still expire on their own - see
 * `expireOrders` below. Their deadline is a promise to the next person in the
 * queue for a book that has just landed, not a guess at how long the owner
 * needs to answer an email.
 */
export async function flagLapsedHolds(db: D1Database): Promise<number> {
  const { results } = await db
    .prepare(
      `UPDATE orders SET lapsed_at=unixepoch(), updated_at=unixepoch()
        WHERE id IN (SELECT o.id FROM orders o WHERE ${HOLD_LAPSED} ORDER BY o.id LIMIT 100)
        RETURNING id`,
    )
    .all<{ id: number }>();
  return results.length;
}

/**
 * One bounded, atomic sweep; future runs pick up the next page.
 *
 * Reservations only. It took a `reservation` flag while shelf holds ended the
 * same way, and the flag is gone rather than defaulted: the false branch would
 * have been "expire every unpaid order", with the deadline check living in the
 * caller's choice of guard rather than in the query. That is a footgun aimed at
 * the whole order table, and there is no longer any caller who wants it.
 */
export async function expireOrders(
  db: D1Database,
): Promise<{ orders: number; copies: number }> {
  const guard = RESERVATION_DUE;
  const { results } = await db
    .prepare(`SELECT o.id FROM orders o WHERE ${guard} ORDER BY o.id LIMIT 100`)
    .all<{ id: number }>();
  if (!results.length) return { orders: 0, copies: 0 };
  const ids = results.map((r) => r.id);
  const done = await db.batch([
    ...releaseOrders(ids, 'reservation not paid', db, guard),
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
