/**
 * People asking for books the shop does not have.
 *
 * The sibling of `stock-alerts.ts`, and shaped like it on purpose - the same
 * loose validation, the same per-address cap, the same "asking twice is asking
 * once". The difference is what happens next, and it is the whole design:
 *
 * **Nothing is ever sent from here.** A back-in-stock alert has an ending
 * written into it - the book returns, one message goes, the row is deleted, and
 * the promise "we do not keep your address once it has been used" stays true by
 * construction. This has no such ending. The shop may find the book in a month,
 * or never. So the promise made instead is "kept until we have dealt with it,
 * and no longer than ninety days", and the only way to keep that is for the
 * owner's single action to be a DELETE. There is no `handled_at`; see 0043.
 */

import { env } from 'cloudflare:workers';
import { normalise } from './searches';

/**
 * How many open requests one address may have.
 *
 * Half the back-in-stock cap of twenty, because that one is bounded by titles
 * the shop actually stocks and this is unbounded free text. Ten is more than
 * any real customer reaches and few enough that the table cannot be filled from
 * one mailbox.
 */
const PER_EMAIL = 10;

/** Long enough to help, short enough not to be an essay to read in the portal. */
const NOTE_MAX = 300;

/** How long an unanswered request is kept. Stated on the privacy page. */
export const KEEP_DAYS = 90;

export type WantResult = 'added' | 'already' | 'toomany' | 'bad';

export interface BookRequest {
  id: number;
  terms: string;
  note: string | null;
  email: string;
  at: number;
}

export async function askForTitle(
  rawTerms: string,
  rawEmail: string,
  rawNote: string,
): Promise<WantResult> {
  /* The same normalising the miss log uses, so the request and the search it
     came from are one string rather than two spellings of one thing. */
  const terms = normalise(rawTerms);
  if (!terms) return 'bad';

  const email = rawEmail.trim().toLowerCase();
  // Deliberately loose, like `askToBeTold` and `checkEmail`: this is an address
  // to write one reply to, not an identity to verify.
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email) || email.length > 160) return 'bad';

  const note = rawNote.trim().slice(0, NOTE_MAX) || null;

  // Counted in D1 rather than in memory, for the reason the login throttle is:
  // isolates are plural, and a module-level counter protects nothing.
  const held = await env.DB.prepare('SELECT COUNT(*) AS n FROM book_requests WHERE email = ?')
    .bind(email)
    .first<{ n: number }>();
  if ((held?.n ?? 0) >= PER_EMAIL) return 'toomany';

  const done = await env.DB.prepare(
    'INSERT OR IGNORE INTO book_requests (terms, note, email) VALUES (?, ?, ?)',
  )
    .bind(terms, note, email)
    .run();

  return done.meta.changes ? 'added' : 'already';
}

/** Newest first: what somebody asked for this morning is the actionable one. */
export async function listRequests(limit = 100): Promise<BookRequest[]> {
  const { results } = await env.DB.prepare(
    'SELECT id, terms, note, email, at FROM book_requests ORDER BY at DESC LIMIT ?',
  )
    .bind(limit)
    .all<BookRequest>();
  return results;
}

/** How many are waiting, for the dashboard to link through with a number. */
export function requestCountQuery(): D1PreparedStatement {
  return env.DB.prepare('SELECT COUNT(*) AS n FROM book_requests');
}

/** "Done with this" - which is a delete, because that is what was promised. */
export async function deleteRequest(id: number): Promise<boolean> {
  const done = await env.DB.prepare('DELETE FROM book_requests WHERE id = ?').bind(id).run();
  return Boolean(done.meta.changes);
}

/**
 * Forgets requests nobody dealt with.
 *
 * The backstop that makes the ninety days on the privacy page true even when
 * the owner never gets to one. Same shape as `pruneSearches` and `pruneAlerts`,
 * and run beside them by the same sweep.
 */
export async function pruneRequests(db: D1Database, days = KEEP_DAYS): Promise<number> {
  const done = await db
    .prepare('DELETE FROM book_requests WHERE at < unixepoch() - ?1 * 86400')
    .bind(days)
    .run();
  return done.meta.changes ?? 0;
}
