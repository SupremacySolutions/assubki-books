/**
 * Taking books off an order that has already been placed.
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
 * **Removing only.** Adding a title to an existing order is a different act -
 * it needs an availability check, a new hold, the set pool and the sale price
 * as it stands today - and doing it badly would oversell the shelf. A customer
 * who wants more books places another order, which is what they already do.
 */

import { env } from 'cloudflare:workers';

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

  const discountAfter =
    grossBefore > 0
      ? Math.min(grossAfter, Math.floor((discountBefore * grossAfter) / grossBefore))
      : 0;

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

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

export interface Amendment {
  at: number;
  removed: { title: string; qty: number; pricePence: number }[];
  note: string | null;
  subtotalBefore: number;
  subtotalAfter: number;
  totalBefore: number | null;
  totalAfter: number | null;
}

/**
 * Every amendment made to one order, oldest first.
 *
 * Only ever called when `orders.amended_at` says there is one, so an order that
 * has never been amended - which is nearly all of them - costs no read at all.
 */
export async function amendments(orderId: number): Promise<Amendment[]> {
  const { results } = await env.DB.prepare(
    `SELECT at, removed, note, subtotal_before, subtotal_after, total_before, total_after
       FROM order_amendments WHERE order_id = ? ORDER BY at, id`,
  )
    .bind(orderId)
    .all<{
      at: number; removed: string; note: string | null;
      subtotal_before: number; subtotal_after: number;
      total_before: number | null; total_after: number | null;
    }>();

  return results.map((row) => ({
    at: row.at,
    // Written by this application one statement earlier in its life, but parsed
    // defensively all the same: a record that cannot be read must not take the
    // order's page down with it.
    removed: parseRemoved(row.removed),
    note: row.note,
    subtotalBefore: row.subtotal_before,
    subtotalAfter: row.subtotal_after,
    totalBefore: row.total_before,
    totalAfter: row.total_after,
  }));
}

function parseRemoved(raw: string): Amendment['removed'] {
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

/** One line of plain English naming what came off. Used by both pages. */
export function removedSummary(removed: Amendment['removed']): string {
  return removed.map((r) => (r.qty > 1 ? `${r.title} × ${r.qty}` : r.title)).join(', ');
}
