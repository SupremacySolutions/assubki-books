import type { APIRoute } from 'astro';
import { moveShelf } from '../../../../lib/shelves';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const form = await request.formData();
  const id = Number.parseInt(String(form.get('id') ?? ''), 10);
  const direction = String(form.get('direction') ?? '') === 'up' ? 'up' : 'down';

  if (Number.isInteger(id)) await moveShelf(id, direction);
  return new Response(null, { status: 302, headers: { Location: '/admin/shelves' } });
};
