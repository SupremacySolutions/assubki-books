/**
 * Announcing a listing in the Telegram channel, and keeping the announcement
 * true afterwards.
 *
 * Lives here rather than in the route so that "save" and "save and post" can
 * share it by calling a function. The alternative - having save redirect to the
 * posting endpoint - turns a POST into a GET, and a GET that posts to a public
 * channel and writes to the database is reachable by anything that follows a
 * URL: a prefetch, a crawler, or an `<img src>` on a page the signed-in owner
 * happens to visit.
 */

import { env } from 'cloudflare:workers';
import { getBookAdmin, type AdminBookDetail } from './admin-db';
import { AVAILABLE_SQL } from './availability';
import { channelMessages } from './book-deletion';
import {
  postListing,
  editListing,
  deleteChannelPost,
  REPOST_AFTER_SECONDS,
  type ListingPost,
} from './telegram';
import { imageUrl, stripTags, truncate } from './format';

export type PublishResult =
  | 'posted'
  | 'updated'
  | 'reposted'
  /** The new post went up; the old one could not be taken down. */
  | 'reposted-orphan'
  | 'failed'
  | 'not-live';

/**
 * Copies free now, as the catalogue counts them.
 *
 * Pooled for a set listing, which `getBookAdmin`'s own `stock - reserved` is
 * not - and the channel has to say what the book page says, or a post reads
 * "2 available" beside a page that will not sell one.
 */
async function availableNow(bookId: number, db: D1Database = env.DB): Promise<number> {
  const row = await db
    .prepare(`SELECT ${AVAILABLE_SQL} AS available FROM books b WHERE b.id = ? AND b.deleted_at IS NULL`)
    .bind(bookId)
    .first<{ available: number }>();
  return Math.max(0, row?.available ?? 0);
}

function buildPost(book: AdminBookDetail, available: number, origin: string): ListingPost {
  /*
   * Every photo on the listing, in the order the owner arranged them.
   *
   * Telegram fetches these itself, so they have to be public absolute URLs -
   * and `social` because that is the one square variant, which is the shape
   * Telegram crops an album to anyway.
   */
  const photos = book.images.map((img) => `${origin}${imageUrl(img.image_key, 'social')}`);
  return {
    title: book.title,
    titleAr: book.title_ar,
    pricePence: book.price_pence,
    blurb: truncate(stripTags(book.description_html), 180) || null,
    caption: book.telegram_caption,
    available,
    volumes: book.volumes,
    url: `${origin}/book/${book.slug}`,
    imageUrl: photos[0] ?? null,
    imageUrls: photos,
  };
}


/** SQL for "this post has been sold out long enough to want reposting". */
const LONG_SOLD_OUT = `b.telegram_sold_out_at IS NOT NULL
  AND b.telegram_sold_out_at <= unixepoch() - ${REPOST_AFTER_SECONDS}`;

/**
 * What to record once the channel shows `?1`: the figure, and when it first
 * reached nought - kept, not restamped, while it stays there.
 */
const SHOWN_SET = `telegram_shown_available = ?1,
  telegram_sold_out_at = CASE WHEN ?1 > 0 THEN NULL
                              ELSE COALESCE(telegram_sold_out_at, unixepoch()) END,
  telegram_posted_at = unixepoch()`;

/**
 * The channel has said "out of stock" for days and the shop has copies again.
 *
 * That post is a long way up the channel by now, and editing it in place tells
 * nobody - so this is when the owner is offered a fresh post at the bottom,
 * and when the stock sync stops editing it. NULL is "not recorded", from before
 * the shop kept track, and is not taken as sold out: offering to repost
 * everything the first time would be noise.
 */
export function backInStock(book: {
  telegram_message_id: number | null;
  telegram_shown_available: number | null;
  telegram_sold_out_at: number | null;
}, available: number, now = Math.floor(Date.now() / 1000)): boolean {
  return Boolean(book.telegram_message_id) && book.telegram_shown_available === 0 && available > 0 &&
    book.telegram_sold_out_at !== null && book.telegram_sold_out_at <= now - REPOST_AFTER_SECONDS;
}

export async function publishListing(bookId: number, origin: string): Promise<PublishResult> {
  const book = await getBookAdmin(bookId);
  if (!book) return 'failed';

  // Announcing a draft would send the channel to a page the shop does not serve.
  if (book.status !== 'live') return 'not-live';

  const available = await availableNow(bookId);
  const post = buildPost(book, available, origin);

  if (book.telegram_message_id) {
    const ok = await editListing(book.telegram_message_id, post);
    if (!ok) return 'failed';
    await env.DB.prepare(`UPDATE books SET ${SHOWN_SET} WHERE id = ?2`)
      .bind(available, bookId)
      .run();
    return 'updated';
  }

  const posted = await postListing(post);
  if (!posted) return 'failed';

  await env.DB.prepare(
    `UPDATE books SET ${SHOWN_SET}, telegram_message_id = ?2, telegram_album_ids = ?3
      WHERE id = ?4`,
  )
    .bind(available, posted.messageId, JSON.stringify(posted.albumIds), bookId)
    .run();

  return 'posted';
}

/**
 * A fresh post at the bottom of the channel, and the old one taken down.
 *
 * In that order, and the new ids are written before the delete is tried: if
 * Telegram refuses the delete, the listing still has a post and the database
 * points at the one that is current. The other way round, a failed post would
 * leave a book the channel has forgotten.
 *
 * Deleting a post older than 48 hours needs the bot to hold the channel's
 * "Delete messages" right. Without it the old post stays, and the result says
 * so for the owner to clear by hand.
 */
export async function repostListing(bookId: number, origin: string): Promise<PublishResult> {
  const book = await getBookAdmin(bookId);
  if (!book) return 'failed';
  if (book.status !== 'live') return 'not-live';

  const available = await availableNow(bookId);
  const old = channelMessages(book);

  const posted = await postListing(buildPost(book, available, origin));
  if (!posted) return 'failed';

  await env.DB.prepare(
    `UPDATE books SET ${SHOWN_SET}, telegram_message_id = ?2, telegram_album_ids = ?3
      WHERE id = ?4`,
  )
    .bind(available, posted.messageId, JSON.stringify(posted.albumIds), bookId)
    .run();

  if (!old.length) return 'posted';
  return (await deleteChannelPost(old)) ? 'reposted' : 'reposted-orphan';
}

/** Edits per call. Telegram throttles a bot at around twenty a minute per chat. */
const SYNC_BUDGET = 15;

/**
 * Brings channel posts in step with what is free to buy.
 *
 * Called after anything that moves a count - a checkout, a cancellation, a
 * lapsed hold, a delivery, the owner changing stock - with the books it
 * touched, and by the quarter-hourly sweep with none, which then checks every
 * posted listing. Only a post whose recorded figure differs from the pooled
 * count is edited, so asking twice costs a read and nothing else.
 *
 * A set's listings share a pool, so the ids given are widened to their
 * siblings: selling volumes 1-2 changes what the complete-set post can offer.
 *
 * Random order, because a post Telegram will never let us edit - removed by
 * hand in the channel - fails on every sweep, and a fixed order would let a
 * handful of those take the whole budget each time.
 *
 * Edits in place and never reposts. A post that has sat at nought past
 * `REPOST_AFTER_SECONDS` is left saying so when copies come back: bringing it
 * to life up there tells nobody, and reposting is the owner's decision, made
 * on the listing's page.
 *
 * Never throws. It runs after the customer's order has already been taken, and
 * nothing about the channel is worth failing that for.
 */
export async function syncChannelStock(
  bookIds: number[] | null,
  origin: string,
  db: D1Database = env.DB,
): Promise<{ edited: number; failed: number }> {
  const tally = { edited: 0, failed: 0 };
  try {
    if (bookIds && !bookIds.length) return tally;
    const scope = bookIds
      ? `AND (b.id IN (SELECT value FROM json_each(?1))
              OR b.set_id IN (SELECT set_id FROM books WHERE id IN (SELECT value FROM json_each(?1))
                                AND set_id IS NOT NULL AND deleted_at IS NULL))`
      : '';
    const stmt = db.prepare(
      `SELECT id, available FROM (
         SELECT b.id, MAX(0, ${AVAILABLE_SQL}) AS available, b.telegram_shown_available AS shown,
                (${LONG_SOLD_OUT}) AS long_gone
           FROM books b
          WHERE b.telegram_message_id IS NOT NULL AND b.deleted_at IS NULL
            AND b.status = 'live' ${scope}
       ) WHERE shown IS NOT available
           AND NOT (shown = 0 AND available > 0 AND long_gone)
       ORDER BY RANDOM()
       LIMIT ${SYNC_BUDGET}`,
    );
    const { results } = await (bookIds ? stmt.bind(JSON.stringify(bookIds)) : stmt).all<{
      id: number;
      available: number;
    }>();

    for (const row of results) {
      const book = await getBookAdmin(row.id);
      if (!book?.telegram_message_id) continue;
      const ok = await editListing(book.telegram_message_id, buildPost(book, row.available, origin));
      if (!ok) {
        tally.failed += 1;
        continue;
      }
      /*
       * The post now carries the whole row as it stands - a price the owner
       * saved and had not sent goes out with it - so it is as current as a
       * press of the button would have made it, and is stamped the same way.
       */
      await db
        .prepare(`UPDATE books SET ${SHOWN_SET} WHERE id = ?2`)
        .bind(row.available, row.id)
        .run();
      tally.edited += 1;
    }
  } catch (err) {
    console.error('[channel] stock sync failed', err);
  }
  return tally;
}

/**
 * `syncChannelStock` after the response, from a route that has just moved a
 * count.
 *
 * Handed to `waitUntil` so neither a checkout nor the portal waits on
 * Telegram. Awaited only where there is no execution context, rather than
 * dropped. The ids narrow the check to what the route touched; a route that
 * does not know them passes none and every posted listing is checked, which
 * is a read and no more when nothing moved.
 */
export async function syncChannelSoon(
  locals: unknown,
  origin: string,
  bookIds: number[] | null = null,
): Promise<void> {
  const run = syncChannelStock(bookIds, origin);
  const ctx = (locals as { cfContext?: ExecutionContext }).cfContext;
  if (ctx?.waitUntil) ctx.waitUntil(run);
  else await run;
}

/** `?posted=` value for the listing page to render. */
export function publishQuery(result: PublishResult): string {
  if (result === 'reposted') return 'repost';
  if (result === 'reposted-orphan') return 'orphan';
  return result === 'posted' || result === 'updated' ? '1' : result === 'not-live' ? 'draft' : '0';
}
