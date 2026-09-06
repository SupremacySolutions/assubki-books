import { env } from 'cloudflare:workers';

export interface Arrival {
  filled: number;
  orderIds: number[];
}

/** Actual receipts, independent of how many copies are still expected. */
export interface ReceiptLine {
  bookId: number;
  qty: number;
}
export class ReceiptConflict extends Error {}

/**
 * Receive a whole delivery in one transaction, with a stable form key for
 * retries. SQL allocates partial claims oldest-first, so even one copy of a
 * two-copy reservation is held for its owner. The remaining claim keeps its
 * original place. No request-sized list of SQL parameters or per-book calls.
 */
export async function receiveDelivery(input: {
  key: string;
  version: number;
  shipmentId?: number;
  bookId?: number;
  lines: ReceiptLine[];
}): Promise<Arrival> {
  const db = env.DB;
  const { key, version, shipmentId, bookId, lines } = input;
  const pending = `EXISTS (SELECT 1 FROM deliveries WHERE id = ?1 AND applied_at IS NULL)`;
  const items = JSON.stringify(lines);
  const statements = [
    shipmentId !== undefined
      ? db
          .prepare(
            `INSERT OR IGNORE INTO deliveries(id,shipment_id)
          SELECT ?1,?2 WHERE EXISTS (SELECT 1 FROM shipments
            WHERE id=?2 AND status IN ('open','arrived','closed') AND delivery_version=?3)`,
          )
          .bind(key, shipmentId, version)
      : db
          .prepare(
            `INSERT OR IGNORE INTO deliveries(id,book_id)
          SELECT ?1,?2 WHERE EXISTS (SELECT 1 FROM books
            WHERE id=?2 AND shipment_id IS NULL AND delivery_version=?3)`,
          )
          .bind(key, bookId ?? null, version),
    db
      .prepare(
        `INSERT OR IGNORE INTO delivery_items(delivery_id,book_id,qty)
      SELECT ?1,b.id,json_extract(j.value,'$.qty')
        FROM json_each(?2) j JOIN books b ON b.id=json_extract(j.value,'$.bookId')
        JOIN deliveries d ON d.id=?1
       WHERE ${pending} AND (b.shipment_id=d.shipment_id OR b.id=d.book_id)`,
      )
      .bind(key, items),
    db
      .prepare(
        `INSERT INTO delivery_allocations(delivery_id,item_id,qty,paid)
      SELECT ?1,id,MIN(qty,MAX(0,received-before_qty)),paid FROM (
        SELECT oi.id,oi.qty,di.qty AS received,
          CASE WHEN o.status IN ('paid','dispatched','completed') THEN 1 ELSE 0 END AS paid,
          COALESCE(SUM(oi.qty) OVER (PARTITION BY oi.book_id ORDER BY o.created_at,oi.id
            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS before_qty
        FROM order_items oi JOIN orders o ON o.id=oi.order_id
          JOIN delivery_items di ON di.book_id=oi.book_id AND di.delivery_id=?1
        WHERE oi.from_incoming=1 AND o.status NOT IN ('cancelled','expired') AND ${pending}
      ) WHERE received>before_qty`,
      )
      .bind(key),
    // Set listings share physical volumes. Add those copies before reserving
    // their listing, so the pool guard sees the received stock in this batch.
    db
      .prepare(
        `UPDATE book_set_stock SET have=have+COALESCE((
      SELECT SUM(di.qty-COALESCE((SELECT SUM(a.qty) FROM delivery_allocations a
        JOIN order_items oi ON oi.id=a.item_id
        WHERE a.delivery_id=?1 AND oi.book_id=b.id AND a.paid=1),0))
      FROM delivery_items di JOIN books b ON b.id=di.book_id
      WHERE di.delivery_id=?1 AND b.set_id=book_set_stock.set_id
        AND book_set_stock.volume BETWEEN b.set_from AND b.set_to),0)
      WHERE ${pending} AND set_id IN (SELECT b.set_id FROM delivery_items di
        JOIN books b ON b.id=di.book_id WHERE di.delivery_id=?1)`,
      )
      .bind(key),
    db
      .prepare(
        `UPDATE books SET
        stock=stock+(SELECT qty FROM delivery_items WHERE delivery_id=?1 AND book_id=books.id)
          -COALESCE((SELECT SUM(a.qty) FROM delivery_allocations a JOIN order_items oi ON oi.id=a.item_id
             WHERE a.delivery_id=?1 AND oi.book_id=books.id AND a.paid=1),0),
        reserved=reserved+COALESCE((SELECT SUM(a.qty) FROM delivery_allocations a JOIN order_items oi ON oi.id=a.item_id
             WHERE a.delivery_id=?1 AND oi.book_id=books.id AND a.paid=0),0),
        incoming=MAX(0,incoming-(SELECT qty FROM delivery_items WHERE delivery_id=?1 AND book_id=books.id)),
        reserved_incoming=reserved_incoming-COALESCE((SELECT SUM(a.qty) FROM delivery_allocations a
             JOIN order_items oi ON oi.id=a.item_id WHERE a.delivery_id=?1 AND oi.book_id=books.id),0),
        delivery_version=delivery_version+1,updated_at=unixepoch()
      WHERE id IN (SELECT book_id FROM delivery_items WHERE delivery_id=?1) AND ${pending}`,
      )
      .bind(key),
    db
      .prepare(
        `INSERT INTO stock_ledger(book_id,delta,field,reason)
      SELECT book_id,qty,'stock','delivery arrived' FROM delivery_items
      WHERE delivery_id=?1 AND qty>0 AND ${pending}`,
      )
      .bind(key),
    db
      .prepare(
        `INSERT INTO stock_ledger(book_id,delta,field,reason,order_id)
      SELECT oi.book_id,CASE WHEN a.paid=1 THEN -a.qty ELSE a.qty END,
        CASE WHEN a.paid=1 THEN 'stock' ELSE 'reserved' END,
        CASE WHEN a.paid=1 THEN 'paid reservation filled' ELSE 'reservation filled' END,oi.order_id
      FROM delivery_allocations a JOIN order_items oi ON oi.id=a.item_id
      WHERE a.delivery_id=?1 AND ${pending}`,
      )
      .bind(key),
    // Preserve every price/sale snapshot when a partially filled line splits.
    db
      .prepare(
        `INSERT INTO order_items(order_id,book_id,title_snapshot,price_pence_snapshot,qty,
        from_incoming,sale_id,full_price_pence)
      SELECT oi.order_id,oi.book_id,oi.title_snapshot,oi.price_pence_snapshot,a.qty,0,oi.sale_id,oi.full_price_pence
      FROM delivery_allocations a JOIN order_items oi ON oi.id=a.item_id
      WHERE a.delivery_id=?1 AND a.qty<oi.qty AND ${pending}`,
      )
      .bind(key),
    db
      .prepare(
        `UPDATE order_items SET
        from_incoming=CASE WHEN qty=(SELECT qty FROM delivery_allocations WHERE delivery_id=?1 AND item_id=order_items.id)
          THEN 0 ELSE 1 END,
        qty=CASE WHEN qty>(SELECT qty FROM delivery_allocations WHERE delivery_id=?1 AND item_id=order_items.id)
          THEN qty-(SELECT qty FROM delivery_allocations WHERE delivery_id=?1 AND item_id=order_items.id) ELSE qty END
      WHERE id IN (SELECT item_id FROM delivery_allocations WHERE delivery_id=?1) AND ${pending}`,
      )
      .bind(key),
    db
      .prepare(
        `UPDATE orders SET pay_by=unixepoch()+7*86400,updated_at=unixepoch()
      WHERE id IN (SELECT oi.order_id FROM delivery_allocations a JOIN order_items oi ON oi.id=a.item_id WHERE a.delivery_id=?1)
        AND status IN ('requested','awaiting_payment') AND pay_by IS NULL
        AND NOT EXISTS (SELECT 1 FROM order_items WHERE order_id=orders.id AND from_incoming=1)
        AND ${pending}`,
      )
      .bind(key),
    db
      .prepare(
        `INSERT OR IGNORE INTO shipment_notices(shipment_id,order_id)
      SELECT shipment_id,id FROM orders WHERE
        id IN (SELECT oi.order_id FROM delivery_allocations a JOIN order_items oi ON oi.id=a.item_id WHERE a.delivery_id=?1)
        AND status IN ('requested','awaiting_payment') AND pay_by IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM order_items WHERE order_id=orders.id AND from_incoming=1)
        AND ${pending}`,
      )
      .bind(key),
    db
      .prepare(
        `UPDATE shipments SET status=CASE WHEN status='closed' THEN 'closed' ELSE 'arrived' END,arrived_at=COALESCE(arrived_at,unixepoch()),
        delivery_version=delivery_version+1,updated_at=unixepoch()
      WHERE id=(SELECT shipment_id FROM deliveries WHERE id=?1) AND ${pending}`,
      )
      .bind(key),
    db
      .prepare('UPDATE deliveries SET applied_at=unixepoch() WHERE id=? AND applied_at IS NULL')
      .bind(key),
  ];
  await db.batch(statements);
  const receipt = await db
    .prepare('SELECT id FROM deliveries WHERE id=? AND applied_at IS NOT NULL')
    .bind(key)
    .first();
  if (!receipt)
    throw new ReceiptConflict(
      'This delivery changed. Reload the page and check the received quantities.',
    );
  const { results } = await db
    .prepare(
      `SELECT oi.order_id,SUM(a.qty) AS filled FROM delivery_allocations a
    JOIN order_items oi ON oi.id=a.item_id WHERE a.delivery_id=? GROUP BY oi.order_id`,
    )
    .bind(key)
    .all<{ order_id: number; filled: number }>();
  return {
    filled: results.reduce((n, r) => n + r.filled, 0),
    orderIds: results.map((r) => r.order_id),
  };
}

/** Single-book callers use the same transaction and receipt identity. */
export async function fillClaims(
  bookId: number,
  arrived: number,
  key: string,
  version: number,
): Promise<Arrival> {
  return receiveDelivery({ bookId, key, version, lines: [{ bookId, qty: arrived }] });
}
