import type { APIRoute } from 'astro';

export const prerender = false;

/**
 * One candidate cover, fetched by the server and served from our own origin.
 *
 * Not a convenience. The site's CSP is `img-src 'self'`, so a browser here
 * will not load an image from covers.openlibrary.org at all - it has to arrive
 * from this origin or not arrive.
 *
 * It takes a **cover id**, never a URL, so it cannot be turned into an open
 * proxy for fetching arbitrary things through the shop's domain.
 */
export const GET: APIRoute = async ({ url }) => {
  const id = Number(url.searchParams.get('id'));
  if (!Number.isInteger(id) || id <= 0) return new Response('Bad cover id', { status: 400 });

  // `default=false` so a missing cover 404s rather than returning Open
  // Library's grey placeholder, which would otherwise be offered to the owner
  // as though it were a real cover.
  const res = await fetch(`https://covers.openlibrary.org/b/id/${id}-L.jpg?default=false`, {
    headers: { 'User-Agent': 'assubki-books (shop cover lookup)' },
  });
  if (!res.ok) return new Response('No cover', { status: 404 });

  const type = res.headers.get('content-type') ?? '';
  if (!type.startsWith('image/')) return new Response('Not an image', { status: 502 });

  return new Response(res.body, {
    headers: {
      'Content-Type': type,
      // Nothing here is the shop's own image yet; it is a candidate being
      // looked at. Worth a short cache so measuring and then picking it does
      // not fetch it twice, and no longer.
      'Cache-Control': 'private, max-age=300',
    },
  });
};
