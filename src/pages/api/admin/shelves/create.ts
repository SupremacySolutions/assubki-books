import type { APIRoute } from 'astro';
import { createShelf } from '../../../../lib/shelves';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const form = await request.formData();
  const name = String(form.get('name') ?? '').trim();
  const parentRaw = String(form.get('parent') ?? '').trim();
  const parentId = parentRaw ? Number.parseInt(parentRaw, 10) : null;

  if (!name) return new Response(null, { status: 302, headers: { Location: '/admin/shelves' } });

  await createShelf(name, Number.isInteger(parentId) ? parentId : null);
  return new Response(null, { status: 302, headers: { Location: '/admin/shelves?saved=1' } });
};
