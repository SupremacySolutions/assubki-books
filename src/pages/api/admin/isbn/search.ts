import type { APIRoute } from 'astro';
import { findIsbns } from '../../../../lib/isbn-search';

export const prerender = false;

/**
 * Candidate ISBNs for a title.
 *
 * Behind the admin guard, like the cover search beside it: an owner's tool,
 * and on the server so the site's `connect-src` never has to open for it.
 */
export const GET: APIRoute = async ({ url }) => {
  const terms = (url.searchParams.get('q') ?? '').slice(0, 200);
  const candidates = await findIsbns(terms);
  return Response.json({ terms, candidates }, { headers: { 'Cache-Control': 'no-store' } });
};
