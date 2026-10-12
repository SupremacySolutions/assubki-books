import type { APIRoute } from 'astro';
import { listBooks } from '../lib/db';
import { salePrice } from '../lib/sales';
import { imageUrl, stripTags, truncate, SITE } from '../lib/format';
import { env } from 'cloudflare:workers';

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
/*
 * Built once a day, not once a request, and kept in R2.
 *
 * This is the most expensive read in the shop - the whole catalogue with its
 * details in one go, about 2,500 D1 rows a call - and it is unauthenticated by
 * design, because everything in it is already public on the shop. Those two
 * facts together are the problem: at that price, two thousand requests spend
 * the whole day's allowance and D1 starts refusing every query, which is how
 * the shop went down twice in September.
 *
 * It was cached first, through `read-cache`, and in production that did
 * nothing: two requests three seconds apart came back with different `updated`
 * stamps. `cache.put` "resolves to undefined regardless of whether the cache
 * successfully stored the response", so a store that declines a 271KB body
 * looks exactly like one that took it - which is why the local test passed
 * while the live site still read the database every single time. Everything
 * else kept through `read-cache` is a handful of numbers.
 *
 * So it is stored rather than cached. R2 says whether it kept something, keeps
 * it for every data centre rather than only the one that built it, and is
 * already bound here for the covers. One build a day for the whole world,
 * instead of one per data centre per hour, and no silent failure mode.
 *
 * A day because the site that reads this re-crawls every two days: a daily
 * build is already twice as fresh as anything they collect, and an hourly one
 * would spend reads producing answers nobody comes for. The staleness that
 * costs anything is stock - a book that sells out still reads as available
 * until the next build - and that is tolerable because the link goes to the
 * shop's own page, which tells the truth. A comparison site sends somebody to
 * the listing; it does not sell on their behalf.
 */
const TTL_SECONDS = 86_400;

async function buildCatalogue(origin: string) {
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

  return {
    /* Said out loud so whoever reads this knows what they have, how old it is,
       and where to ask when something looks wrong. `updated` is when the
       catalogue was read, not when it was served - which is the honest answer
       now that the answer is kept for a day. */
    shop: SITE.name,
    url: origin,
    updated: new Date().toISOString(),
    currency: 'GBP',
    count: items.length,
    books: items,
  };
}

interface UploadEnv {
  UPLOADS?: R2Bucket;
}

/* Keyed on the origin: the absolute links inside are built from it, so a copy
   made for one hostname must never be served for another. */
const storedAt = (origin: string) =>
  `catalogue/${origin.replace(/^https?:\/\//, '')}.json`;

export const GET: APIRoute = async ({ site, url }) => {
  const origin = (site ?? new URL(url.origin)).origin;
  const bucket = (env as unknown as UploadEnv).UPLOADS;
  const key = storedAt(origin);

  let body: string | null = null;
  let served: 'stored' | 'built' | 'unstored' = 'built';

  if (bucket) {
    try {
      const kept = await bucket.get(key);
      if (kept) {
        const age = (Date.now() - kept.uploaded.getTime()) / 1000;
        if (age < TTL_SECONDS) {
          body = await kept.text();
          served = 'stored';
        }
      }
    } catch {
      /* A bucket that cannot be read costs a build, not a page. */
    }
  }

  if (body === null) {
    body = JSON.stringify(await buildCatalogue(origin), null, 2);
    if (!bucket) served = 'unstored';
    else {
      try {
        await bucket.put(key, body, {
          httpMetadata: { contentType: 'application/json; charset=utf-8' },
        });
      } catch {
        /* The answer is in hand; failing to keep it costs the next build. */
      }
    }
  }

  return new Response(
    body,
    {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        /* Whether this answer came out of the store or cost a database read.
           The Cache API version failed silently and looked fine from outside;
           this one says which happened. */
        'X-Catalogue': served,
        /* For the client. The copy that actually protects the database is
           the one kept in R2 above. */
        'Cache-Control': `public, max-age=${TTL_SECONDS}`,
        /* Read by other sites by definition, so say so rather than making
           somebody proxy it. */
        'Access-Control-Allow-Origin': '*',
      },
    },
  );
};
