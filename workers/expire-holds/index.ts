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
import { pruneSearches } from '../../src/lib/searches';

interface Env {
  DB: D1Database;
  /** Unset in production: with no secret there is no manual trigger at all. */
  SWEEP_SECRET?: string;
  /** Only the sweep below touches it; the hold release needs no bucket. */
  UPLOADS?: R2Bucket;
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

/**
 * Removes payment screenshots once the order they belong to is over.
 *
 * A screenshot of a bank transfer shows a balance, an account number and a real
 * name. The shop needs it to check one payment against one order; it has no
 * business keeping it for years, and the thread tells the customer plainly that
 * it will not.
 *
 * **Six months, not immediately.** A screenshot is the shop's only record of a
 * payment it could not check any other way, so it has to outlive the argument
 * it might be needed for - a chargeback, a dispute, or a question from the
 * customer months later - rather than the order it belongs to.
 *
 * The `messages` row stays and only `image_key` is nulled, so the conversation
 * still reads as a conversation - "they sent a photo here, and it has since
 * been removed" - rather than developing a hole.
 *
 * `expired` is swept alongside `completed` and `cancelled`: a lapsed hold is
 * just as over as a cancelled order, and it would be an odd rule that kept
 * somebody's bank details longer because nobody got round to answering them.
 */
const KEEP_AFTER_CLOSE = 183 * 24 * 60 * 60;

export async function sweepProofs(
  db: D1Database,
  bucket: R2Bucket | undefined,
): Promise<number> {
  if (!bucket) return 0;

  const cutoff = Math.floor(Date.now() / 1000) - KEEP_AFTER_CLOSE;

  /*
   * `completed_at` where there is one, `updated_at` otherwise - a cancelled or
   * expired order records no closing timestamp of its own, and the moment it
   * was last written is the moment it closed.
   */
  const { results } = await db
    .prepare(
      `SELECT m.id, m.image_key
         FROM messages m JOIN orders o ON o.id = m.order_id
        WHERE m.image_key IS NOT NULL
          AND o.status IN ('completed', 'cancelled', 'expired')
          AND COALESCE(o.completed_at, o.updated_at) < ?
        LIMIT 200`,
    )
    .bind(cutoff)
    .all<{ id: number; image_key: string }>();

  if (!results.length) return 0;

  /*
   * The object goes first. If the run dies between the two, the next sweep
   * finds the row again and deletes an object that is already gone, which R2
   * treats as success - the other order would leave a file nothing points at
   * and nothing will ever come back for.
   */
  for (const row of results) {
    await bucket.delete(row.image_key);
  }

  const ids = results.map((r) => r.id);
  await db
    .prepare(
      `UPDATE messages SET image_key = NULL WHERE id IN (${ids.map(() => '?').join(',')})`,
    )
    .bind(...ids)
    .run();

  return ids.length;
}

export default {
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const { orders, copies } = await expireHolds(env.DB);
    if (orders) console.log(`expired ${orders} hold(s), released ${copies} cop(ies)`);

    const groups = await expireGroupBaskets(env.DB);
    if (groups) console.log(`cleared ${groups} abandoned group basket(s)`);

    const proofs = await sweepProofs(env.DB, env.UPLOADS);
    if (proofs) console.log(`removed ${proofs} payment screenshot(s) from closed orders`);

    /*
     * A log nobody trims is a liability rather than an asset. This is free
     * text a customer typed into a search box, and people occasionally type
     * things that identify them; ninety days is long enough to see a pattern
     * worth ordering against and short enough not to be a record.
     */
    const searches = await pruneSearches(env.DB);
    if (searches) console.log(`pruned ${searches} search(es) older than 90 days`);

    // Nobody replies to a Telegram notification from two months ago, and an
    // unbounded lookup table is a liability rather than a feature.
    const notices = await env.DB
      .prepare('DELETE FROM owner_notices WHERE at < unixepoch() - 60 * 86400')
      .run();
    if (notices.meta.changes) console.log(`pruned ${notices.meta.changes} old owner notice(s)`);
  },

  /**
   * Manual trigger, for `wrangler dev` only.
   *
   * This ran every mutation the cron does - expiring holds, clearing group
   * baskets, deleting payment screenshots - to anybody who found the URL, and
   * `workers.dev` is on by default, so the URL was public. It was put here as a
   * convenience for testing and was reachable in production.
   *
   * Now: refused unless a secret is configured *and* matched, and refused
   * outright on anything but POST, so it cannot be fired by a crawler
   * following a link. With no secret set there is no manual trigger at all,
   * which is the right default for production - the cron needs none of this.
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const secret = env.SWEEP_SECRET;
    if (!secret) return new Response('Not found', { status: 404 });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    const offered = request.headers.get('X-Sweep-Secret') ?? '';
    // Length first, then a full scan, so a timing difference cannot leak the
    // secret a character at a time - the same shape as the order token compare.
    const a = new TextEncoder().encode(secret);
    const b = new TextEncoder().encode(offered);
    let diff = a.length === b.length ? 0 : 1;
    for (let i = 0; i < a.length && i < b.length; i++) diff |= a[i] ^ b[i];
    if (diff !== 0) return new Response('Not found', { status: 404 });

    const result = await expireHolds(env.DB);
    const groups = await expireGroupBaskets(env.DB);
    const proofs = await sweepProofs(env.DB, env.UPLOADS);
    const searches = await pruneSearches(env.DB);
    return Response.json({ ...result, groups, proofs, searches });
  },
} satisfies ExportedHandler<Env>;
