import type { APIRoute } from 'astro';
import { createOrder, StockConflict, type RequestedItem } from '../../lib/orders';
import { notifyOrderPlaced } from '../../lib/notify';
import { groupForOrder, markGroupSent, claimGroup, releaseGroup } from '../../lib/group';
import { checkOrder, clean, type Field } from '../../lib/validate';
import { formatAddress } from '../../lib/address';
import { forgetDashboard } from '../../lib/dashboard';
import { takePublicAction } from '../../lib/public-throttle';

export const prerender = false;

function bad(message: string, status = 400, extra: Record<string, unknown> = {}) {
  return Response.json({ ok: false, error: message, ...extra }, { status });
}

/**
 * A refusal the page can put under the field it belongs to.
 *
 * One shared error box at the foot of a form makes the customer hunt for what
 * they got wrong; naming the field lets the page mark it and put the cursor
 * there.
 */
function badField(field: Field, message: string) {
  return Response.json({ ok: false, error: message, field }, { status: 400 });
}

export const POST: APIRoute = async ({ request, url, locals }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return bad('Send a JSON body.');
  }

  const data = body as Record<string, unknown>;

  const name = clean(data.name);
  const email = clean(data.email);
  const phone = clean(data.phone);
  // Not coerced. An unrecognised value used to become a delivery silently,
  // which is a stranger's books posted to nowhere rather than an error.
  const fulfilment = clean(data.fulfilment);
  const paymentPreference = clean(data.paymentPreference);
  const notes = clean(data.notes);

  const parts = {
    line1: clean(data.line1),
    line2: clean(data.line2),
    city: clean(data.city),
    region: clean(data.region),
    postcode: clean(data.postcode),
    country: clean(data.country),
  };

  // The same rules the page just applied - it is the server that decides.
  const problems = checkOrder({
    name, email, phone, fulfilment, paymentPreference, notes, address: parts,
  });
  if (problems.length) return badField(problems[0].field, problems[0].message);

  // The block every page and email already reads, written from the parts.
  const address = fulfilment === 'delivery' ? formatAddress(parts) : null;

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

  /*
   * One address, twelve orders an hour - checked here, where the cost is.
   *
   * Placing an order reserves stock, makes work for the owner and sends email
   * or Telegram traffic, and none of it had a limit: a script could take the
   * catalogue out of stock and fill the shop's inbox in one pass.
   *
   * Counted at this point rather than on arrival, because everything above is
   * validation - a malformed request reserves nothing, notifies nobody and
   * costs a 400. Charging those against the allowance only meant a customer
   * correcting a postcode four times was closer to being locked out than a
   * script sending well-formed junk.
   */
  const allowance = await takePublicAction('order', request);
  if (allowance.blocked) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: 'That is a lot of orders at once. Please give it a few minutes, or message the shop.',
      }),
      {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': String(allowance.retryAfter) },
      },
    );
  }

  /*
   * Take the group before making anything.
   *
   * Reading that it was unsent and writing the reference afterwards left a
   * window: two submissions - a double tap, or a retry after a slow reply -
   * both passed the read and both produced a real order holding real stock.
   * One statement decides it now, and the loser is told the truth.
   */
  if (group) {
    const mine = await claimGroup(groupCode);
    if (!mine) {
      return bad(
        'That group basket has already been sent. Check your email for the confirmation.',
        409,
      );
    }
  }

  try {
    const order = await createOrder({
      name,
      email,
      phone: phone || null,
      fulfilment: fulfilment as 'delivery' | 'collection',
      address,
      addressParts: fulfilment === 'delivery' ? parts : null,
      paymentPreference: paymentPreference || null,
      notes: finalNotes,
      items: finalItems,
    });

    // A new order is one more thing for the owner to do, and the dashboard
    // says how many. Without this it says the old number for another minute.
    forgetDashboard();

    // The claim becomes the real reference, so the basket names its order.
    if (group) await markGroupSent(groupCode, order.ref);

    // Notifications must never cost the customer their order - the books are
    // already held and the confirmation page renders from the database.
    const origin = url.origin;
    const notify = notifyOrderPlaced({
      order, name, email, phone: phone || null,
      fulfilment: fulfilment as 'delivery' | 'collection',
      address, paymentPreference: paymentPreference || null, notes: finalNotes, origin,
    }).catch(
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
    /*
     * No order was made, so the group must go back to being unsent - otherwise
     * a stock conflict on one title would strand the basket as "already sent"
     * and the organiser could never submit it at all.
     */
    if (group) await releaseGroup(groupCode).catch(() => {});

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
