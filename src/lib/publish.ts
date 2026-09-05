/**
 * Announcing a listing in the Telegram channel.
 *
 * Lives here rather than in the route so that "save" and "save and post" can
 * share it by calling a function. The alternative - having save redirect to the
 * posting endpoint - turns a POST into a GET, and a GET that posts to a public
 * channel and writes to the database is reachable by anything that follows a
 * URL: a prefetch, a crawler, or an `<img src>` on a page the signed-in owner
 * happens to visit.
 */

import { env } from 'cloudflare:workers';
import { getBookAdmin } from './admin-db';
import { postListing, editListing, type ListingPost } from './telegram';
import { imageUrl, stripTags, truncate } from './format';

export type PublishResult = 'posted' | 'updated' | 'failed' | 'not-live';

export async function publishListing(bookId: number, origin: string): Promise<PublishResult> {
  const book = await getBookAdmin(bookId);
  if (!book) return 'failed';

  // Announcing a draft would send the channel to a page the shop does not serve.
  if (book.status !== 'live') return 'not-live';

  /*
   * Every photo on the listing, in the order the owner arranged them.
   *
   * Telegram fetches these itself, so they have to be public absolute URLs -
   * and `social` because that is the one square variant, which is the shape
   * Telegram crops an album to anyway.
   */
  const photos = book.images.map((img) => `${origin}${imageUrl(img.image_key, 'social')}`);

  const post: ListingPost = {
    title: book.title,
    titleAr: book.title_ar,
    pricePence: book.price_pence,
    blurb: truncate(stripTags(book.description_html), 180) || null,
    note: book.telegram_note,
    available: book.available,
    volumes: book.volumes,
    url: `${origin}/book/${book.slug}`,
    imageUrl: photos[0] ?? null,
    imageUrls: photos,
  };

  if (book.telegram_message_id) {
    const ok = await editListing(book.telegram_message_id, post);
    return ok ? 'updated' : 'failed';
  }

  const posted = await postListing(post);
  if (!posted) return 'failed';

  await env.DB.prepare(
    `UPDATE books SET telegram_message_id = ?, telegram_album_ids = ?,
                      telegram_posted_at = unixepoch()
      WHERE id = ?`,
  )
    .bind(posted.messageId, JSON.stringify(posted.albumIds), bookId)
    .run();

  return 'posted';
}

/** `?posted=` value for the listing page to render. */
export function publishQuery(result: PublishResult): string {
  return result === 'posted' || result === 'updated' ? '1' : result === 'not-live' ? 'draft' : '0';
}
