import type { APIRoute } from 'astro';
import { softDelete } from '../../../../../lib/book-deletion';

export const prerender = false;

/**
 * Puts a listing in the bin.
 *
 * All of the work - and all of the reasoning about what can and cannot be
 * deferred - is in `lib/book-deletion.ts`. This route is the redirect and the
 * refusal, so that "what deleting means" has one home and is not half-stated in
 * an endpoint and half in a sweep.
 */
export const POST: APIRoute = async ({ params, request, locals }) => {
  const id = Number.parseInt(params.id ?? '', 10);
  if (!Number.isInteger(id)) return new Response('Bad request', { status: 400 });

  const url = new URL(request.url);
  const done = await softDelete(id, locals.admin?.email ?? null);

  if (done === null) {
    return new Response(null, { status: 302, headers: { Location: '/admin/books' } });
  }

  // Copies promised to a live order cannot be deleted out from under it - the
  // customer is still waiting on those books.
  if (done === 'held') {
    return new Response(null, {
      status: 302,
      headers: { Location: `${url.origin}/admin/books/${id}?e=held` },
    });
  }

  /*
   * `deleted-orphan` no longer means "the listing is gone but its post is not".
   * It means the listing is in the bin and its post is still up - which is the
   * same warning to the same person about the same thing, and still the only
   * part of this that cannot be put right from the portal.
   */
  const flag = done.channelCleared ? 'deleted' : 'deleted-orphan';
  const back = new URL('/admin/books', url.origin);
  back.searchParams.set(flag, done.title);
  back.searchParams.set('undo', done.token);

  return new Response(null, { status: 302, headers: { Location: back.pathname + back.search } });
};
