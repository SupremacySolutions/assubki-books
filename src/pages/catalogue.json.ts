import type { APIRoute } from 'astro';
import { listBooks } from '../lib/db';
import { salePrice } from '../lib/sales';
import { imageUrl, stripTags, truncate, SITE } from '../lib/format';

export const prerender = false;

/**
 * The catalogue, for the sites that list shops side by side.
 *
 * Kitaab Finder and the ones like it read a shop by scraping it, because most
 * Islamic bookshops run Shopify and `/products.json` is already there. This
 * shop does not, so there was nothing for that tooling to take, and the
 * alternative was somebody writing a scraper against pages that change.
 *
 * So the shop says it plainly instead. One request, every live title, in the
 * shape those sites already store: title, author, publisher, image, price,
 * link and whether it is in stock. Deliberately not named after any one of
 * them - a second aggregator asks for the same thing, and a `kitaabfinder.json`
 * would either be a lie or a copy.
 *
 * **The price and the stock are the ones the shop itself shows.** `salePrice`
 * is the function the card and the checkout use, and `available` is
 * `stock - reserved`, so a copy somebody is holding is not offered here as
 * free. A feed that works out its own numbers is how a comparison site comes
 * to advertise a price the shop will not honour.
 *
 * `url` is the key. It is what these sites re-crawl against - their own note
 * says it is "the only identifier that is stable across re-crawls" - so it is
 * the full canonical link to the book, and it does not change when a title is
 * edited.
 */
export const GET: APIRoute = async ({ site, url }) => {
  const origin = (site ?? new URL(url.origin)).origin;

  /*
   * The whole catalogue, not a page of it. `withDetails` is what carries the
   * author and the publisher; without it this would publish a blank where the
   * two fields people search by should be.
   */
  const { books } = await listBooks({ perPage: 1000, withTotal: false, withDetails: true });

  const items = books.map((b) => {
    const pence = salePrice(b.price_pence, b.sale_percent);
    const image = imageUrl(b.image_key, 'detail');
    return {
      id: b.id,
      title: b.title,
      /* The Arabic or Urdu title where the shop has one. Not every reader
         searches in English, and this is the only place a catalogue site could
         learn the other name. */
      nativeTitle: b.title_ar ?? b.title_ur ?? null,
      author: b.author?.trim() || null,
      publisher: b.publisher?.trim() || null,
      image: image ? new URL(image, origin).toString() : null,
      /* Pounds, as a number, with the currency named rather than assumed. */
      price: Number((pence / 100).toFixed(2)),
      currency: 'GBP',
      url: new URL(`/book/${b.slug}`, origin).toString(),
      source: SITE.name,
      instock: b.available > 0,
      isbn: b.isbn ?? null,
      description: truncate(stripTags(b.description_html ?? '') || b.title, 600),
    };
  });

  return new Response(
    JSON.stringify(
      {
        /* Said out loud so whoever reads this knows what they have, how old it
           is, and where to ask when something looks wrong. */
        shop: SITE.name,
        url: origin,
        updated: new Date().toISOString(),
        currency: 'GBP',
        count: items.length,
        books: items,
      },
      null,
      2,
    ),
    {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        /* An hour, like the sitemap and the product feed beside it. These sites
           re-crawl daily at most; this only stops one of them pulling the whole
           catalogue over and over in a minute. */
        'Cache-Control': 'public, max-age=3600',
        /* Read by other sites by definition, so say so rather than making
           somebody proxy it. */
        'Access-Control-Allow-Origin': '*',
      },
    },
  );
};
