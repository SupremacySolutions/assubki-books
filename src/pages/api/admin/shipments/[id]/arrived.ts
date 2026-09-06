import type { APIRoute } from 'astro';
import { getShipment, shipmentItems } from '../../../../../lib/shipments';
import { receiveDelivery, ReceiptConflict } from '../../../../../lib/arrival';
import { forgetHomeRows } from '../../../../../lib/db';
import { forgetDashboard } from '../../../../../lib/dashboard';

export const prerender = false;

export const POST: APIRoute = async ({ params, request }) => {
  const shipmentId = Number(params.id);
  const form = await request.formData();
  const key = String(form.get('receipt_key') ?? '');
  const version = Number(form.get('delivery_version'));
  if (!Number.isSafeInteger(shipmentId) || !/^[\w-]{16,80}$/.test(key) ||
      !form.has('delivery_version') || !Number.isSafeInteger(version) || version < 0) {
    return new Response('Reload the shipment before recording a delivery.', {status:400});
  }
  const shipment = await getShipment(shipmentId);
  if (!shipment) return new Response('Not found', {status:404});
  const back = (query: string) => new Response(null, {status:302,headers:{Location:`/admin/shipments/${shipmentId}${query}`}});
  const books = await shipmentItems(shipmentId);
  const lines = books.map(b=>({bookId:b.id,qty:Number(form.get(`received_${b.id}`))}));
  if (lines.some(l=>!form.has(`received_${l.bookId}`) || !Number.isSafeInteger(l.qty) || l.qty<0 || l.qty>999)) {
    return back('?e='+encodeURIComponent('Enter the actual received count for every title, including zero for missing books'));
  }
  if (!lines.some(line => line.qty > 0)) {
    return back('?e=' + encodeURIComponent('Enter at least one received copy to record a delivery.'));
  }
  try {
    const result = await receiveDelivery({shipmentId,key,version,lines});
    forgetHomeRows();
    forgetDashboard();
    return back(`?arrived=${result.orderIds.length}`);
  } catch (err) {
    if (!(err instanceof ReceiptConflict)) throw err;
    return back('?e='+encodeURIComponent(err.message));
  }
};
