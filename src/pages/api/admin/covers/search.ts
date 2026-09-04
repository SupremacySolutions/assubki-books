import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { searchCovers } from '../../../../lib/cover-search';

export const prerender = false;

/**
 * Candidate covers for a title.
 *
 * Behind the admin guard because it is an owner's tool, and on the server so
 * the site's `connect-src` does not have to open for a customer-facing page
 * that will never call it.
 */
export const GET: APIRoute = async ({ request, url }) => {
  const terms = (url.searchParams.get('title') ?? url.searchParams.get('q') ?? '').slice(0, 200);
  const author = (url.searchParams.get('author') ?? '').slice(0, 120);
  // Validated inside the search, so an unsaved or mistyped one is simply
  // ignored rather than becoming a lookup for somebody else's edition.
  const isbn = (url.searchParams.get('isbn') ?? '').slice(0, 20);
  const coverEnv = env as unknown as { GOOGLE_BOOKS_API_KEY?: string };
  const result = await searchCovers(terms, author, {
    signal: request.signal,
    googleApiKey: coverEnv.GOOGLE_BOOKS_API_KEY,
    isbn,
  });
  return Response.json(
    { terms, author, ...result },
    { headers: { 'Cache-Control': 'no-store' } },
  );
};
