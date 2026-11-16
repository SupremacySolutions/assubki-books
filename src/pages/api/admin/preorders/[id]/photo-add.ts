import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { readForm } from '../../../../../lib/request-body';
import { addPreorderPhoto, deleteCover, MAX_PHOTOS, storeCover } from '../../../../../lib/preorders';

export const prerender = false;

/**
 * One more photo on a pre-order, with the sized versions the portal cut from
 * it. Saved at once, like a listing's photos - they are not part of the form,
 * so there is nothing for its Save button to carry.
 */
export const POST: APIRoute = async ({ params, request }) => {
  const id = Number.parseInt(params.id ?? '', 10);
  if (!Number.isInteger(id)) return new Response('Bad request', { status: 400 });

  const exists = await env.DB.prepare('SELECT 1 FROM preorders WHERE id = ?').bind(id).first();
  if (!exists) return Response.json({ ok: false, error: 'No such pre-order.' }, { status: 404 });

  const form = await readForm(request);
  if (!form) return new Response('Bad request', { status: 400 });

  const stored = await storeCover(id, form);
  if (!stored) return Response.json({ ok: false, error: 'No photo was sent.' }, { status: 400 });
  if (!stored.ok) {
    const why = {
      storage: 'Photo storage is not configured.',
      size: 'That photo is larger than 8 MB.',
      type: 'Use a JPEG, PNG or WebP.',
    }[stored.why];
    return Response.json({ ok: false, error: why }, { status: 400 });
  }

  if (!(await addPreorderPhoto(id, stored))) {
    await deleteCover(stored.key);
    return Response.json(
      { ok: false, error: `A pre-order can have ${MAX_PHOTOS} photos. Remove one to add another.` },
      { status: 409 },
    );
  }
  return Response.json({ ok: true, key: stored.key });
};
