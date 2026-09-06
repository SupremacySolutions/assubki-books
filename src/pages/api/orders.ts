import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { createOrder, StockConflict, type RequestedItem } from '../../lib/orders';
import { releaseHold } from '../../lib/stock-release';
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

  /*
   * The claim is only reversible before the order exists.
   *
   * Everything below used to sit in one try/catch whose handler released the
   * group - including the steps that run *after* `createOrder` has committed.
   * A transient failure in marking the basket sent therefore returned a 500
   * with a real order already placed and the group reopened, so the organiser
   * retried and bought everything twice.
   */
  /*
   * A basket holding both kinds becomes more than one order.
   *
   * Books off the shelf can be packed this afternoon and are held for 48
   * hours. Books on a shipment cannot be packed until a box arrives, and carry
   * no clock until it does. As a single order those promises cannot both be
   * kept: the order took the shelf half's stock and then, because it also held
   * a claim, was given no expiry - so the copies sat off the market until the
   * shipment landed, months later, with nothing able to release them.
   *
   * So they are split, one order per shipment plus one for the shelf, sharing
   * a token so the pages can show them together. Each then gets the promise
   * that is actually true of it.
   */
  const shipmentOf = new Map<number, number | null>();
  if (finalItems.length) {
    const holes = finalItems.map(() => '?').join(',');
    const { results } = await env.DB.prepare(
      `SELECT id, shipment_id FROM books WHERE id IN (${holes})`,
    )
      .bind(...finalItems.map((i) => i.bookId))
      .all<{ id: number; shipment_id: number | null }>();
    for (const row of results) shipmentOf.set(row.id, row.shipment_id);
  }

  /* The shelf first, then each shipment, so the order the customer lands on
     is the one that actually moves today. */
  const parcels = new Map<number | null, typeof finalItems>();
  for (const item of finalItems) {
    const key = shipmentOf.get(item.bookId) ?? null;
    parcels.set(key, [...(parcels.get(key) ?? []), item]);
  }
  const groups = [...parcels.entries()].sort((a, b) =>
    a[0] === null ? -1 : b[0] === null ? 1 : a[0] - b[0],
  );

  /*
   * Shared only when there is something to share. A single-parcel checkout is
   * the ordinary case and should look exactly as it always did.
   */
  const splitGroup = groups.length > 1 ? crypto.randomUUID().slice(0, 12) : null;

  const placed: Awaited<ReturnType<typeof createOrder>>[] = [];
  let order: Awaited<ReturnType<typeof createOrder>>;
  try {
    for (const [shipmentId, groupItems] of groups) {
      placed.push(
        await createOrder({
          name,
          email,
          phone: phone || null,
          fulfilment: fulfilment as 'delivery' | 'collection',
          address,
          addressParts: fulfilment === 'delivery' ? parts : null,
          paymentPreference: paymentPreference || null,
          notes: finalNotes,
          items: groupItems,
          shipmentId: shipmentId ?? undefined,
          splitGroup,
        }),
      );
    }
    order = placed[0];

  } catch (err) {
    // Nothing was committed, so the basket goes back to being unsent.
    if (group) await releaseGroup(groupCode).catch(() => {});

    /*
     * A later parcel failing must not leave the earlier ones standing.
     *
     * The customer pressed one button and got a stock conflict; being told
     * that, while quietly holding half of what they asked for, is worse than
     * either outcome. Undone in the same way a cancellation is, so the stock
     * and the ledger end up where they would have.
     */
    for (const made of placed) {
      await env.DB.batch([
        ...releaseHold(made.id, 'split checkout could not be completed'),
        env.DB.prepare(
          `UPDATE orders SET status = 'cancelled', updated_at = unixepoch() WHERE id = ?`,
        ).bind(made.id),
      ]).catch((e) => console.error('could not undo half a split checkout', made.ref, e));
    }

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

  /*
   * From here the order exists, and nothing may reopen the group.
   *
   * Every step below is bookkeeping around an order the customer has already
   * placed: failing one of them must not lose it, and must not invite a second.
   */

    // A new order is one more thing for the owner to do, and the dashboard
    // says how many. Without this it says the old number for another minute.
    forgetDashboard();

    /*
     * The claim becomes the real reference, so the basket names its order.
     *
     * Swallowed rather than thrown: the order is placed. A basket left holding
     * the claim still reads as sent - which is the safe direction - and the
     * worst case is a group that does not name its order, not a customer
     * charged twice.
     */
    if (group) {
      await markGroupSent(groupCode, order.ref).catch((err) =>
        console.error('group left claimed but unmarked', groupCode, order.ref, err),
      );
    }

    // Notifications must never cost the customer their order - the books are
    // already held and the confirmation page renders from the database.
    const origin = url.origin;
    /*
     * One confirmation per order, because they say genuinely different things:
     * one names a 48-hour hold and a parcel that can go out this week, the
     * other says nothing runs out while you wait and the seven days start when
     * the shipment lands. A single message covering both would have to hedge
     * every sentence.
     */
    const notify = Promise.all(
      placed.map((made) =>
        notifyOrderPlaced({
          order: made, name, email, phone: phone || null,
          fulfilment: fulfilment as 'delivery' | 'collection',
          address, paymentPreference: paymentPreference || null, notes: finalNotes, origin,
        }).catch((err) => console.error('order notification failed', made.ref, err)),
      ),
    );
    // `locals.runtime.ctx` was removed in Astro v6; `cfContext` is the
    // ExecutionContext now. If it is unavailable, await rather than drop the
    // notification on the floor.
    const ctx = (locals as { cfContext?: ExecutionContext }).cfContext;
    if (ctx?.waitUntil) ctx.waitUntil(notify);
    else await notify;

    return Response.json({
      ok: true,
      ref: order.ref,
      token: order.token,
      /* Everything this checkout produced, so the page can name the rest. */
      orders: placed.map((o) => ({ ref: o.ref, token: o.token })),
    });
};
