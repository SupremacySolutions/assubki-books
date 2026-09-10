/**
 * What a portal action did, kept just long enough to do the opposite of it.
 *
 * Two things that look different to the owner are the same underneath: the
 * "Undo" on a bulk edit's banner and the "Restore" on a listing in the bin.
 * Both are "put back what this action changed", both can be asked for twice,
 * both can be asked for too late, and both can find the world has moved on. One
 * table and one claim rule means one set of answers to those questions rather
 * than two that drift.
 *
 * **This records an inverse, not a transaction log.** Applying it replays "set
 * these back to what they were", which is not the same as rolling the world back
 * to that moment: a listing hand-edited after the bulk edit loses that hand edit.
 * That is why the offer expires after a day and why the wording says "put back
 * as it was" rather than "cancelled" - the owner is being told what will happen,
 * not sold a time machine.
 */

import { env } from 'cloudflare:workers';

/** How long an undo stays on offer. */
export const UNDO_SECONDS = 86_400;

/** How long the record of who did what outlives the offer. */
const KEEP_DAYS = 7;

export type UndoAction =
  | 'status'
  | 'shelf-add'
  | 'shelf-remove'
  | 'stock'
  | 'price'
  | 'announced'
  | 'delete';

/** Why an undo did not happen. `ok` is the only one that changed anything. */
export type ClaimResult =
  | { ok: true; action: UndoAction; summary: string; inverse: unknown[] }
  | { ok: false; why: 'spent' | 'expired' | 'unknown' };

function token(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Files what an action changed, and hands back the token that reverses it.
 *
 * `summary` is written now and stored, never rebuilt at undo time: what was true
 * when the owner pressed the button is what they should be shown when they think
 * better of it. It doubles as the stock ledger's reason, so a reversal reads as
 * "undo: put 12 listings back on Fiqh" rather than as an unexplained movement.
 *
 * `actor` is nullable on purpose. The shared-password sign-in has no individual
 * identity behind it (`admin-auth.ts` says so in as many words), and recording a
 * placeholder would make the column look answerable when it is not.
 */
export async function record(
  action: UndoAction,
  summary: string,
  actor: string | null,
  inverse: unknown[],
): Promise<string> {
  const value = token();
  await env.DB.prepare(
    `INSERT INTO bulk_edits (token, action, summary, actor, affected, inverse)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(value, action, summary, actor, inverse.length, JSON.stringify(inverse))
    .run();
  return value;
}

/**
 * Takes ownership of an undo, or explains why it cannot be had.
 *
 * The claim *is* the condition - one statement that only marks the row if it is
 * unspent and in date, exactly the trick `leaseAlert` uses on stock alerts. Two
 * tabs pressing Undo on the same banner therefore cannot both apply it: the
 * second finds nothing to claim and is told it is spent, rather than quietly
 * doubling a price change.
 *
 * Nothing is undone here. The caller applies the inverse, because what "put it
 * back" means is different for a shelf and for a price, and putting all of it in
 * one function would be a switch statement pretending to be an abstraction.
 */
export async function claim(value: string): Promise<ClaimResult> {
  const claimed = await env.DB.prepare(
    `UPDATE bulk_edits SET undone_at = unixepoch()
      WHERE token = ?1 AND undone_at IS NULL AND at > unixepoch() - ?2
      RETURNING action, summary, inverse`,
  )
    .bind(value, UNDO_SECONDS)
    .first<{ action: string; summary: string; inverse: string }>();

  if (claimed) {
    return {
      ok: true,
      action: claimed.action as UndoAction,
      summary: claimed.summary,
      inverse: JSON.parse(claimed.inverse) as unknown[],
    };
  }

  // Nothing was claimed, so say which of the three reasons it was. Worth the
  // second read: "that has already been undone" and "that is too old to undo"
  // send the owner to different places, and one message covering both would
  // send them to neither.
  const row = await env.DB.prepare(
    'SELECT undone_at, at FROM bulk_edits WHERE token = ?',
  )
    .bind(value)
    .first<{ undone_at: number | null; at: number }>();

  if (!row) return { ok: false, why: 'unknown' };
  return { ok: false, why: row.undone_at ? 'spent' : 'expired' };
}

/** Reads an undo without taking it, for a page that wants to offer the button. */
export async function peek(
  value: string,
): Promise<{ action: UndoAction; summary: string } | null> {
  const row = await env.DB.prepare(
    `SELECT action, summary FROM bulk_edits
      WHERE token = ? AND undone_at IS NULL AND at > unixepoch() - ?`,
  )
    .bind(value, UNDO_SECONDS)
    .first<{ action: string; summary: string }>();
  return row ? { action: row.action as UndoAction, summary: row.summary } : null;
}

/**
 * Forgets records past their usefulness.
 *
 * Deliberately longer than the undo window: the offer lasts a day, but "who
 * archived those forty listings on Tuesday" is worth a week. The table is tiny
 * either way, so the limit is about not keeping what nobody will read.
 */
export async function pruneBulkEdits(db: D1Database): Promise<number> {
  const done = await db
    .prepare('DELETE FROM bulk_edits WHERE at < unixepoch() - ?')
    .bind(KEEP_DAYS * 86_400)
    .run();
  return done.meta.changes ?? 0;
}
