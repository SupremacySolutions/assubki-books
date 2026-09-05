import type { APIRoute } from 'astro';
import { openShipment, closeShipment } from '../../../../../lib/shipments';

export const prerender = false;

/** Opening a shipment to customers, or putting an arrived one away. */
export const POST: APIRoute = async ({ params, request }) => {
  const id = Number.parseInt(params.id ?? '', 10);
  if (!Number.isInteger(id)) return new Response('Bad request', { status: 400 });

  const form = await request.formData().catch(() => null);
  const back = (query: string) =>
    new Response(null, { status: 302, headers: { Location: `/admin/shipments/${id}${query}` } });

  if (form?.get('action') === 'close') {
    await closeShipment(id);
    return back('?closed=1');
  }

  const result = await openShipment(id);
  return result.ok ? back('?opened=1') : back(`?e=${encodeURIComponent(result.why ?? 'no')}`);
};
