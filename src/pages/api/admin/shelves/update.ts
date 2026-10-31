import type { APIRoute } from 'astro';
import { updateShelf, currentBlurb, BLURB_MAX } from '../../../../lib/shelves';
import { forgetCategoryCounts, forgetHomeRows } from '../../../../lib/db';
import { readForm } from '../../../../lib/request-body';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const form = await readForm(request);
  if (!form) return new Response('Bad request', { status: 400 });
  const id = Number.parseInt(String(form.get('id') ?? ''), 10);
  const name = String(form.get('name') ?? '').trim();
  const parentRaw = String(form.get('parent') ?? '').trim();
  const parentId = parentRaw ? Number.parseInt(parentRaw, 10) : null;
  // Kept to what a meta description and a paragraph can use. A form posted
  // without the field at all (an older tab) leaves the blurb as it was.
  const blurb = form.has('blurb')
    ? String(form.get('blurb')).replace(/\s+/g, ' ').trim().slice(0, BLURB_MAX) || null
    : undefined;
  if (!Number.isInteger(id) || !name) {
    return new Response(null, { status: 302, headers: { Location: '/admin/shelves' } });
  }

  const problem = await updateShelf(
    id,
    name,
    Number.isInteger(parentId) ? parentId : null,
    blurb === undefined ? await currentBlurb(id) : blurb,
  );
  // The trigger has moved the catalogue version; this instance must not go on
  // using the one it read before the change, or the owner's next look at the
  // shelf is the shelf as it was.
  forgetCategoryCounts();
  forgetHomeRows();
  const query = problem ? `?e=${problem}` : '?saved=1';
  return new Response(null, { status: 302, headers: { Location: `/admin/shelves${query}` } });
};
