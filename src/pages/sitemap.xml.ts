import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

/**
 * Generated from the database rather than at build time — the admin publishes
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

  const entry = (loc: string, lastmod?: number, priority = '0.6') =>
    `  <url><loc>${origin}${loc}</loc>` +
    (lastmod ? `<lastmod>${new Date(lastmod * 1000).toISOString().slice(0, 10)}</lastmod>` : '') +
    `<priority>${priority}</priority></url>`;

  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    entry('/', undefined, '1.0'),
    entry('/catalogue', undefined, '0.9'),
    entry('/about', undefined, '0.5'),
    entry('/contact', undefined, '0.4'),
    ...categories.results.map((c) => entry(`/catalogue/${c.path}`, undefined, '0.7')),
    ...books.results.map((b) => entry(`/book/${b.slug}`, b.updated_at, '0.8')),
    '</urlset>',
  ].join('\n');

  return new Response(body, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
