import type { APIRoute } from 'astro';
import { findCovers } from '../../../../lib/cover-search';

export const prerender = false;

/**
 * Candidate covers for a title.
 *
 * Behind the admin guard because it is an owner's tool, and on the server so
 * the site's `connect-src` does not have to open for a customer-facing page
 * that will never call it.
 */
export const GET: APIRoute = async ({ url }) => {
  const terms = (url.searchParams.get('title') ?? url.searchParams.get('q') ?? '').slice(0, 200);
  const author = (url.searchParams.get('author') ?? '').slice(0, 120);
  const covers = await findCovers(terms, author);
  return Response.json({ terms, author, covers }, { headers: { 'Cache-Control': 'no-store' } });
};
