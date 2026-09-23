import type { APIRoute } from 'astro';
import { removeShipmentRow, shipmentReturn } from '../../../../../lib/shipments';
import { readForm } from '../../../../../lib/request-body';

export const prerender = false;

/**
 * One title, taken off a shipment.
 *
 * The only way to do this used to be clearing the title in the editor and
 * saving, which nobody would guess, and which an open shipment refused
 * outright - so a title the supplier dropped stayed on the list for customers
 * to reserve. This is the button for it. `removeShipmentRow` decides whether
 * the row can go; this route only reads the form and says what happened.
 */
export const POST: APIRoute = async ({ params, request }) => {
  const shipmentId = Number(params.id);
  if (!Number.isSafeInteger(shipmentId)) return new Response('Bad request', { status: 400 });

  const form = await readForm(request);
  if (!form) return new Response('Bad request', { status: 400 });

  const bookId = Number(form.get('book'));
  if (!Number.isSafeInteger(bookId) || bookId <= 0)
    return shipmentReturn(shipmentId, form, { e: 'Choose a title to remove' });

  const done = await removeShipmentRow(shipmentId, bookId);
  if (!done.ok) return shipmentReturn(shipmentId, form, { e: done.why });
  return shipmentReturn(shipmentId, form, { removed: done.title.slice(0, 60) || 'An untitled row' });
};
