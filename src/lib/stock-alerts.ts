import { env } from 'cloudflare:workers';

/**
 * People waiting for a book to come back.
 *
 * The book page has promised "ask us and we will tell you when it is back"
 * since it was written, and until now that promise was kept by the owner
 * remembering.
 *
 * **The row is deleted the moment the message is sent** - and not one moment
 * earlier. The address is held only until it has been used, which is the honest
 * answer to "how long do you keep this" and the reason there is nothing to
 * unsubscribe from: nothing persists to unsubscribe from. There is no double
 * opt-in either: it halves the number of people who finish, and would mean a
 * second kind of token to build and guard for a single low-stakes message.
 *
 * The row used to be deleted the moment it was *read*, which is not the same
 * thing and cost people their alerts whenever a provider refused. It is a small
 * outbox now - claimed, attempted, backed off, deleted on success - built the
 * way `shipment-notify.ts` builds the same idea. See `0040_stock_alert_outbox`.
 */

/** One address may be waiting on this many titles at once. */
const PER_EMAIL = 20;

export type AskResult = 'added' | 'already' | 'toomany' | 'bad';

export async function askToBeTold(bookId: number, rawEmail: string): Promise<AskResult> {
  const email = rawEmail.trim().toLowerCase();
  // Deliberately loose, like `checkEmail` elsewhere: this is a address to send
  // one message to, not an identity to verify.
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email) || email.length > 160) return 'bad';

  // Counted in D1 rather than in memory, for the reason the login throttle is:
  // isolates are plural and a module-level counter protects nothing. This is
  // what stops the form being used to post mail at somebody.
  const held = await env.DB.prepare('SELECT COUNT(*) AS n FROM stock_alerts WHERE email = ?')
    .bind(email)
    .first<{ n: number }>();
  if ((held?.n ?? 0) >= PER_EMAIL) return 'toomany';

  const done = await env.DB.prepare(
    'INSERT OR IGNORE INTO stock_alerts (book_id, email) VALUES (?, ?)',
  )
    .bind(bookId, email)
    .run();

  return done.meta.changes ? 'added' : 'already';
}

/**
 * How long an unclaimed request is kept.
 *
 * The row is normally deleted the moment the message goes out, so this only
 * ever catches the case that has no ending: a book that never comes back.
 * Editions go out of print, and without this the address of somebody who asked
 * about one in 2026 would still be here in 2036 - with nothing to unsubscribe
 * from, because the whole design says nothing persists.
 *
 * Six months, matching how long the shop keeps a payment screenshot. Long
 * enough for a reprint to arrive, short enough to be an honest answer to "how
 * long do you keep this".
 */
const KEEP_WAITING = 183 * 24 * 60 * 60;

/** Forgets requests for books that never came back. */
export async function pruneAlerts(db: D1Database): Promise<number> {
  const done = await db
    .prepare('DELETE FROM stock_alerts WHERE created_at < unixepoch() - ?')
    .bind(KEEP_WAITING)
    .run();
  return done.meta.changes ?? 0;
}

export interface Waiting {
  email: string;
  title: string;
  slug: string;
}

/**
 * Marks everybody waiting on a book as owed a message.
 *
 * This replaces reading-and-deleting in one go. That was atomic, which is what
 * stopped two admin actions telling one person twice, but it made the delete
 * the *only* record that the promise had been taken on - so a provider refusing
 * threw the subscriber away with the attempt.
 *
 * Setting `claimed_at` is just as atomic and throws nobody away. The row now
 * disappears at one moment only: after a send that actually succeeded.
 *
 * `next_attempt_at = 0` so a restock re-arms a row that had backed off. Somebody
 * whose address was refusing mail a week ago is worth another go the next time
 * the book comes back.
 */
export async function markWaitingDue(bookId: number): Promise<number> {
  const done = await env.DB.prepare(
    `UPDATE stock_alerts SET claimed_at = unixepoch(), next_attempt_at = 0
      WHERE book_id = ? AND claimed_at IS NULL`,
  )
    .bind(bookId)
    .run();
  return done.meta.changes ?? 0;
}

export interface DueAlert extends Waiting {
  id: number;
  bookId: number;
}

/** How many at once. The mail quota is the constraint, not the database. */
const PER_SWEEP = 20;

/**
 * What is owed, ready to try, and not already being sent by somebody else.
 *
 * Availability is re-checked here rather than trusted from whenever the row was
 * claimed. A title can be restocked on Monday and sell out on Tuesday before a
 * failing address finally accepts mail, and "it is back on the shelf" would
 * then be a lie that sends somebody to an empty page.
 */
export async function dueAlerts(db: D1Database, limit = PER_SWEEP): Promise<DueAlert[]> {
  const { results } = await db
    .prepare(
      `SELECT a.id, a.email, a.book_id AS bookId, b.title, b.slug
         FROM stock_alerts a
         JOIN books b ON b.id = a.book_id
        WHERE a.claimed_at IS NOT NULL
          AND a.next_attempt_at <= unixepoch()
          AND a.lease_until <= unixepoch()
          AND b.status = 'live'
          AND (b.stock - b.reserved) > 0
        ORDER BY a.id
        LIMIT ?`,
    )
    .bind(Math.min(PER_SWEEP, limit))
    .all<DueAlert>();
  return results;
}

/**
 * Takes one row for sending, or returns null if it is no longer ours to send.
 *
 * The whole condition rides on the write. Reading "is this free?" and then
 * writing "mine now" is two statements with a gap between them, and the gap is
 * exactly what a quarter-hourly sweep and an admin stock edit will find.
 *
 * Availability is re-tested here as well as in `dueAlerts`, and that repetition
 * is the point: between selecting the row and sending its message, somebody can
 * buy the last copy. Whoever loses that race must not post "it is on the shelf
 * now" about a book that is not. Losing here leaves the row claimed and
 * untouched, so the next restock finds it still owed and still waiting - which
 * is the honest outcome, and needs no separate bookkeeping to arrange.
 */
export async function leaseAlert(db: D1Database, id: number): Promise<string | null> {
  const token = crypto.randomUUID();
  const claimed = await db
    .prepare(
      `UPDATE stock_alerts SET lease_token = ?, lease_until = unixepoch() + 300
        WHERE id = ? AND claimed_at IS NOT NULL
          AND next_attempt_at <= unixepoch() AND lease_until <= unixepoch()
          AND EXISTS (SELECT 1 FROM books b
                       WHERE b.id = stock_alerts.book_id
                         AND b.status = 'live' AND (b.stock - b.reserved) > 0)`,
    )
    .bind(token, id)
    .run();
  return claimed.meta.changes ? token : null;
}

/**
 * Told, and forgotten.
 *
 * The delete is the acknowledgement, and it happens here and nowhere else. It
 * also keeps the promise printed on the book page: the address is not kept once
 * it has been used.
 */
export async function alertSent(db: D1Database, id: number, token: string): Promise<void> {
  await db
    .prepare('DELETE FROM stock_alerts WHERE id = ? AND lease_token = ?')
    .bind(id, token)
    .run();
}

/**
 * Not told, and why.
 *
 * Backs off the same way the shipment notices do - fifteen minutes doubling to
 * a day - so a provider having a bad hour is waited out rather than hammered,
 * and an address that will never accept mail costs one send a day until the
 * six-month prune forgets it.
 */
export async function alertFailed(
  db: D1Database,
  id: number,
  token: string,
  why: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE stock_alerts
          SET attempts = attempts + 1,
              last_error = ?,
              next_attempt_at = unixepoch() + MIN(86400, 900 * (1 << MIN(attempts, 7))),
              lease_token = NULL,
              lease_until = 0
        WHERE id = ? AND lease_token = ?`,
    )
    .bind(why.slice(0, 200), id, token)
    .run();
}

/**
 * Sends what is owed, and records what happened to each.
 *
 * Called both from the admin action that raised the stock - so a customer hears
 * within seconds, as they did before - and from the quarter-hourly sweep, which
 * is what makes a failure temporary rather than final. Neither can send the
 * same message twice, because neither can hold the same lease.
 *
 * Never throws. This runs at the end of somebody's stock edit, and an email
 * provider having a bad minute must not fail that edit.
 */
export async function drainStockAlerts(
  db: D1Database,
  origin: string,
  limit = PER_SWEEP,
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;

  try {
    const due = await dueAlerts(db, limit);

    for (const alert of due) {
      const token = await leaseAlert(db, alert.id);
      if (!token) continue;

      // Imported here rather than at the top: notify.ts imports this module,
      // and a top-level pair would be a cycle.
      const { sendBackInStock } = await import('./notify');

      let ok = false;
      let why = '';
      try {
        ok = await sendBackInStock(alert, origin);
      } catch (err) {
        why = String(err);
      }

      if (ok) {
        sent++;
        await alertSent(db, alert.id, token);
      } else {
        failed++;
        await alertFailed(db, alert.id, token, why || 'the provider would not take it');
      }
    }
  } catch (err) {
    console.error('[stock-alerts] could not drain', err);
  }

  return { sent, failed };
}

/** How many people are waiting, for the owner's own screens. */
export async function waitingCount(bookId: number): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM stock_alerts WHERE book_id = ?')
    .bind(bookId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Tell anybody waiting, but only if there is really something to tell them.
 *
 * Called *after* an operation has finished rather than as stock rises. A
 * delivery raises stock and then hands copies to the people who reserved them;
 * checking half way through would announce copies that were already spoken for.
 * Availability now, at the end, is the only honest test.
 *
 * Never throws. Somebody's stock edit must not fail because an email did.
 */
export async function tellWaiting(
  bookId: number,
  origin: string,
): Promise<number> {
  try {
    const row = await env.DB.prepare(
      'SELECT (stock - reserved) AS available FROM books WHERE id = ? AND status = ?',
    )
      .bind(bookId, 'live')
      .first<{ available: number }>();
    if (!row || row.available <= 0) return 0;

    /*
     * Owed first, sent second.
     *
     * The marking is a single statement and it is the part that must not be
     * lost: once it has run, the promise is recorded as outstanding and the
     * sweep will keep trying until it is kept. The send that follows is only an
     * attempt to keep it *now*, which is what a customer watching a book page
     * expects - it is not what makes it true.
     *
     * So a worker evicted between the two lines costs a few minutes' delay
     * rather than a subscriber, which is precisely the failure that used to be
     * silent and permanent.
     */
    await markWaitingDue(bookId);
    const { sent } = await drainStockAlerts(env.DB, origin);
    return sent;
  } catch (err) {
    console.error('[stock-alerts] could not tell anybody', err);
    return 0;
  }
}
