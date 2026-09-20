/**
 * Multi-buy prices: what a book costs when somebody takes more than one.
 *
 * The owner sets any number of offers per book, of two kinds:
 *
 * - a **bundle** - exactly N copies for a total ("20 for £45");
 * - a **from** rate - N or more copies at a price each ("10+ at £2.50 each").
 *
 * Pure on purpose: the book page, the basket and checkout run this in the
 * browser and the server runs it when the order is written, and the two must
 * not be able to come to different figures. Nothing here may import
 * `cloudflare:workers`.
 *
 * Two rules, agreed with the owner:
 *
 * - **It never stacks with a sale.** The offers are prices the owner typed, not
 *   percentages, so the customer pays whichever is cheaper - the sale price or
 *   the multi-buy one - and never a multi-buy price cut again by the sale.
 * - **The cheapest combination wins.** Bundles repeat, and whatever is left is
 *   priced at the best rate the line's *total* quantity qualifies for. 25 copies
 *   with "20 for £45" and "10+ at £2.50" is £45 plus five at £2.50.
 */

export type OfferKind = 'bundle' | 'from';

export interface Offer {
  kind: OfferKind;
  /** Copies in the bundle, or the fewest that earn the rate. At least 2. */
  qty: number;
  /** For a bundle, the total. For a from rate, the price of each copy. */
  pence: number;
}

/** Enough for any real shelf, and a bound on the arithmetic below. */
export const MAX_OFFER_QTY = 999;
export const MAX_OFFERS = 20;

/**
 * The stored column, read forgivingly.
 *
 * Anything malformed is dropped rather than thrown: a bad row must cost the
 * customer a discount, never the page.
 */
export function parseOffers(raw: string | null | undefined | Offer[]): Offer[] {
  if (!raw) return [];
  let data: unknown = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(data)) return [];
  return data
    .filter(
      (o): o is Offer =>
        !!o &&
        (o.kind === 'bundle' || o.kind === 'from') &&
        Number.isInteger(o.qty) &&
        o.qty >= 2 &&
        o.qty <= MAX_OFFER_QTY &&
        Number.isInteger(o.pence) &&
        o.pence > 0,
    )
    .map((o) => ({ kind: o.kind, qty: o.qty, pence: o.pence }));
}

/** Smallest first, bundles before rates at the same size - the order they are shown in. */
export function sortOffers(offers: Offer[]): Offer[] {
  return [...offers].sort((a, b) => a.qty - b.qty || (a.kind === b.kind ? 0 : a.kind === 'bundle' ? -1 : 1));
}

/**
 * Why a set of offers cannot be saved, or null when it can.
 *
 * An offer that is not cheaper than the ordinary price is refused rather than
 * ignored: the card would say "multi-buy discounts available" about a discount
 * that never applies.
 */
export function validateOffers(offers: Offer[], basePence: number): string | null {
  if (offers.length > MAX_OFFERS) return `Up to ${MAX_OFFERS} multi-buy offers per book.`;
  const seen = new Set<string>();
  for (const o of offers) {
    if (!Number.isInteger(o.qty) || o.qty < 2 || o.qty > MAX_OFFER_QTY) {
      return `A multi-buy offer needs a number of copies from 2 to ${MAX_OFFER_QTY}.`;
    }
    if (!Number.isInteger(o.pence) || o.pence <= 0) {
      return 'Every multi-buy offer needs a price above £0.00.';
    }
    const key = `${o.kind}:${o.qty}`;
    if (seen.has(key)) {
      return o.kind === 'bundle'
        ? `There are two offers for exactly ${o.qty} copies - keep one.`
        : `There are two offers for ${o.qty} or more copies - keep one.`;
    }
    seen.add(key);
    if (o.kind === 'bundle' && o.pence >= o.qty * basePence) {
      return `${o.qty} copies for ${gbp(o.pence)} is not less than ${o.qty} at the normal price (${gbp(o.qty * basePence)}).`;
    }
    if (o.kind === 'from' && o.pence >= basePence) {
      return `${gbp(o.pence)} each for ${o.qty} or more is not less than the normal price (${gbp(basePence)}).`;
    }
  }
  return null;
}

/**
 * What `qty` copies cost.
 *
 * `unitPence` is the single-copy price the customer would otherwise pay, with
 * any sale already taken off. The result is never more than `unitPence * qty`.
 */
export function lineCost(qty: number, unitPence: number, offers: Offer[]): number {
  const n = Math.max(0, Math.floor(qty));
  if (n === 0) return 0;
  if (!offers.length) return unitPence * n;

  // The best rate the whole line qualifies for.
  let rate = unitPence;
  for (const o of offers) if (o.kind === 'from' && o.qty <= n && o.pence < rate) rate = o.pence;

  const bundles = offers.filter((o) => o.kind === 'bundle' && o.qty <= n);
  if (!bundles.length) return rate * n;

  // Cheapest way to make up each count from bundles, with singles at `rate`.
  const best = new Array<number>(n + 1);
  best[0] = 0;
  for (let r = 1; r <= n; r++) {
    let cost = best[r - 1] + rate;
    for (const b of bundles) {
      if (b.qty <= r) cost = Math.min(cost, best[r - b.qty] + b.pence);
    }
    best[r] = cost;
  }
  return best[n];
}

/** What multi-buy takes off `qty` copies. Zero when no offer beats the unit price. */
export function multibuySaving(qty: number, unitPence: number, offers: Offer[]): number {
  return Math.max(0, unitPence * qty - lineCost(qty, unitPence, offers));
}

/**
 * The saving on copies *added* to a line that already holds `existing`.
 *
 * The existing copies keep whatever they were quoted; the new ones get exactly
 * the difference their arrival makes at today's offers. Adding three to an
 * order of eight crosses a "10 or more" line, and those three are what pay for
 * crossing it.
 */
export function marginalSaving(
  existing: number,
  added: number,
  unitPence: number,
  offers: Offer[],
): number {
  if (added <= 0) return 0;
  const extra = lineCost(existing + added, unitPence, offers) - lineCost(existing, unitPence, offers);
  return Math.max(0, unitPence * added - extra);
}

/** A line's total, as charged. */
export function lineTotal(line: { pricePence: number; qty: number; multibuyPence?: number | null }): number {
  return line.pricePence * line.qty - (line.multibuyPence ?? 0);
}

function gbp(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}

/** How an offer is named to a customer: "20 copies" / "10+ copies". */
export function offerHeading(offer: Offer): string {
  return offer.kind === 'bundle' ? `${offer.qty} copies` : `${offer.qty}+ copies`;
}

/** What it costs, as the customer reads it: "£45.00" / "£2.50 each". */
export function offerPrice(offer: Offer): string {
  return offer.kind === 'bundle' ? gbp(offer.pence) : `${gbp(offer.pence)} each`;
}

/** What it would cost without the offer, to be struck through. */
export function offerWas(offer: Offer, unitPence: number): string {
  return offer.kind === 'bundle' ? gbp(unitPence * offer.qty) : `${gbp(unitPence)} each`;
}
