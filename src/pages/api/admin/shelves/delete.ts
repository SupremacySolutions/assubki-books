import type { APIRoute } from 'astro';
import { deleteShelf } from '../../../../lib/shelves';
import { forgetCategoryCounts, forgetHomeRows } from '../../../../lib/db';
import { readForm } from '../../../../lib/request-body';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const form = await readForm(request);
  if (!form) return new Response('Bad request', { status: 400 });
  const id = Number.parseInt(String(form.get('id') ?? ''), 10);
  if (!Number.isInteger(id)) {
    return new Response(null, { status: 302, headers: { Location: '/admin/shelves' } });
  }

  const problem = await deleteShelf(id);
  // The trigger has moved the catalogue version; this instance must not go on
  // using the one it read before the change, or the owner's next look at the
  // shelf is the shelf as it was.
  forgetCategoryCounts();
  forgetHomeRows();
  const query = problem ? `?e=${problem}` : '?saved=1';
  return new Response(null, { status: 302, headers: { Location: `/admin/shelves${query}` } });
};
