import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

/**
 * Generated from the database rather than at build time - the admin publishes
 * books without a rebuild, so a static sitemap would go stale the moment the
 * owner adds a title.
 */
export const GET: APIRoute = async ({ site, url }) => {
  const origin = (site ?? new URL(url.origin)).origin;

  const [books, categories] = await Promise.all([
    env.DB.prepare(`SELECT slug, updated_at FROM books WHERE status = 'live' ORDER BY slug`).all<{
      slug: string;
      updated_at: number;
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

  const entry = (loc: string, lastmod: number) =>
    `  <url><loc>${origin}${loc}</loc><lastmod>${day(lastmod)}</lastmod></url>`;

  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    entry('/', newest),
    entry('/catalogue', newest),
    entry('/about', newest),
    entry('/contact', newest),
    ...categories.results.map((c) => entry(`/catalogue/${c.path}`, newest)),
    ...books.results.map((b) => entry(`/book/${b.slug}`, b.updated_at)),
    '</urlset>',
  ].join('\n');

  return new Response(body, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
