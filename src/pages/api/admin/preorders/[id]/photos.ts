import type { APIRoute } from 'astro';
import { readForm } from '../../../../../lib/request-body';
import { reorderPreorderPhotos } from '../../../../../lib/preorders';

export const prerender = false;

/**
 * The order of a pre-order's photos, as the owner dragged them. The first is
 * the cover. Every photo it has, in the new order - see
 * `reorderPreorderPhotos` for why a partial list is refused.
 */
export const POST: APIRoute = async ({ params, request }) => {
  const id = Number.parseInt(params.id ?? '', 10);
  if (!Number.isInteger(id)) return new Response('Bad request', { status: 400 });

  const form = await readForm(request);
  if (!form) return new Response('Bad request', { status: 400 });
  const order = String(form.get('order') ?? '')
    .split(',')
    .map((part) => Number.parseInt(part, 10));
  if (!order.length || order.some((n) => !Number.isInteger(n))) {
    return new Response('Bad request', { status: 400 });
  }

  if ((await reorderPreorderPhotos(id, order)) === 'stale') {
    return Response.json(
      { ok: false, error: 'The photos changed since this page was opened. Reload it and try again.' },
      { status: 409 },
    );
  }
  return Response.json({ ok: true, cover: order[0] });
};
