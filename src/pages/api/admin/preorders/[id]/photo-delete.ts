import type { APIRoute } from 'astro';
import { readForm } from '../../../../../lib/request-body';
import { deletePreorderPhoto } from '../../../../../lib/preorders';

export const prerender = false;

/** Removes one photo, files and all. The next one becomes the cover. */
export const POST: APIRoute = async ({ params, request }) => {
  const id = Number.parseInt(params.id ?? '', 10);
  const form = await readForm(request);
  const photoId = Number.parseInt(String(form?.get('photo') ?? ''), 10);
  if (!Number.isInteger(id) || !Number.isInteger(photoId)) return new Response('Bad request', { status: 400 });

  if (!(await deletePreorderPhoto(id, photoId))) {
    return Response.json({ ok: false, error: 'That photo has already gone. Reload the page.' }, { status: 404 });
  }
  return Response.json({ ok: true });
};
