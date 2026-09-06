import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { createOrder, StockConflict, type RequestedItem } from '../../lib/orders';
import { checkOrder, clean } from '../../lib/validate';
import { formatAddress } from '../../lib/address';
import { takePublicAction } from '../../lib/public-throttle';
import { notifyOrderPlaced } from '../../lib/notify';
import { forgetDashboard } from '../../lib/dashboard';

export const prerender = false;

/**
 * A reservation against a shipment.
 *
 * Its own route rather than a branch inside `/api/orders`, because the two are
 * shaped differently at the edges even though they meet in `createOrder`: this
 * one takes a form rather than JSON, so it works with scripting off; it never
 * touches the basket, so a reservation cannot be mixed with books off the
 * shelf; and it names the shipment, which is what puts the order in the
 * owner's reservations queue and tells the arrival run whom to write to.
 *
 * Everything that decides whether an order is acceptable - the validation, the
 * address formatting, the rate limit, the stock arithmetic and the oversell
 * guards - is the same code the ordinary checkout uses. Only the way the
 * request arrives differs.
 */
export const POST: APIRoute = async ({ request, url }) => {
  const form = await request.formData();
  const shipmentId = Number.parseInt(String(form.get('s') ?? ''), 10);
  if (!Number.isInteger(shipmentId)) return new Response('Bad request', { status: 400 });

  const back = (query: string) =>
    new Response(null, {
      status: 302,
      headers: { Location: `/shipments/checkout?s=${shipmentId}&${query}` },
    });

  /*
   * Still open, read at the moment of the write rather than trusted from the
   * page. A shipment can land between somebody opening the form and sending
   * it, and the copies are then real stock that this route must not claim.
   */
  const shipment = await env.DB.prepare(
    `SELECT status FROM shipments WHERE id = ?`,
  )
    .bind(shipmentId)
    .first<{ status: string }>();
  if (shipment?.status !== 'open') {
    return back('e=' + encodeURIComponent('this shipment is no longer taking reservations'));
  }

  const name = clean(form.get('name'));
  const email = clean(form.get('email'));
  const phone = clean(form.get('phone'));
  const fulfilment = clean(form.get('fulfilment')) || 'delivery';
  const notes = clean(form.get('notes'));
  const parts = {
    line1: clean(form.get('line1')),
    line2: clean(form.get('line2')),
    city: clean(form.get('city')),
    region: clean(form.get('region')),
    postcode: clean(form.get('postcode')),
    country: clean(form.get('country')),
  };

  const problems = checkOrder({ name, email, phone, fulfilment, notes, address: parts });
  if (problems.length) {
    return back('e=' + encodeURIComponent(problems[0].message) + '&' + carry(form));
  }

  /*
   * The quantities, read off `q<bookId>` fields and checked against this
   * shipment. A field naming a book on somebody else's shipment reaches
   * nothing, because the query names both.
   */
  const wanted = new Map<number, number>();
  for (const [field, value] of form.entries()) {
    const found = field.match(/^q(\d+)$/);
    if (!found) continue;
    const qty = Math.max(0, Math.min(99, Math.round(Number(value) || 0)));
    if (qty > 0) wanted.set(Number(found[1]), qty);
  }
  if (!wanted.size) {
    return back('e=' + encodeURIComponent('choose at least one book to reserve'));
  }

  const ids = [...wanted.keys()];
  const { results: mine } = await env.DB.prepare(
    `SELECT id FROM books WHERE shipment_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
  )
    .bind(shipmentId, ...ids)
    .all<{ id: number }>();
  const allowed = new Set(mine.map((b) => b.id));
  const items: RequestedItem[] = [...wanted]
    .filter(([bookId]) => allowed.has(bookId))
    .map(([bookId, qty]) => ({ bookId, qty }));
  if (!items.length) {
    return back('e=' + encodeURIComponent('those books are not on this shipment'));
  }

  const allowance = await takePublicAction('order', request);
  if (allowance.blocked) {
    return back('e=' + encodeURIComponent('too many orders from here just now - try again shortly'));
  }

  try {
    const order = await createOrder({
      name,
      email,
      phone,
      fulfilment: fulfilment === 'collection' ? 'collection' : 'delivery',
      address: fulfilment === 'delivery' ? formatAddress(parts) : null,
      addressParts: fulfilment === 'delivery' ? parts : null,
      notes,
      items,
      shipmentId,
    });

    /*
     * The same announcement an ordinary order makes, and deliberately so - it
     * already words itself differently when every line is a claim, which every
     * line of a reservation is.
     *
     * Caught rather than allowed to throw: a mail provider having a bad minute
     * must not be the difference between a customer seeing their order and
     * seeing an error for an order that was in fact placed. The order is
     * already written by this point, and the owner sees it in the portal
     * whether or not anything was sent.
     */
    await notifyOrderPlaced({
      order,
      name,
      email,
      phone: phone || null,
      fulfilment: fulfilment === 'collection' ? 'collection' : 'delivery',
      address: fulfilment === 'delivery' ? formatAddress(parts) : null,
      notes: notes || null,
      origin: url.origin,
    }).catch(() => {
      /* the order stands either way; the owner sees it in the portal */
    });

    await forgetDashboard();

    return new Response(null, {
      status: 302,
      headers: {
        Location: `/order?ref=${encodeURIComponent(order.ref)}&t=${encodeURIComponent(order.token)}&placed=1`,
      },
    });
  } catch (err) {
    if (err instanceof StockConflict) {
      const first = err.problems[0];
      return back(
        'e=' +
          encodeURIComponent(
            first
              ? `only ${first.available} of ${first.title} left to reserve`
              : 'somebody reserved those while you were deciding',
          ),
      );
    }
    throw err;
  }
};

/** Keeps what was typed in the address bar, so a rejected form is not retyped. */
function carry(form: FormData): string {
  const keep = new URLSearchParams();
  for (const [field, value] of form.entries()) {
    if (/^q\d+$/.test(field) || ['name', 'email', 'phone', 'fulfilment', 'notes',
      'line1', 'line2', 'city', 'region', 'postcode', 'country'].includes(field)) {
      keep.set(field, String(value));
    }
  }
  return keep.toString();
}
