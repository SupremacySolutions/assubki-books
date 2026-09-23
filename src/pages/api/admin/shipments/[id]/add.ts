import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import {
  ADMIN_SHIPMENT_PAGE,
  addShipmentRow,
  getShipment,
  shipmentReturn,
} from '../../../../../lib/shipments';
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
  /* A refusal keeps the form open where the owner left it. */
  const refuse = (why: string) => shipmentReturn(shipmentId, form, { add: 1, e: why });

  const shipment = await getShipment(shipmentId);
  if (!shipment) return new Response('Not found', { status: 404 });
  if (!['draft', 'open'].includes(shipment.status))
    return shipmentReturn(shipmentId, form, { e: 'This shipment is no longer editable' });

  const title = String(form.get('title') ?? '')
    .trim()
    .slice(0, 200);
  const price = Math.round(Number(form.get('price')) * 100);
  const incoming = Math.round(Number(form.get('incoming')));
  const volumes = Math.round(Number(form.get('volumes')) || 0);
  const script = String(form.get('script') ?? 'arabic');

  if (!title) return refuse('The new title needs a name');
  if (!Number.isSafeInteger(price) || price <= 0)
    return refuse('The new title needs a price above nothing');
  if (!Number.isSafeInteger(incoming) || incoming <= 0 || incoming > 999)
    return refuse('The new title needs a number of copies');
  if (!Number.isSafeInteger(volumes) || volumes < 0 || volumes > 200)
    return refuse('That number of volumes is not a number');
  if (!['arabic', 'urdu', 'english'].includes(script))
    return refuse('Choose a language for the new title');

  const id = await addShipmentRow(shipmentId, {
    title,
    price_pence: price,
    incoming,
    /* One volume is a book, not a set - the same rule the save route uses, so
       a row added by hand and a row pasted in read identically afterwards. */
    volumes: volumes > 1 ? volumes : null,
    script,
  });
  if (!id) return shipmentReturn(shipmentId, form, { e: 'This shipment is no longer editable' });

  /*
   * Straight to the new row, with the form still open for the next one.
   *
   * It goes on the end of the list, which on a big shipment is a page the
   * owner is not looking at - so the search and filter are dropped, the page
   * is the last one, and the row is marked. Owners add these in runs while
   * reading down a supplier's message, so the form stays open with the cursor
   * back in the title rather than having to be reopened each time.
   */
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM books WHERE shipment_id = ?')
    .bind(shipmentId)
    .first<{ n: number }>();
  const last = Math.ceil((n?.n ?? 1) / ADMIN_SHIPMENT_PAGE);
  return shipmentReturn(shipmentId, null, {
    page: last > 1 ? last : null,
    add: 1,
    added_one: title.slice(0, 60),
    fresh: id,
  });
};
