import type { APIRoute } from 'astro';

export const prerender = false;

/**
 * One candidate cover, fetched by the server and served from our own origin.
 *
 * Not a convenience. Candidate covers are restricted to `img-src 'self'`, so
 * they have to arrive from this origin. (Google's fixed attribution graphic is
 * the narrow CSP exception, not its candidate artwork.)
 *
 * It takes a provider and that provider's **cover id**, never a URL, so it
 * cannot be turned into an open proxy for fetching arbitrary things through
 * the shop's domain.
 */
export const GET: APIRoute = async ({ request, url }) => {
  const provider = url.searchParams.get('provider') ?? 'openlibrary';
  const rawId = url.searchParams.get('id') ?? '';
  let source: string;

  if (provider === 'openlibrary') {
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) return new Response('Bad cover id', { status: 400 });
    // `default=false` makes a missing cover 404 instead of returning Open
    // Library's grey placeholder as though it were real artwork.
    source = `https://covers.openlibrary.org/b/id/${id}-L.jpg?default=false`;
  } else if (provider === 'google') {
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(rawId)) {
      return new Response('Bad cover id', { status: 400 });
    }
    // A documented Google Books content URL, assembled only from a validated
    // volume id. zoom=4 requests the largest practical candidate for review.
    source =
      `https://books.google.com/books/content?id=${encodeURIComponent(rawId)}` +
      '&printsec=frontcover&img=1&zoom=4&source=gbs_api';
  } else {
    return new Response('Bad cover provider', { status: 400 });
  }

  let res: Response;
  try {
    res = await fetch(source, {
      headers: { 'User-Agent': 'assubki-books (shop cover lookup)' },
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]),
    });
  } catch {
    return new Response('Cover service unavailable', { status: 502 });
  }
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
