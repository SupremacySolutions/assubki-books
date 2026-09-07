import type { APIRoute } from 'astro';
import { parseShipment } from '../../../../lib/shipment-parse';
import { createShipment, importLines } from '../../../../lib/shipments';
import { readForm } from '../../../../lib/request-body';

export const prerender = false;

/**
 * A pasted list, turned into a shipment and its books.
 *
 * The parse happens here rather than in the browser so the rows the owner
 * checks over are the rows that were stored - a preview built by different
 * code from the thing it previews is a preview of nothing.
 */
export const POST: APIRoute = async ({ request }) => {
  const form = await readForm(request);
  if (!form) return new Response('Bad request', { status: 400 });
  const title = String(form.get('title') ?? '').trim().slice(0, 160);
  const note = String(form.get('note') ?? '').trim().slice(0, 1000) || null;
  const vague = String(form.get('incoming_vague') ?? '').trim() || null;
  const month = String(form.get('incoming_month') ?? '').trim() || null;
  const list = String(form.get('list') ?? '');

  if (!title) return new Response('A name for the shipment is required', { status: 400 });

  const lines = parseShipment(list);
  const id = await createShipment({ title, note, vague, month });
  const added = await importLines(id, lines, { vague, month });

  /*
   * The count of lines that could not be read travels in the URL so the page
   * can say so plainly.
   *
   * They are stored now, which they were not before: an unreadable line
   * becomes a row carrying its raw text with no price, so it lands in the
   * "needs fixing" filter rather than being discarded with only a number to
   * remember it by. The count still matters - it is the difference between a
   * paste that was wholly understood and one that was not - but it now points
   * at rows the owner can open and finish.
   */
  const unread = lines.filter((line) => !line.title || line.pricePence === null).length;
  return new Response(null, {
    status: 302,
    headers: { Location: `/admin/shipments/${id}?added=${added}&unread=${unread}` },
  });
};
