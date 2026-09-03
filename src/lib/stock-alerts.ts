import { env } from 'cloudflare:workers';

/**
 * People waiting for a book to come back.
 *
 * The book page has promised "ask us and we will tell you when it is back"
 * since it was written, and until now that promise was kept by the owner
 * remembering.
 *
 * **The row is deleted the moment the message is sent.** The address is held
 * only until it has been used, which is the honest answer to "how long do you
 * keep this" and the reason there is nothing to unsubscribe from - nothing
 * persists to unsubscribe from. There is no double opt-in either: it halves
 * the number of people who finish, and would mean a second kind of token to
 * build and guard for a single low-stakes message.
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

export interface Waiting {
  email: string;
  title: string;
  slug: string;
}

/**
 * Everybody waiting on a book, and the row is taken as it is read.
 *
 * Read and delete together so a second call cannot send the same person the
 * same message twice - two admin actions can raise stock at the same moment,
 * and `RETURNING` makes the claim atomic.
 */
export async function claimWaiting(bookId: number): Promise<Waiting[]> {
  const book = await env.DB.prepare('SELECT title, slug FROM books WHERE id = ?')
    .bind(bookId)
    .first<{ title: string; slug: string }>();
  if (!book) return [];

  const { results } = await env.DB.prepare(
    'DELETE FROM stock_alerts WHERE book_id = ? RETURNING email',
  )
    .bind(bookId)
    .all<{ email: string }>();

  return results.map((r) => ({ email: r.email, title: book.title, slug: book.slug }));
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

    if ((await waitingCount(bookId)) === 0) return 0;

    // Imported here rather than at the top: notify.ts imports this module for
    // `claimWaiting`, and a top-level pair would be a cycle.
    const { notifyBackInStock } = await import('./notify');
    return await notifyBackInStock(bookId, origin);
  } catch (err) {
    console.error('[stock-alerts] could not tell anybody', err);
    return 0;
  }
}
