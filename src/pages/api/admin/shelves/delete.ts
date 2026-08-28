import type { APIRoute } from 'astro';
import { deleteShelf } from '../../../../lib/shelves';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const form = await request.formData();
  const id = Number.parseInt(String(form.get('id') ?? ''), 10);
  if (!Number.isInteger(id)) {
    return new Response(null, { status: 302, headers: { Location: '/admin/shelves' } });
  }

  const problem = await deleteShelf(id);
  const query = problem ? `?e=${problem}` : '?saved=1';
  return new Response(null, { status: 302, headers: { Location: `/admin/shelves${query}` } });
};
