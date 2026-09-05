import type { APIRoute } from 'astro';
import { parseShipment } from '../../../../lib/shipment-parse';
import { createShipment, importLines } from '../../../../lib/shipments';

export const prerender = false;

/**
 * A pasted list, turned into a shipment and its books.
 *
 * The parse happens here rather than in the browser so the rows the owner
 * checks over are the rows that were stored - a preview built by different
 * code from the thing it previews is a preview of nothing.
 */
export const POST: APIRoute = async ({ request }) => {
  const form = await request.formData();
  const title = String(form.get('title') ?? '').trim().slice(0, 160);
  const note = String(form.get('note') ?? '').trim().slice(0, 1000) || null;
  const vague = String(form.get('incoming_vague') ?? '').trim() || null;
  const month = String(form.get('incoming_month') ?? '').trim() || null;
  const list = String(form.get('list') ?? '');

  if (!title) return new Response('A name for the shipment is required', { status: 400 });

  const lines = parseShipment(list);
  const id = await createShipment({ title, note, vague, month });
  const added = await importLines(id, lines);

  /*
   * The count of lines that could not be read travels in the URL so the page
   * can say so plainly. They are not stored - a row with no price is not a
   * book yet - but the owner needs to know the paste was not wholly understood
   * rather than discovering a gap later.
   */
  const unread = lines.length - added;
  return new Response(null, {
    status: 302,
    headers: { Location: `/admin/shipments/${id}?added=${added}&unread=${unread}` },
  });
};
