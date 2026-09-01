/**
 * Releases stock from order requests the owner never acted on.
 *
 * A request holds its copies for 48 hours so payment can be arranged over
 * Telegram without someone else taking the same book. If nothing happens in
 * that window the hold has to lapse, or a browsing customer who abandons a
 * basket quietly takes the last copy off sale forever.
 *
 * The release itself is shared with the site through releaseHold() rather than
 * written out again here, which is what it used to be.
 *
 * This mirrors expireStaleHolds() in src/lib/orders.ts, which the order API
 * also calls inline - whether a customer can buy the last copy must not depend
 * on when this job last fired. This Worker is the safety net that keeps the
 * catalogue's *displayed* availability honest between orders.
 */

import { releaseHold } from '../../src/lib/stock-release';

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
      ...releaseHold(id, 'hold expired', db),
      db.prepare(`UPDATE orders SET status = 'expired', updated_at = unixepoch() WHERE id = ?`).bind(id),
    );
  }

  await db.batch(statements);

  return { orders: stale.length, copies: stale.reduce((n, s) => n + s.copies, 0) };
}

/**
 * Clears out group baskets nobody ever sent.
 *
 * They hold no stock, so nothing is at stake in leaving them - but a table of
 * abandoned class lists is not worth a Worker of its own, and this one already
 * wakes up every quarter of an hour with the database to hand.
 */
export async function expireGroupBaskets(db: D1Database): Promise<number> {
  const { results } = await db
    .prepare(`SELECT id FROM group_baskets WHERE order_ref IS NULL AND expires_at < ?`)
    .bind(Math.floor(Date.now() / 1000))
    .all<{ id: number }>();

  if (!results.length) return 0;

  const ids = results.map((r) => r.id);
  const holes = ids.map(() => '?').join(',');
  await db.batch([
    db.prepare(`DELETE FROM group_basket_items WHERE group_id IN (${holes})`).bind(...ids),
    db.prepare(`DELETE FROM group_baskets WHERE id IN (${holes})`).bind(...ids),
  ]);
  return ids.length;
}

export default {
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const { orders, copies } = await expireHolds(env.DB);
    if (orders) console.log(`expired ${orders} hold(s), released ${copies} cop(ies)`);

    const groups = await expireGroupBaskets(env.DB);
    if (groups) console.log(`cleared ${groups} abandoned group basket(s)`);
  },

  // Manual trigger for testing: `wrangler dev` then curl the worker.
  async fetch(_request: Request, env: Env): Promise<Response> {
    const result = await expireHolds(env.DB);
    const groups = await expireGroupBaskets(env.DB);
    return Response.json({ ...result, groups });
  },
} satisfies ExportedHandler<Env>;
