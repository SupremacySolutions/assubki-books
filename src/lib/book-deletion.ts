/**
 * Deleting a listing, in two steps a month apart.
 *
 * It used to be one step, and that step destroyed three things that do not come
 * back: the cover objects in R2, the announcement in the Telegram channel, and -
 * by cascade - every row the book ever had in `stock_ledger`. The ledger exists
 * so that "where did that copy go?" is always answerable, and deleting the book
 * was the one operation in the shop that made it permanently unanswerable. What
 * stood between the owner and that was a `confirm()`.
 *
 * So: deleting puts the listing in the bin and does nothing irreversible. It
 * leaves the shop at once - that part is not deferred, because a listing the
 * owner has withdrawn must stop being for sale immediately - but the row, its
 * photos and its history stay put for `RETENTION_DAYS`, and Restore brings the
 * whole thing back. The cron sweep does the real destruction afterwards.
 *
 * **The channel post is the exception, and cannot be otherwise.** A Telegram bot
 * may only delete its own message within 48 hours of posting it. Any retention
 * window worth having is longer than that, so deferring the channel delete to
 * purge time would not be tidier - it would fail every single time and leave the
 * channel advertising books that no longer exist. It goes now. Restoring a
 * listing therefore cannot bring its announcement back, and says so; the listing
 * page can repost it.
 */

import { env } from 'cloudflare:workers';
import { deleteChannelPost } from './telegram';
import { forgetCategoryCounts, forgetHomeRows } from './db';
import { record } from './bulk-undo';

/** How long a listing sits in the bin before it is really destroyed. */
export const RETENTION_DAYS = 30;

/**
 * Every word the shop uses about this, in one place.
 *
 * The old dialog promised immediate and total destruction. That is now a lie in
 * three separate ways, and a confirmation that misdescribes what it is
 * confirming is worse than none - so the wording lives here beside the code that
 * makes it true, rather than in the markup where the two can drift.
 */
export const DELETION = {
  confirm: (title: string) => `Delete "${title}"?`,
  body:
    `It comes off the shop now, and its post in the channel comes down. ` +
    `You have ${RETENTION_DAYS} days to put it back from Recently deleted. ` +
    `After that its photos and its stock history are destroyed for good. ` +
    `Past orders keep their own record of what was bought.`,
  /* The channel post is gone whatever happens next, so the owner is told once,
     plainly, rather than discovering it on restore. */
  orphaned:
    'The listing is in the bin, but its channel post could not be removed. ' +
    'Take it down in Telegram by hand.',
  restored: (title: string) =>
    `"${title}" is back in the shop. Its channel post was not restored - ` +
    `repost it from the listing if you want one.`,
  goesOn: (deletedAt: number) =>
    new Date((deletedAt + RETENTION_DAYS * 86_400) * 1000).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'long',
    }),
  held: 'Copies are promised to an open order, so this cannot be deleted yet.',
} as const;

export interface SoftDeleted {
  token: string;
  title: string;
  channelCleared: boolean;
}

/**
 * Puts a listing in the bin.
 *
 * Returns `null` when there is no such book, and `'held'` when copies are
 * promised to a live order - unchanged from the hard delete, and for the same
 * reason: a customer is still waiting on those books. That refusal is also what
 * lets the set-availability queries skip a deleted option's `reserved` without
 * thinking about it, since a listing in the bin always holds nothing.
 */
export async function softDelete(
  id: number,
  actor: string | null,
): Promise<SoftDeleted | 'held' | null> {
  const book = await env.DB.prepare(
    `SELECT id, title, status, reserved, telegram_message_id, telegram_album_ids
       FROM books WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(id)
    .first<{
      id: number;
      title: string;
      status: string;
      reserved: number;
      telegram_message_id: number | null;
      telegram_album_ids: string | null;
    }>();

  if (!book) return null;
  if (book.reserved > 0) return 'held';

  /*
   * The announcement, every message of it.
   *
   * A listing posted with several photographs is an album - one message each -
   * and clearing only the captioned one leaves the photographs behind with
   * nothing to click. `telegram_album_ids` is absent on anything posted before
   * albums existed, and those really are a single message.
   */
  let channelCleared = true;
  if (book.telegram_message_id) {
    let ids: number[] = [book.telegram_message_id];
    try {
      const stored = book.telegram_album_ids ? JSON.parse(book.telegram_album_ids) : null;
      if (Array.isArray(stored) && stored.length) ids = stored.filter((n) => Number.isInteger(n));
    } catch {
      // Unreadable is not a reason to leave the post up: fall back to the id
      // that has always been there and clear what can be cleared.
    }
    channelCleared = await deleteChannelPost(ids);
  }

  /*
   * The prior status travels with the tombstone, not in `status` itself.
   *
   * Deleting a draft and restoring it has to give a draft back. `status` holds
   * one value and is fenced by a CHECK constraint from 0001 that cannot admit a
   * fourth, so the bin is `deleted_at` alone and what the listing *was* is
   * recorded here - which is also the only thing Restore needs to know.
   */
  const token = await record('delete', `deleted "${book.title}"`, actor, [
    { id: book.id, status: book.status, title: book.title },
  ]);

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE books
          SET deleted_at = unixepoch(), updated_at = unixepoch(),
              telegram_message_id = NULL, telegram_album_ids = NULL
        WHERE id = ?`,
    ).bind(id),
    /*
     * Nobody is told a book is back when it is on its way to being destroyed.
     *
     * The book page promises one message and that the address is not kept
     * afterwards, and the privacy page repeats it. An address held against a
     * listing in the bin is being kept for a message that will never be sent,
     * which breaks the second half of that promise to keep a version of the
     * first. Restoring the listing does not bring the waiting list back, and
     * should not: those people asked months ago and never heard.
     */
    env.DB.prepare('DELETE FROM stock_alerts WHERE book_id = ?').bind(id),
  ]);

  forgetCategoryCounts();
  forgetHomeRows();

  return { token, title: book.title, channelCleared };
}

/**
 * Takes a listing back out of the bin.
 *
 * The slug was never freed while it sat there, which is a real argument for
 * doing it this way: there is no name collision to resolve and no chance the
 * owner has since created something that has taken the URL.
 */
export async function restore(id: number): Promise<{ title: string } | null> {
  /* A delete tombstone always holds exactly one listing, so the id is at a
     fixed path and can be matched exactly. A LIKE against the JSON text would
     also match id 12 when looking for id 1. */
  const tomb = await env.DB.prepare(
    `SELECT inverse FROM bulk_edits
      WHERE action = 'delete' AND json_extract(inverse, '$[0].id') = ?
      ORDER BY at DESC LIMIT 1`,
  )
    .bind(id)
    .first<{ inverse: string }>();

  /*
   * A listing whose tombstone has been pruned still comes back.
   *
   * The record is kept for a week and the bin for a month, so for most of a
   * listing's time in the bin there is nothing left saying what it was. Falling
   * back to `draft` rather than refusing is the kinder failure: the owner gets
   * their listing and their photographs back and has to press Publish, instead
   * of being told the shop knows the book is there but will not hand it over.
   */
  let priorStatus = 'draft';
  try {
    const parsed = JSON.parse(tomb?.inverse ?? '[]') as { id: number; status?: string }[];
    const mine = parsed.find((entry) => entry.id === id);
    if (mine?.status) priorStatus = mine.status;
  } catch {
    // Same fallback; an unreadable record is no worse than a missing one.
  }

  const back = await env.DB.prepare(
    `UPDATE books SET deleted_at = NULL, status = ?, updated_at = unixepoch()
      WHERE id = ? AND deleted_at IS NOT NULL
      RETURNING title`,
  )
    .bind(priorStatus, id)
    .first<{ title: string }>();

  if (!back) return null;

  forgetCategoryCounts();
  forgetHomeRows();
  return { title: back.title };
}

/**
 * Destroys what the bin has been holding, for listings whose month is up.
 *
 * The photographs go before the row does. If this dies partway, the row is still
 * there to be found next time and the objects it names are re-deletable; the
 * other order leaves R2 objects nothing in the database refers to, which nothing
 * ever finds again. `sweepProofs` orders itself the same way for the same reason.
 *
 * No Telegram call. The post came down when the listing went in the bin, and by
 * now it is far outside the 48 hours in which a bot could delete anything.
 */
export async function purgeDeletedBooks(
  db: D1Database,
  bucket: R2Bucket | undefined,
  limit = 20,
): Promise<number> {
  const { results: due } = await db
    .prepare(
      `SELECT id FROM books
        WHERE deleted_at IS NOT NULL AND deleted_at < unixepoch() - ?
        ORDER BY deleted_at LIMIT ?`,
    )
    .bind(RETENTION_DAYS * 86_400, limit)
    .all<{ id: number }>();

  let purged = 0;
  for (const { id } of due) {
    if (await purgeOne(db, bucket, id)) purged += 1;
  }
  return purged;
}

/**
 * Destroys one listing that is already in the bin.
 *
 * Shared by the sweep and by the portal's "destroy it now", so that the order of
 * operations - and the fact that it refuses anything not already in the bin -
 * is written once. That refusal is the whole safety of the button: it cannot be
 * pointed at a live listing to skip the thirty days.
 */
export async function purgeOne(
  db: D1Database,
  bucket: R2Bucket | undefined,
  id: number,
): Promise<{ title: string } | null> {
  const book = await db
    .prepare('SELECT id, title FROM books WHERE id = ? AND deleted_at IS NOT NULL')
    .bind(id)
    .first<{ id: number; title: string }>();
  if (!book) return null;

  if (bucket) {
    const { results: images } = await db
      .prepare('SELECT image_key FROM book_images WHERE book_id = ?')
      .bind(id)
      .all<{ image_key: string }>();
    for (const img of images) {
      await bucket.delete(img.image_key).catch((err) => console.error('[purge] R2', err));
    }
  }

  // book_images, book_categories and stock_ledger cascade; order_items null
  // out, and each keeps its own title and price snapshot, so a past order
  // still reads correctly after the book itself is gone.
  await db.prepare('DELETE FROM books WHERE id = ?').bind(id).run();

  forgetCategoryCounts();
  forgetHomeRows();
  return { title: book.title };
}
