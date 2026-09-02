import { env } from 'cloudflare:workers';
import { getSetting } from './settings';

/**
 * Sales, and the discount on a whole order.
 *
 * Two separate things that happen to both reduce a total. A sale is a named
 * set of books each with its own percentage; the order discount is a standing
 * rule about size ("over £85, take 10% off") that runs whether or not a sale
 * is on.
 *
 * The order they apply in is not arbitrary. The threshold is tested against
 * the total *after* the sale, so a basket is never told it qualifies on
 * figures it will not be charged.
 */

export interface LiveSale {
  id: number;
  name: string;
  blurb: string | null;
  /** The largest percentage in the sale. Calculated, never typed. */
  headline: number;
}

export interface OrderDiscount {
  active: boolean;
  /** The order has to reach this, after any sale, before it applies. */
  thresholdPence: number;
  percent: number;
}

/**
 * The sale that is running, if one is.
 *
 * Cached for a minute like the shelf counts, because this is read on the home
 * page, every catalogue page and every book page. Without the cache it is a
 * query on every view of a 225-book shop, which is the shape of thing that
 * cost this project 95% of its read budget once already.
 */
let saleCache: { at: number; value: LiveSale | null } | null = null;

export function forgetSale(): void {
  saleCache = null;
}

export async function liveSale(): Promise<LiveSale | null> {
  const now = Date.now();
  if (saleCache && now - saleCache.at < 60_000) return saleCache.value;

  const row = await env.DB.prepare(
    `SELECT s.id, s.name, s.blurb,
            COALESCE((SELECT MAX(percent_off) FROM sale_items WHERE sale_id = s.id), 0) AS headline
       FROM sales s WHERE s.status = 'live'`,
  ).first<LiveSale>();

  const value = row && row.headline > 0 ? row : null;
  saleCache = { at: now, value };
  return value;
}

/** The standing order discount. Cached with the sale, for the same reason. */
let discountCache: { at: number; value: OrderDiscount } | null = null;

export function forgetOrderDiscount(): void {
  discountCache = null;
}

export async function orderDiscount(): Promise<OrderDiscount> {
  const now = Date.now();
  if (discountCache && now - discountCache.at < 60_000) return discountCache.value;

  const [on, threshold, percent] = await Promise.all([
    getSetting('order_discount_active'),
    getSetting('order_discount_threshold'),
    getSetting('order_discount_percent'),
  ]);

  const value: OrderDiscount = {
    active: on === '1',
    thresholdPence: Math.max(0, Math.round(Number(threshold) * 100) || 0),
    percent: Math.min(90, Math.max(0, Math.round(Number(percent)) || 0)),
  };
  discountCache = { at: now, value };
  return value;
}

/** What a book costs once its sale percentage is taken off. */
export function salePrice(pencePrice: number, percentOff: number | null | undefined): number {
  if (!percentOff || percentOff <= 0) return pencePrice;
  return Math.round((pencePrice * (100 - percentOff)) / 100);
}

export interface BasketLine {
  pricePence: number;
  qty: number;
  percentOff?: number | null;
}

export interface Totals {
  /** What it would all cost at full price. */
  fullPence: number;
  /** After per-book sale percentages, before the order discount. */
  afterSalePence: number;
  saleSavingPence: number;
  qualifies: boolean;
  /** How much more is needed to qualify. Zero once it does. */
  shortByPence: number;
  orderDiscountPence: number;
  subtotalPence: number;
  savedPence: number;
}

/**
 * The whole arithmetic, in one place, in the order it has to happen.
 *
 * Rounded per line and per discount, to the penny - so what the customer adds
 * up on the page is what the order is written for. Postage is not here: it is
 * still added by hand when the owner replies.
 */
export function totals(lines: BasketLine[], discount: OrderDiscount): Totals {
  let fullPence = 0;
  let afterSalePence = 0;

  for (const line of lines) {
    fullPence += line.pricePence * line.qty;
    afterSalePence += salePrice(line.pricePence, line.percentOff) * line.qty;
  }

  const saleSavingPence = fullPence - afterSalePence;

  // Tested after the sale, not before: a basket must never be told it
  // qualifies on a figure it will not be charged.
  const qualifies =
    discount.active && discount.percent > 0 && afterSalePence >= discount.thresholdPence;

  const orderDiscountPence = qualifies
    ? Math.round((afterSalePence * discount.percent) / 100)
    : 0;

  return {
    fullPence,
    afterSalePence,
    saleSavingPence,
    qualifies,
    shortByPence:
      discount.active && discount.percent > 0 && !qualifies
        ? Math.max(0, discount.thresholdPence - afterSalePence)
        : 0,
    orderDiscountPence,
    subtotalPence: afterSalePence - orderDiscountPence,
    savedPence: saleSavingPence + orderDiscountPence,
  };
}
