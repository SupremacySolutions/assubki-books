import type { APIRoute } from 'astro';
import { createOrder, StockConflict, type RequestedItem } from '../../lib/orders';
import { notifyOrderPlaced } from '../../lib/notify';
import { groupForOrder, markGroupSent } from '../../lib/group';

export const prerender = false;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function bad(message: string, status = 400, extra: Record<string, unknown> = {}) {
  return Response.json({ ok: false, error: message, ...extra }, { status });
}

export const POST: APIRoute = async ({ request, url, locals }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return bad('Send a JSON body.');
  }

  const data = body as Record<string, unknown>;

  const name = String(data.name ?? '').trim();
  const email = String(data.email ?? '').trim();
  const phone = String(data.phone ?? '').trim() || null;
  const fulfilment = data.fulfilment === 'collection' ? 'collection' : 'delivery';
  const address = String(data.address ?? '').trim() || null;
  const notes = String(data.notes ?? '').trim() || null;

  if (name.length < 2 || name.length > 120) return bad('Enter your name.');
  if (!EMAIL_RE.test(email) || email.length > 254) return bad('Enter a valid email address.');
  if (fulfilment === 'delivery' && (!address || address.length < 8)) {
    return bad('Enter the address the books should be posted to.');
  }
  if ((notes?.length ?? 0) > 2000) return bad('That note is too long.');

  /*
   * A group order's contents come from the database, not from the browser
   * sending it. The organiser's page cannot see what everyone else added any
   * more recently than its last poll, and the whole point is that the shop
   * receives one request holding all of it.
   */
  const groupCode = String(data.groupCode ?? '').trim();
  const groupOwnerToken = String(data.groupOwnerToken ?? '').trim();
  let group: Awaited<ReturnType<typeof groupForOrder>> = null;

  if (groupCode) {
    // The organiser's key, not the one in the shared link - everybody adding to
    // the basket holds that one, and sending the order is not something they
    // should be able to do under their own name and address.
    group = await groupForOrder(groupCode, groupOwnerToken);
    if (!group) {
      return bad(
        'That group basket has expired, its order has already been sent, or this is not the organiser\'s link.',
        409,
      );
    }
    if (!group.items.length) return bad('That group basket is empty.');
  }

  const rawItems = Array.isArray(data.items) ? data.items : [];
  const items: RequestedItem[] = [];
  for (const raw of rawItems.slice(0, 100)) {
    const bookId = Number((raw as Record<string, unknown>)?.bookId);
    const qty = Number((raw as Record<string, unknown>)?.qty);
    if (!Number.isInteger(bookId) || bookId <= 0) continue;
    if (!Number.isInteger(qty) || qty <= 0 || qty > 99) continue;
    items.push({ bookId, qty });
  }
  if (!group && !items.length) return bad('Your basket is empty.');

  // Merge duplicates so two entries for one book cannot slip past the check.
  const merged = new Map<number, number>();
  for (const item of group ? group.items : items) {
    merged.set(item.bookId, (merged.get(item.bookId) ?? 0) + item.qty);
  }
  const finalItems = [...merged].map(([bookId, qty]) => ({ bookId, qty }));

  // Who wanted what, kept with the order: the shop packs one parcel either way,
  // but the organiser has to hand the books out at the other end.
  const finalNotes = group
    ? [notes, `Group order collected by ${group.organiser}:`, group.breakdown]
        .filter(Boolean)
        .join('\n\n')
        .slice(0, 4000)
    : notes;

  try {
    const order = await createOrder({
      name, email, phone, fulfilment, address, notes: finalNotes, items: finalItems,
    });

    // Closes the group so nobody keeps adding to a basket already sent.
    if (group) await markGroupSent(groupCode, order.ref);

    // Notifications must never cost the customer their order - the books are
    // already held and the confirmation page renders from the database.
    const origin = url.origin;
    const notify = notifyOrderPlaced({ order, name, email, phone, fulfilment, address, notes: finalNotes, origin }).catch(
      (err) => console.error('order notification failed', order.ref, err),
    );
    // `locals.runtime.ctx` was removed in Astro v6; `cfContext` is the
    // ExecutionContext now. If it is unavailable, await rather than drop the
    // notification on the floor.
    const ctx = (locals as { cfContext?: ExecutionContext }).cfContext;
    if (ctx?.waitUntil) ctx.waitUntil(notify);
    else await notify;

    return Response.json({ ok: true, ref: order.ref, token: order.token });
  } catch (err) {
    if (err instanceof StockConflict) {
      return bad(
        'Some titles were taken while you were checking out. Your basket has been updated.',
        409,
        { problems: err.problems },
      );
    }
    console.error('order creation failed', err);
    return bad('Something went wrong creating your request. Please try again.', 500);
  }
};
