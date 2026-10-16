import { env } from 'cloudflare:workers';

/**
 * A month of invoices, for the shop's own accounts.
 *
 * An order becomes an invoice when the shop confirms its total - that is the
 * date on the document - so a month is the orders confirmed in it. Cancelled
 * and expired ones are kept in the list and marked, rather than dropped: an
 * invoice number that goes missing from a run is exactly what an accountant
 * asks about.
 *
 * Months are London months, because the shop is in Leicester and an order
 * confirmed at half past midnight on the first belongs to that month, not the
 * one UTC would put it in.
 */
export interface MonthInvoice {
  ref: string;
  status: string;
  customer_name: string;
  email: string;
  fulfilment: string;
  subtotal_pence: number;
  discount_pence: number;
  postage_pence: number;
  total_pence: number;
  confirmed_at: number;
  paid_at: number | null;
  items: number;
}

export function monthBounds(month: string): { start: number; end: number } | null {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  return { start: londonMidnight(y, mo, 1), end: londonMidnight(mo === 12 ? y + 1 : y, mo === 12 ? 1 : mo + 1, 1) };
}

/** Unix seconds for 00:00 London time on a date - BST or GMT as it falls. */
function londonMidnight(y: number, m: number, d: number): number {
  const utc = Date.UTC(y, m - 1, d);
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hourCycle: 'h23' })
      .format(new Date(utc)),
  );
  // London is UTC or one hour ahead, so midnight there is either midnight UTC
  // or 23:00 the evening before.
  return Math.floor(utc / 1000) - (hour === 1 ? 3600 : 0);
}

export function currentMonth(): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit',
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}`;
}

export async function invoicesForMonth(month: string): Promise<MonthInvoice[] | null> {
  const bounds = monthBounds(month);
  if (!bounds) return null;
  const { results } = await env.DB.prepare(
    `SELECT o.ref, o.status, o.customer_name, o.email, o.fulfilment,
            o.subtotal_pence, COALESCE(o.discount_pence, 0) AS discount_pence,
            CASE WHEN o.fulfilment = 'collection' THEN 0 ELSE COALESCE(o.postage_pence, 0) END AS postage_pence,
            o.total_pence, o.confirmed_at, o.paid_at,
            (SELECT COALESCE(SUM(qty), 0) FROM order_items WHERE order_id = o.id) AS items
       FROM orders o
      WHERE o.total_pence IS NOT NULL AND o.confirmed_at >= ?1 AND o.confirmed_at < ?2
      ORDER BY o.confirmed_at, o.id`,
  )
    .bind(bounds.start, bounds.end)
    .all<MonthInvoice>();
  return results;
}

export const PAID_STATUSES = ['paid', 'dispatched', 'completed'];
export const VOID_STATUSES = ['cancelled', 'expired'];

export function invoiceStateOf(r: Pick<MonthInvoice, 'status' | 'paid_at'>): 'paid' | 'due' | 'void' {
  if (VOID_STATUSES.includes(r.status)) return 'void';
  return PAID_STATUSES.includes(r.status) || r.paid_at ? 'paid' : 'due';
}
