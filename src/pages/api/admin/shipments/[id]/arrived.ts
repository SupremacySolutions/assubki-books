import type { APIRoute } from 'astro';
import { getShipment, shipmentItems } from '../../../../../lib/shipments';
import { receiveDelivery, ReceiptConflict } from '../../../../../lib/arrival';
import { env } from 'cloudflare:workers';
import { forgetHomeRows } from '../../../../../lib/db';
import { forgetDashboard } from '../../../../../lib/dashboard';
import { readForm } from '../../../../../lib/request-body';

export const prerender = false;

export const POST: APIRoute = async ({ params, request }) => {
  const shipmentId = Number(params.id);
  const form = await readForm(request);
  if (!form) return new Response('Bad request', { status: 400 });
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
    /*
     * What the owner is owed after pressing the button.
     *
     * "Marked as arrived" on its own leaves the one question a person actually
     * has - what came, what did not, and what there is to do next - to be
     * answered by scrolling three hundred rows. These four figures answer it,
     * and none of them changes how the delivery was recorded: the first three
     * are read off the receipt that was just posted, and the last two off the
     * shipment as it now stands.
     */
    const expected = new Map(books.map((b) => [b.id, b.incoming]));
    let full = 0, short = 0, missing = 0;
    for (const line of lines) {
      const due = expected.get(line.bookId) ?? 0;
      if (due === 0) continue;
      if (line.qty === 0) missing++;
      else if (line.qty < due) short++;
      else full++;
    }
    const after = await env.DB.prepare(
      `SELECT COALESCE(SUM(reserved_incoming),0) AS waiting,
              COALESCE(SUM(CASE WHEN incoming = 0 THEN MAX(0, stock - reserved) ELSE 0 END),0) AS spare
         FROM books WHERE shipment_id = ?`,
    ).bind(shipmentId).first<{ waiting: number; spare: number }>();
    const figures = new URLSearchParams({
      arrived: String(result.orderIds.length),
      full: String(full),
      short: String(short),
      missing: String(missing),
      waiting: String(after?.waiting ?? 0),
      spare: String(after?.spare ?? 0),
    });
    return back(`?${figures}`);
  } catch (err) {
    if (!(err instanceof ReceiptConflict)) throw err;
    return back('?e='+encodeURIComponent(err.message));
  }
};
