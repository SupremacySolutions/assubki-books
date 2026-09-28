/** Completed website orders are kept for two calendar years after completion. */
export const COMPLETED_ORDER_YEARS = 2;

export function completedOrderCutoff(now = new Date()): number {
  const cutoff = new Date(now);
  const month = cutoff.getUTCMonth();
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - COMPLETED_ORDER_YEARS);
  // On February 29, clamp to February 28 instead of overflowing to March 1
  // and deleting March 1 records a day before their second anniversary.
  if (cutoff.getUTCMonth() !== month) cutoff.setUTCDate(0);
  return Math.floor(cutoff.getTime() / 1000);
}

/**
 * Remove a bounded batch, including the submitted group basket. Child order
 * items, messages, delivery records and notices cascade; stock movements keep
 * their history with a null order_id. No stock is released by retention.
 *
 * sweepProofs runs first. Keep orders with any remaining R2 pointer so a failed
 * image deletion can retry instead of leaving private files without a record.
 */
export async function pruneCompletedOrders(db: D1Database, now = new Date()): Promise<number> {
  const cutoff = completedOrderCutoff(now);
  const eligible = `SELECT id FROM orders o
    WHERE o.status = 'completed'
      AND COALESCE(o.completed_at, o.updated_at) <= ?1
      AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.order_id = o.id AND m.image_key IS NOT NULL)
    ORDER BY COALESCE(o.completed_at, o.updated_at), o.id LIMIT 100`;
  // All eligibility checks and deletes execute in one transaction. The first
  // statement does not change the orders selected by the second statement.
  const [, orders] = await db.batch([
    db.prepare(`DELETE FROM group_baskets WHERE order_ref IN
      (SELECT ref FROM orders WHERE id IN (${eligible}))`).bind(cutoff),
    db.prepare(`DELETE FROM orders WHERE id IN (${eligible})`).bind(cutoff),
  ]);
  return orders.meta.changes ?? 0;
}
