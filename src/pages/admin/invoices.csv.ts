import type { APIRoute } from 'astro';
import { invoicesForMonth, invoiceStateOf } from '../../lib/invoice-month';

export const prerender = false;

/**
 * The month as a spreadsheet, for whoever keeps the shop's accounts.
 *
 * Pounds as plain numbers with two places, not "£12.00", so a spreadsheet adds
 * them up rather than treating them as text. A cell that starts with `=`, `+`,
 * `-` or `@` is prefixed with a quote: a customer's name is typed by the
 * customer, and a spreadsheet would otherwise run it as a formula.
 */
const pounds = (p: number) => (p / 100).toFixed(2);
const date = (s: number | null) =>
  s ? new Date(s * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' }) : '';
function cell(v: string | number): string {
  let s = String(v);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const GET: APIRoute = async ({ url }) => {
  const month = url.searchParams.get('month') ?? '';
  const rows = await invoicesForMonth(month);
  if (!rows) return new Response('Ask for a month as YYYY-MM.', { status: 400 });

  const header = [
    'Invoice', 'Date', 'Customer', 'Email', 'Delivery', 'Items',
    'Discount', 'Subtotal', 'Postage', 'Total', 'Status', 'Paid on',
  ];
  const lines = rows.map((r) => {
    const state = invoiceStateOf(r);
    return [
      r.ref, date(r.confirmed_at), r.customer_name, r.email,
      r.fulfilment === 'collection' ? 'Collection' : 'Post', r.items,
      pounds(r.discount_pence), pounds(r.subtotal_pence), pounds(r.postage_pence), pounds(r.total_pence),
      state === 'paid' ? 'Paid' : state === 'void' ? 'Cancelled' : 'Owed', date(r.paid_at),
    ].map(cell).join(',');
  });

  return new Response([header.join(','), ...lines].join('\r\n') + '\r\n', {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="assubki-invoices-${month}.csv"`,
      'Cache-Control': 'private, no-store',
    },
  });
};
