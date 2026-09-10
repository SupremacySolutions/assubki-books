import type { APIRoute } from 'astro';
import { restore } from '../../../../../lib/book-deletion';

export const prerender = false;

/**
 * Takes a listing back out of the bin.
 *
 * Its own route rather than a branch of the bulk undo, because it is reached a
 * different way: the undo banner is a token that expires after a day, while this
 * is a listing sitting in a list with a month on the clock, and the owner
 * pressing it has the listing in front of them rather than a memory of an action.
 */
export const POST: APIRoute = async ({ params, request }) => {
  const id = Number.parseInt(params.id ?? '', 10);
  if (!Number.isInteger(id)) return new Response('Bad request', { status: 400 });

  const url = new URL(request.url);
  const back = new URL('/admin/books', url.origin);
  const done = await restore(id);

  // Already restored, already purged, or never there. All three mean the same
  // thing to the owner - it is not in the bin - and the bin itself shows that.
  if (!done) {
    back.searchParams.set('filter', 'deleted');
    back.searchParams.set('e', 'gone');
    return new Response(null, { status: 302, headers: { Location: back.pathname + back.search } });
  }

  back.searchParams.set('filter', 'deleted');
  back.searchParams.set('restored', done.title);
  return new Response(null, { status: 302, headers: { Location: back.pathname + back.search } });
};
