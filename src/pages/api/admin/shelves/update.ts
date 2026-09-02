import type { APIRoute } from 'astro';
import { updateShelf } from '../../../../lib/shelves';
import { forgetCategoryCounts, forgetHomeRows } from '../../../../lib/db';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const form = await request.formData();
  const id = Number.parseInt(String(form.get('id') ?? ''), 10);
  const name = String(form.get('name') ?? '').trim();
  const parentRaw = String(form.get('parent') ?? '').trim();
  const parentId = parentRaw ? Number.parseInt(parentRaw, 10) : null;
  if (!Number.isInteger(id) || !name) {
    // The shelf counts are cached for a minute; the owner should see
    // their own change now rather than in a minute.
    forgetCategoryCounts();
  forgetHomeRows();
    return new Response(null, { status: 302, headers: { Location: '/admin/shelves' } });
  }

  const problem = await updateShelf(id, name, Number.isInteger(parentId) ? parentId : null);
  const query = problem ? `?e=${problem}` : '?saved=1';
  return new Response(null, { status: 302, headers: { Location: `/admin/shelves${query}` } });
};
