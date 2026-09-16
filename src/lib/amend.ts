/**
 * Changing an order that has already been placed: books off it, and books on.
 *
 * A customer asked for three titles to be removed and the shop had no way to
 * do it: the portal offered cancelling the whole order or deleting it, and the
 * removal ended up happening only in the conversation. The order went on
 * holding copies against titles nobody wanted, and the figures the customer
 * had been quoted no longer described what they were buying.
 *
 * The rules live here rather than in the route, for the same reason
 * `cancelRight` does: the portal, the endpoint and the customer's page all have
 * to agree about what may be amended and what an amendment costs, and three
 * copies of that is how they stop agreeing.
 *
 * **Both directions.** Removing came first and was one-way on purpose: adding
 * needs an availability check, a fresh hold, the set pool and the sale price as
 * it stands today, and doing any of those badly oversells the shelf. The answer
 * for a while was that somebody who wants more books places another order - but
 * that hands one customer two references, two holds with different clocks and
 * two postage quotes for one parcel, and the owner ends up doing the arithmetic
 * by hand in the conversation. Which is the gap this module was written to
 * close, from the other side.
 *
 * So adding is here, beside removing, held to the same rules and scaling the
 * same discount. What it does *not* do is decide what may be sold: that is
 * `lib/availability`, the one read checkout uses, so the portal cannot accept a
 * title checkout would refuse.
 */

import { env } from 'cloudflare:workers';
import type { Sellable } from './availability';

/**
 * When an amendment is possible, and why it stops there.
 *
 * Up to payment the copies are held, nothing has moved and the money has not
 * been agreed - so removing a line is book-keeping. Once paid, the copies have
 * left `stock` and, if there is money to give back, that happens outside this
 * site as every other payment does. There is nothing an endpoint could do at
 * that point that would not be a lie about where the copies are.
 *
 * The same two statuses `UNPAID` names in lib/stock-release, deliberately: an
 * order that may be amended is exactly an order whose hold may still be
 * released.
 */
export const AMENDABLE = ['requested', 'awaiting_payment'] as const;

export function canAmend(status: string): boolean {
  return (AMENDABLE as readonly string[]).includes(status);
}

/**
 * Why an amendment was refused, in the words the owner is shown.
 *
 * Both the portal's own check before submitting and the page it lands back on
 * read from here, so a refusal cannot be worded one way in a dialog and another
 * on the page behind it.
 */
export const AMEND_REFUSAL = {
  none: 'Nothing was chosen to come off, so nothing changed.',
  empty:
    'That would empty the order. Removing everything is a cancellation - use Cancel order, which tells them and puts the books back.',
} as const;

/**
 * And why an addition was refused, in the same voice.
 *
 * `gone` is the one that matters. Between the owner opening the picker and
 * pressing the button, a customer can buy the last copy - so the refusal has to
 * read as "somebody else got there", not as a fault, and it has to be the same
 * sentence whether the availability read caught it or a CHECK constraint did.
 */
export const ADD_REFUSAL = {
  none: 'No books were chosen, so nothing was added.',
  gone: 'Those copies are no longer free - somebody else has taken them, or the delivery is no longer open. Nothing was added, and the order is exactly as it was.',
  kind: 'That title cannot go on this order. An order for books on the shelf and a reservation against a delivery are held differently, so each takes books of its own kind.',
} as const;

/** The most the owner may write about why, matching a cancellation note. */
export const NOTE_MAX = 600;

export interface AmendableLine {
  /** `order_items.id` - what the form posts a new quantity against. */
  id: number;
  bookId: number | null;
  title: string;
  pricePence: number;
  qty: number;
  /** A claim on a delivery rather than a copy off the shelf. */
  fromIncoming: number;
}

export interface RemovedLine {
  id: number;
  bookId: number | null;
  title: string;
  pricePence: number;
  /** How many copies come off, which may be fewer than the line holds. */
  qty: number;
  /** What is left on the line, or zero when the whole line goes. */
  remaining: number;
  fromIncoming: number;
}

export interface AmendPlan {
  removed: RemovedLine[];
  /** Every line as it will read afterwards. Empty means the order is emptied. */
  keeping: { title: string; qty: number; pricePence: number }[];
  grossBefore: number;
  grossAfter: number;
  discountBefore: number;
  discountAfter: number;
  subtotalBefore: number;
  subtotalAfter: number;
  /** Nothing was actually taken off. */
  unchanged: boolean;
  /** Everything was taken off, which is a cancellation and not this. */
  empties: boolean;
}

/**
 * What an amendment does to the money.
 *
 * The order discount is *scaled*, not recalculated. Working it out again from
 * the rule as it stands today would mean a customer losing a discount because
 * the shop changed its threshold last week, or gaining one it never offered -
 * and the rule can be switched off entirely, which would silently reprice an
 * order that was already quoted. What the order was actually given is on the
 * order, so what survives is that same deal in proportion to what is left. It
 * is the allocation `createCheckout` already does when one basket becomes
 * several parcels, applied to one order over time instead of several at once.
 *
 * Rounded down, then floored at what is left, so an amendment can never make a
 * discount larger than the books it is taken off.
 */
export function planAmendment(
  lines: AmendableLine[],
  /** New quantity per `order_items.id`. A missing line keeps what it has. */
  wanted: Map<number, number>,
  discountBefore: number,
): AmendPlan {
  const removed: RemovedLine[] = [];
  const keeping: AmendPlan['keeping'] = [];
  let grossBefore = 0;
  let grossAfter = 0;

  for (const line of lines) {
    const asked = wanted.get(line.id);
    // Clamped rather than rejected: a hand-typed 99 on a line of two means
    // "keep both", and a negative means "take them all off". Neither is worth
    // an error page, and neither can reach the database as itself.
    const keep = asked === undefined ? line.qty : Math.min(line.qty, Math.max(0, Math.trunc(asked)));
    const goes = line.qty - keep;

    grossBefore += line.pricePence * line.qty;
    grossAfter += line.pricePence * keep;

    if (goes > 0) {
      removed.push({
        id: line.id,
        bookId: line.bookId,
        title: line.title,
        pricePence: line.pricePence,
        qty: goes,
        remaining: keep,
        fromIncoming: line.fromIncoming,
      });
    }
    if (keep > 0) keeping.push({ title: line.title, qty: keep, pricePence: line.pricePence });
  }

  const discountAfter = scaleDiscount(discountBefore, grossBefore, grossAfter);

  return {
    removed,
    keeping,
    grossBefore,
    grossAfter,
    discountBefore,
    discountAfter,
    subtotalBefore: grossBefore - discountBefore,
    subtotalAfter: grossAfter - discountAfter,
    unchanged: removed.length === 0,
    empties: keeping.length === 0,
  };
}

/**
 * The deal this order was given, in proportion to what it now holds.
 *
 * One function for both directions, which is the whole argument for it: take a
 * book off and put the same book back, and the order is penny for penny where
 * it started. Two rules - scale down on removal, hold still on addition - would
 * mean the order quietly lost a little of its discount every time the owner
 * corrected themselves, and nobody would ever be able to say why.
 *
 * So an addition grows the discount in cash terms. That is deliberate and it is
 * the cost of the rule: the customer keeps the *rate* they were quoted rather
 * than the amount, and books added later share it. The alternative was
 * re-running today's rule over the new basket, which is what neither direction
 * does, for the reason above `planAmendment`.
 *
 * Rounded down, and capped at the gross, so no arrangement of these can hand
 * back more than the books are worth.
 */
export function scaleDiscount(
  discountBefore: number,
  grossBefore: number,
  grossAfter: number,
): number {
  if (grossBefore <= 0 || discountBefore <= 0) return 0;
  return Math.min(grossAfter, Math.floor((discountBefore * grossAfter) / grossBefore));
}

// ---------------------------------------------------------------------------
// Books going on
// ---------------------------------------------------------------------------

/**
 * Whether a title may go on this order, and against which hold.
 *
 * An order is one kind or the other and stays that way. An ordinary order
 * holds copies off the shelf in `reserved` and runs a 48-hour clock; a
 * reservation holds claims on one shipment in `reserved_incoming` and has no
 * clock at all, because the thing it is for does not exist yet. Checkout keeps
 * them apart by splitting a mixed basket into one order per parcel, and this is
 * the same rule at the other end of an order's life: put a claim on a shelf
 * order and it becomes an order that cannot be packed but is still being timed;
 * put a shelf copy on a reservation and it sits on a shelf for a month waiting
 * for a box.
 *
 * So a shelf order takes shelf copies, and a reservation takes claims on its
 * own shipment. A customer who wants the other kind is placing a different
 * order, and that time the answer really is a second order - the shop would
 * have given them one at checkout too.
 *
 * `free` is what the availability read counted, and the endpoint clamps to it.
 * It is a statement about a moment, not a promise: the CHECK constraints and
 * the set-pool trigger are what actually stop an oversell.
 */
/**
 * Whether a reservation's delivery is still taking claims.
 *
 * Only the portal asks, and only to decide whether to offer the panel at all:
 * `howToAdd` and the availability read behind it already refuse a book on a
 * closed shipment, so this changes nothing about what may happen - it changes
 * whether the owner is shown a search box that could only ever come back empty.
 */
export async function shipmentTakingClaims(shipmentId: number): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT status FROM shipments WHERE id = ?`)
    .bind(shipmentId)
    .first<{ status: string }>();
  return row?.status === 'open';
}

export function howToAdd(
  orderShipmentId: number | null,
  book: Sellable,
): { ok: true; fromIncoming: boolean; free: number } | { ok: false; why: 'kind' | 'gone' } {
  const sameKind =
    orderShipmentId === null ? book.shipment_id === null : book.shipment_id === orderShipmentId;
  if (!sameKind) return { ok: false, why: 'kind' };

  const free = orderShipmentId === null ? book.available : book.reservable;
  if (free < 1) return { ok: false, why: 'gone' };

  return { ok: true, fromIncoming: orderShipmentId !== null, free };
}

/**
 * A title the owner has chosen, priced and counted by `lib/availability`.
 *
 * Built by the endpoint from the read checkout uses, never from the form: the
 * request carries an id and a quantity and nothing else that matters. A price
 * that arrived in a POST would be a price the owner's browser chose.
 */
export interface AddCandidate {
  bookId: number;
  title: string;
  /** Today's price, sale applied - what `price_pence_snapshot` will record. */
  pricePence: number;
  /** What it was reduced from, and which sale did it. Recorded as checkout does. */
  fullPricePence: number;
  saleId: number | null;
  qty: number;
  /** A claim on a delivery rather than a copy off the shelf. */
  fromIncoming: boolean;
}

export interface AddedLine extends AddCandidate {
  /**
   * The existing `order_items.id` this joins, or null for a line of its own.
   *
   * Same book, same price, same kind of hold: then it is the line that is
   * already there, with a bigger number on it. Anything else is a new line,
   * and a *different price* is the case that makes this necessary rather than
   * tidy - a title bought at last week's sale price and again at today's are
   * two facts, and one line can only snapshot one of them.
   */
  mergesInto: number | null;
}

export interface AddPlan {
  added: AddedLine[];
  /** Every line as the order will read afterwards, the new ones included. */
  holding: { title: string; qty: number; pricePence: number }[];
  grossBefore: number;
  grossAfter: number;
  discountBefore: number;
  discountAfter: number;
  subtotalBefore: number;
  subtotalAfter: number;
  /** Nothing was actually added. */
  unchanged: boolean;
  /** How many copies in total, which is what the banner counts. */
  copies: number;
}

/**
 * What adding does to the order.
 *
 * The mirror of `planAmendment`, down to sharing its discount rule, and with
 * one thing it does not have: it decides nothing about availability. Every
 * candidate reaching here has already been read out of `lib/availability` and
 * cut to what is free, because the only safe place to compare a quantity
 * against stock is next to the query that counted it.
 *
 * It cannot empty an order and has no equivalent refusal. It can leave one
 * unchanged, which is the same non-event as an amendment that removes nothing.
 */
export function planAddition(
  lines: AmendableLine[],
  adding: AddCandidate[],
  discountBefore: number,
): AddPlan {
  const grossBefore = lines.reduce((n, l) => n + l.pricePence * l.qty, 0);

  const added: AddedLine[] = [];
  for (const candidate of adding) {
    const qty = Math.trunc(candidate.qty);
    if (qty < 1) continue;

    const joins = lines.find(
      (line) =>
        line.bookId === candidate.bookId &&
        line.pricePence === candidate.pricePence &&
        Boolean(line.fromIncoming) === candidate.fromIncoming,
    );
    /*
     * The same title twice in one submission is one line, not two.
     *
     * The picker will not offer it twice, but a form can be posted by hand and
     * two rows for one book at one price would render as a mistake on the
     * customer's order for ever afterwards.
     */
    const already = added.find(
      (line) =>
        line.bookId === candidate.bookId &&
        line.pricePence === candidate.pricePence &&
        line.fromIncoming === candidate.fromIncoming,
    );
    if (already) {
      already.qty += qty;
      continue;
    }

    added.push({ ...candidate, qty, mergesInto: joins?.id ?? null });
  }

  const grossAfter = grossBefore + added.reduce((n, a) => n + a.pricePence * a.qty, 0);
  const discountAfter = scaleDiscount(discountBefore, grossBefore, grossAfter);

  /*
   * What the order holds afterwards, for the message the customer is sent.
   *
   * Built by walking the existing lines and folding each addition into the one
   * it joins, so a line of two that becomes three reads as one line of three -
   * which is what the order itself will say once the batch has run.
   */
  const holding = lines.map((line) => ({
    title: line.title,
    qty: line.qty + added.filter((a) => a.mergesInto === line.id).reduce((n, a) => n + a.qty, 0),
    pricePence: line.pricePence,
  }));
  for (const line of added) {
    if (line.mergesInto === null) {
      holding.push({ title: line.title, qty: line.qty, pricePence: line.pricePence });
    }
  }

  return {
    added,
    holding,
    grossBefore,
    grossAfter,
    discountBefore,
    discountAfter,
    subtotalBefore: grossBefore - discountBefore,
    subtotalAfter: grossAfter - discountAfter,
    unchanged: added.length === 0,
    copies: added.reduce((n, a) => n + a.qty, 0),
  };
}

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

/** A line as it read at the moment it went on or came off. */
export interface ChangedLine {
  title: string;
  qty: number;
  pricePence: number;
}

export interface Amendment {
  at: number;
  removed: ChangedLine[];
  /** What went on. Empty on a removal, and on every row written before 0045. */
  added: ChangedLine[];
  note: string | null;
  subtotalBefore: number;
  subtotalAfter: number;
  totalBefore: number | null;
  totalAfter: number | null;
}

/**
 * Every change made to one order after it was placed, oldest first.
 *
 * Only ever called when `orders.amended_at` says there is one, so an order that
 * has never been changed - which is nearly all of them - costs no read at all.
 */
export async function amendments(orderId: number): Promise<Amendment[]> {
  const { results } = await env.DB.prepare(
    `SELECT at, removed, added, note, subtotal_before, subtotal_after,
            total_before, total_after
       FROM order_amendments WHERE order_id = ? ORDER BY at, id`,
  )
    .bind(orderId)
    .all<{
      at: number; removed: string; added: string | null; note: string | null;
      subtotal_before: number; subtotal_after: number;
      total_before: number | null; total_after: number | null;
    }>();

  return results.map((row) => ({
    at: row.at,
    // Written by this application one statement earlier in its life, but parsed
    // defensively all the same: a record that cannot be read must not take the
    // order's page down with it. Null `added` is not damage - it is every row
    // written before 0045 - and reads as the empty list either way.
    removed: parseLines(row.removed),
    added: parseLines(row.added),
    note: row.note,
    subtotalBefore: row.subtotal_before,
    subtotalAfter: row.subtotal_after,
    totalBefore: row.total_before,
    totalAfter: row.total_after,
  }));
}

function parseLines(raw: string | null): ChangedLine[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === 'object')
      .map((r) => ({
        title: String(r.title ?? 'A title'),
        qty: Number(r.qty) || 1,
        pricePence: Number(r.pricePence) || 0,
      }));
  } catch {
    return [];
  }
}

/**
 * One line of plain English naming some titles. Used by both pages, both ways.
 *
 * Neutral about direction on purpose: "Title A, Title B × 2" is the same
 * sentence whether those books arrived on the order or left it, and the
 * sentence around it says which.
 */
export function lineSummary(lines: ChangedLine[]): string {
  return lines.map((r) => (r.qty > 1 ? `${r.title} × ${r.qty}` : r.title)).join(', ');
}
