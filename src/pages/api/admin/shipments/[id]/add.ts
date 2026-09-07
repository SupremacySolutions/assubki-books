import type { APIRoute } from 'astro';
import { addShipmentRow, getShipment } from '../../../../../lib/shipments';
import { readForm } from '../../../../../lib/request-body';

export const prerender = false;

/**
 * One title, added by hand.
 *
 * The parser drops lines it cannot read and reports them as a count. A count
 * of things the owner cannot recover is worse than no count, so this is the
 * way back: the same four fields a parsed line carries, filled in by the
 * person who has the supplier's message in front of them.
 */
export const POST: APIRoute = async ({ params, request }) => {
  const shipmentId = Number(params.id);
  if (!Number.isSafeInteger(shipmentId)) return new Response('Bad request', { status: 400 });

  const form = await readForm(request);
  if (!form) return new Response('Bad request', { status: 400 });
  const back = (query: string) =>
    new Response(null, {
      status: 302,
      headers: { Location: `/admin/shipments/${shipmentId}${query}` },
    });

  const shipment = await getShipment(shipmentId);
  if (!shipment) return new Response('Not found', { status: 404 });
  if (!['draft', 'open'].includes(shipment.status))
    return back('?e=' + encodeURIComponent('This shipment is no longer editable'));

  const title = String(form.get('title') ?? '')
    .trim()
    .slice(0, 200);
  const price = Math.round(Number(form.get('price')) * 100);
  const incoming = Math.round(Number(form.get('incoming')));
  const volumes = Math.round(Number(form.get('volumes')) || 0);
  const script = String(form.get('script') ?? 'arabic');

  if (!title) return back('?e=' + encodeURIComponent('The new title needs a name'));
  if (!Number.isSafeInteger(price) || price <= 0)
    return back('?e=' + encodeURIComponent('The new title needs a price above nothing'));
  if (!Number.isSafeInteger(incoming) || incoming <= 0 || incoming > 999)
    return back('?e=' + encodeURIComponent('The new title needs a number of copies'));
  if (!Number.isSafeInteger(volumes) || volumes < 0 || volumes > 200)
    return back('?e=' + encodeURIComponent('That number of volumes is not a number'));
  if (!['arabic', 'urdu', 'english'].includes(script))
    return back('?e=' + encodeURIComponent('Choose a language for the new title'));

  const id = await addShipmentRow(shipmentId, {
    title,
    price_pence: price,
    incoming,
    /* One volume is a book, not a set - the same rule the save route uses, so
       a row added by hand and a row pasted in read identically afterwards. */
    volumes: volumes > 1 ? volumes : null,
    script,
  });
  if (!id) return back('?e=' + encodeURIComponent('This shipment is no longer editable'));
  return back('?added_one=' + encodeURIComponent(title.slice(0, 60)));
};
