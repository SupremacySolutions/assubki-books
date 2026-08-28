/**
 * Announcing a listing in the Telegram channel.
 *
 * Lives here rather than in the route so that "save" and "save and post" can
 * share it by calling a function. The alternative — having save redirect to the
 * posting endpoint — turns a POST into a GET, and a GET that posts to a public
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

  const cover = book.images[0] ? imageUrl(book.images[0].image_key) : null;

  const post: ListingPost = {
    title: book.title,
    titleAr: book.title_ar,
    pricePence: book.price_pence,
    blurb: truncate(stripTags(book.description_html), 180) || null,
    available: book.available,
    url: `${origin}/book/${book.slug}`,
    // Telegram fetches the photo itself, so it has to be a public absolute URL.
    imageUrl: cover ? `${origin}${cover}` : null,
  };

  if (book.telegram_message_id) {
    const ok = await editListing(book.telegram_message_id, post);
    return ok ? 'updated' : 'failed';
  }

  const messageId = await postListing(post);
  if (!messageId) return 'failed';

  await env.DB.prepare(
    'UPDATE books SET telegram_message_id = ?, telegram_posted_at = unixepoch() WHERE id = ?',
  )
    .bind(messageId, bookId)
    .run();

  return 'posted';
}

/** `?posted=` value for the listing page to render. */
export function publishQuery(result: PublishResult): string {
  return result === 'posted' || result === 'updated' ? '1' : result === 'not-live' ? 'draft' : '0';
}
