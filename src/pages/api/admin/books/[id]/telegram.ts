import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getBookAdmin } from '../../../../../lib/admin-db';
import { postListing, editListing, type ListingPost } from '../../../../../lib/telegram';
import { imageUrl, stripTags, truncate } from '../../../../../lib/format';

export const prerender = false;

export const POST: APIRoute = async ({ params, url }) => {
  const id = Number.parseInt(params.id ?? '', 10);
  if (!Number.isInteger(id)) return new Response('Bad request', { status: 400 });

  const book = await getBookAdmin(id);
  if (!book) return new Response('No such listing', { status: 404 });

  // Announcing a draft would send customers to a page the shop does not serve.
  if (book.status !== 'live') {
    return new Response(null, { status: 302, headers: { Location: `/admin/books/${id}?posted=0` } });
  }

  const cover = book.images[0] ? imageUrl(book.images[0].image_key) : null;

  const post: ListingPost = {
    title: book.title,
    titleAr: book.title_ar,
    pricePence: book.price_pence,
    blurb: truncate(stripTags(book.description_html), 180) || null,
    available: book.available,
    url: `${url.origin}/book/${book.slug}`,
    // Telegram fetches the photo itself, so it must be a public absolute URL.
    imageUrl: cover ? `${url.origin}${cover}` : null,
  };

  if (book.telegram_message_id) {
    const ok = await editListing(book.telegram_message_id, post);
    return new Response(null, {
      status: 302,
      headers: { Location: `/admin/books/${id}?posted=${ok ? '1' : '0'}` },
    });
  }

  const messageId = await postListing(post);
  if (messageId) {
    await env.DB.prepare(
      'UPDATE books SET telegram_message_id = ?, telegram_posted_at = unixepoch() WHERE id = ?',
    )
      .bind(messageId, id)
      .run();
  }

  return new Response(null, {
    status: 302,
    headers: { Location: `/admin/books/${id}?posted=${messageId ? '1' : '0'}` },
  });
};
