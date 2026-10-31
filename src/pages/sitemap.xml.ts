import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { imageUrl } from '../lib/format';

/**
 * Generated from the database rather than at build time - the admin publishes
 * books without a rebuild, so a static sitemap would go stale the moment the
 * owner adds a title.
 */
/** `imageUrl` carries `&` between its parameters, which XML will not take bare. */
const xml = (value: string) => value.replace(/&/g, '&amp;');

export const GET: APIRoute = async ({ site, url }) => {
  const origin = (site ?? new URL(url.origin)).origin;

  const [books, categories] = await Promise.all([
    // A part of a set shares its parent's page through a picker, so listing its
    // own address here would offer Google several URLs for one thing to buy.
    // With the cover, for Google Images: a cover is how people recognise the
    // edition they were told to buy, and an image search is a way in. One
    // indexed lookup per book, on a page fetched a few times a day.
    env.DB.prepare(`SELECT b.slug, b.updated_at,
               (SELECT i.image_key FROM book_images i WHERE i.book_id = b.id
                 ORDER BY i.sort, i.id LIMIT 1) AS image_key
          FROM books b
         WHERE b.status = 'live' AND b.deleted_at IS NULL AND b.set_part = 0
         ORDER BY b.slug`).all<{
      slug: string;
      updated_at: number;
      image_key: string | null;
    }>(),
    env.DB.prepare('SELECT path FROM categories ORDER BY path').all<{ path: string }>(),
  ]);

  /*
   * No `priority`. Google has ignored it for many years, and a number nobody
   * reads invites the belief that the shop is steering something.
   *
   * `lastmod` is read, so everything carries one. The static pages take the
   * newest book's date: they list the catalogue, so they genuinely change when
   * it does.
   */
  const newest = Math.max(0, ...books.results.map((b) => b.updated_at));
  const day = (at: number) => new Date(at * 1000).toISOString().slice(0, 10);

  const entry = (loc: string, lastmod: number, image?: string | null) =>
    `  <url><loc>${origin}${loc}</loc><lastmod>${day(lastmod)}</lastmod>` +
    (image ? `<image:image><image:loc>${xml(origin + image)}</image:loc></image:image>` : '') +
    `</url>`;

  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">',
    entry('/', newest),
    entry('/catalogue', newest),
    entry('/about', newest),
    entry('/shipments', newest),
    entry('/preorders', newest),
    entry('/contact', newest),
    // The policy pages were reachable only from the footer. They are what a
    // buyer - and Google's shopping checks - look for before trusting a shop.
    entry('/delivery', newest),
    entry('/returns', newest),
    entry('/terms', newest),
    entry('/privacy', newest),
    ...categories.results.map((c) => entry(`/catalogue/${c.path}`, newest)),
    ...books.results.map((b) =>
      entry(`/book/${b.slug}`, b.updated_at, imageUrl(b.image_key, 'detail')),
    ),
    '</urlset>',
  ].join('\n');

  return new Response(body, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
