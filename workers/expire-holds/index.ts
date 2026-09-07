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

import { expireOrders } from '../../src/lib/stock-release';
import { pruneSearches } from '../../src/lib/searches';
import { pruneAlerts } from '../../src/lib/stock-alerts';
import { drainArrivalNotices } from '../../src/lib/shipment-notify';
import { SITE } from '../../src/lib/format';

interface Env {
  DB: D1Database;
  /** Unset in production: with no secret there is no manual trigger at all. */
  SWEEP_SECRET?: string;
  /** Only the sweep below touches it; the hold release needs no bucket. */
  UPLOADS?: R2Bucket;
}

export async function expireHolds(db: D1Database): Promise<{ orders: number; copies: number }> {
  return expireOrders(db);
}

/**
 * Reservations that were never answered after the books landed.
 *
 * Keyed on `pay_by` and never on `expires_at`, which matters more than it
 * looks. `confirm.ts` does not clear `expires_at`, so every order sitting in
 * awaiting_payment still carries the stale forty-eight hour value it was
 * created with, long in the past - sweeping that column across both statuses
 * would expire every live confirmed order in the shop the first time this ran.
 * `pay_by` is set only when a delivery lands, so nothing that predates
 * shipments carries one.
 *
 * `requested` and `awaiting_payment` both, because the clock starts when the
 * box arrives and the owner may not have sent a total yet. The claim has
 * already been converted to an ordinary hold by then, so releasing it returns
 * the copies to the shelf and writes the ledger row - which is the point: the
 * whole reason for the deadline is that the copies become sellable again.
 *
 * The `NOT EXISTS` is a guard rather than a nicety. An order that has since
 * acquired a fresh claim on a later delivery is waiting again, and must not be
 * released for not answering about the last one.
 */
export async function expireUnpaidReservations(
  db: D1Database,
): Promise<{ orders: number; copies: number }> {
  return expireOrders(db, true);
}

/**
 * Clears out group baskets nobody ever sent.
 *
 * They hold no stock, so nothing is at stake in leaving them - but a table of
 * abandoned class lists is not worth a Worker of its own, and this one already
 * wakes up every quarter of an hour with the database to hand.
 */
export async function expireGroupBaskets(db: D1Database): Promise<number> {
  /*
   * Deleted by the condition, not by a list of ids.
   *
   * This used to read the ids and build `IN (?,?,...)` from them, one bound
   * parameter per basket. D1 refuses a statement with more than a hundred, so
   * the hundred-and-first abandoned basket did not merely fail to be cleared -
   * it threw, and every stage after it in the sweep was skipped along with it.
   *
   * Naming the condition twice removes the ceiling rather than raising it: the
   * count of rows no longer has anything to do with the count of parameters.
   * Both statements share one batch, so the items cannot outlive their basket.
   */
  const now = Math.floor(Date.now() / 1000);
  const gone = `SELECT id FROM group_baskets WHERE order_ref IS NULL AND expires_at < ?1`;
  const [, baskets] = await db.batch([
    db.prepare(`DELETE FROM group_basket_items WHERE group_id IN (${gone})`).bind(now),
    db.prepare(`DELETE FROM group_baskets WHERE order_ref IS NULL AND expires_at < ?1`).bind(now),
  ]);
  return baskets.meta.changes ?? 0;
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
   *
   * One object failing no longer abandons the rest. The rows whose objects did
   * go are cleared; the rest keep their pointers and are found again next time,
   * which is what makes a partial run safe to repeat.
   */
  const cleared: number[] = [];
  for (const row of results) {
    try {
      await bucket.delete(row.image_key);
      cleared.push(row.id);
    } catch (err) {
      console.error(`could not remove ${row.image_key}, leaving its row for the next sweep:`, err);
    }
  }
  if (!cleared.length) return 0;

  /*
   * `json_each` rather than a placeholder per id. Two hundred rows are read at
   * a time and D1 refuses more than a hundred bound parameters, so the list
   * became a thrown error at a hundred and one - after the objects had already
   * been deleted, leaving every one of those rows pointing at a file that was
   * no longer there.
   */
  await db
    .prepare(`UPDATE messages SET image_key = NULL WHERE id IN (SELECT value FROM json_each(?1))`)
    .bind(JSON.stringify(cleared))
    .run();

  return cleared.length;
}

/**
 * One pass of the sweep, insulated from the others.
 *
 * These stages are independent jobs that happen to share a timer, and they ran
 * as one unbroken sequence: the first to throw took every later one with it,
 * silently, until the next quarter hour - and then threw again. That is the
 * worst possible failure for the two that matter most. A customer whose books
 * have landed is told by `drainArrivalNotices`, and a reservation that nobody
 * answered is released by `expireUnpaidReservations`; both sit behind other
 * work that has nothing to do with either.
 *
 * So a stage that fails is logged loudly and the rest still run. It does not
 * paper over the failure - the error is named, and the stage will be attempted
 * again on the next tick, which is what a retry looks like here.
 */
async function stage<T>(name: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (err) {
    console.error(`sweep stage "${name}" failed, continuing with the rest:`, err);
    return null;
  }
}

export default {
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const held = await stage('expire holds', () => expireHolds(env.DB));
    if (held?.orders) console.log(`expired ${held.orders} hold(s), released ${held.copies} cop(ies)`);

    const unpaid = await stage('expire unpaid reservations', () =>
      expireUnpaidReservations(env.DB),
    );
    if (unpaid?.orders) {
      console.log(`released ${unpaid.copies} cop(ies) from ${unpaid.orders} unanswered reservation(s)`);
    }

    /*
     * Telling people their shipment landed, a few at a time.
     *
     * Deliberately here rather than in the request that marks a shipment
     * arrived: forty customers is forty outbound requests, which is more than
     * one handler may make and most of a day's mail allowance. Spread over
     * quarter-hours it stays inside both, and a failure becomes a retry.
     */
    const told = await stage('arrival notices', () => drainArrivalNotices(env.DB, SITE.url));
    if (told && (told.sent || told.failed)) {
      console.log(`told ${told.sent} customer(s) their shipment arrived, ${told.failed} to retry`);
    }

    const groups = await stage('group baskets', () => expireGroupBaskets(env.DB));
    if (groups) console.log(`cleared ${groups} abandoned group basket(s)`);

    const proofs = await stage('payment screenshots', () => sweepProofs(env.DB, env.UPLOADS));
    if (proofs) console.log(`removed ${proofs} payment screenshot(s) from closed orders`);

    /*
     * A log nobody trims is a liability rather than an asset. This is free
     * text a customer typed into a search box, and people occasionally type
     * things that identify them; ninety days is long enough to see a pattern
     * worth ordering against and short enough not to be a record.
     */
    const searches = await stage('prune searches', () => pruneSearches(env.DB));
    if (searches) console.log(`pruned ${searches} search(es) older than 90 days`);

    // Nobody replies to a Telegram notification from two months ago, and an
    // unbounded lookup table is a liability rather than a feature.
    const notices = await stage('prune owner notices', () =>
      env.DB.prepare('DELETE FROM owner_notices WHERE at < unixepoch() - 60 * 86400').run(),
    );
    if (notices?.meta.changes) console.log(`pruned ${notices.meta.changes} old owner notice(s)`);

    /*
     * "Tell me when it is back" for a book that never came back.
     *
     * Those rows are deleted when the message is sent, so this only catches
     * the ones with no ending - and the privacy page promises the address does
     * not outlive its purpose, which was true of every case except the one
     * that never resolves.
     */
    const stale = await stage('prune back-in-stock requests', () => pruneAlerts(env.DB));
    if (stale) console.log(`forgot ${stale} unanswered back-in-stock request(s)`);
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

    /*
     * The same passes the timer runs, in the same order.
     *
     * A manual trigger that does less than the scheduled one is a trigger you
     * cannot test the scheduled one with - and these two are the passes most
     * worth being able to run on demand, because one releases stock and the
     * other writes to customers.
     */
    const result = await expireHolds(env.DB);
    const unpaid = await expireUnpaidReservations(env.DB);
    const told = await drainArrivalNotices(env.DB, SITE.url);
    const groups = await expireGroupBaskets(env.DB);
    const proofs = await sweepProofs(env.DB, env.UPLOADS);
    const searches = await pruneSearches(env.DB);
    return Response.json({ ...result, unpaid, told, groups, proofs, searches });
  },
} satisfies ExportedHandler<Env>;
