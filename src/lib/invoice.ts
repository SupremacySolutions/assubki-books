import { SITE } from './format';

/**
 * An order, as an invoice.
 *
 * Nothing here is worked out afresh. Every figure is read from what the order
 * already recorded - the price each line was sold at, what multi-buy took off
 * it, the discount, the postage the owner set - because an invoice that does
 * its own arithmetic is a second opinion about the price, and the day it
 * disagrees with the order page is the day a customer asks which one is true.
 * The only sums here are the ones the order itself is made of:
 *
 *   lines (after multi-buy) - discount = subtotal, subtotal + postage = total.
 *
 * The invoice number is the order reference. It is already unique, already on
 * every email and message the customer has had, and a second numbering scheme
 * would be one more thing for the owner to reconcile against the first.
 */

export interface InvoiceSource {
  ref: string;
  status: string;
  customer_name: string;
  email: string;
  phone?: string | null;
  fulfilment: string;
  address: string | null;
  subtotal_pence: number;
  discount_pence?: number | null;
  postage_pence: number | null;
  total_pence: number | null;
  created_at: number;
  confirmed_at: number | null;
  paid_at: number | null;
  items: {
    title_snapshot: string;
    price_pence_snapshot: number;
    qty: number;
    multibuy_pence: number;
  }[];
}

export type InvoiceState =
  /** No total yet: the shop has not confirmed the order, so there is nothing to invoice. */
  | 'pending'
  | 'due'
  | 'paid'
  /** Cancelled or expired. Nothing is owed and the document says so. */
  | 'void';

export interface InvoiceLine {
  title: string;
  qty: number;
  unitPence: number;
  multibuyPence: number;
  amountPence: number;
}

export interface Invoice {
  number: string;
  state: InvoiceState;
  /** When the shop confirmed the total - the date an invoice is issued on. */
  issuedAt: number;
  paidAt: number | null;
  customer: { name: string; email: string; phone: string | null; address: string | null };
  collection: boolean;
  lines: InvoiceLine[];
  linesPence: number;
  discountPence: number;
  subtotalPence: number;
  postagePence: number;
  totalPence: number;
  shop: {
    name: string;
    address: string[];
    email: string;
    phone: string;
    url: string;
  };
}

const PAID = ['paid', 'dispatched', 'completed'];
const VOID = ['cancelled', 'expired'];

export function invoiceFor(order: InvoiceSource): Invoice {
  const lines = order.items.map((i) => ({
    title: i.title_snapshot,
    qty: i.qty,
    unitPence: i.price_pence_snapshot,
    multibuyPence: i.multibuy_pence,
    amountPence: i.price_pence_snapshot * i.qty - i.multibuy_pence,
  }));
  const linesPence = lines.reduce((n, l) => n + l.amountPence, 0);
  const discountPence = order.discount_pence ?? 0;
  const collection = order.fulfilment === 'collection';
  const postagePence = collection ? 0 : (order.postage_pence ?? 0);

  const state: InvoiceState = VOID.includes(order.status)
    ? 'void'
    : PAID.includes(order.status) || order.paid_at
      ? 'paid'
      : order.total_pence === null
        ? 'pending'
        : 'due';

  const a = SITE.address;
  return {
    number: order.ref,
    state,
    issuedAt: order.confirmed_at ?? order.created_at,
    paidAt: order.paid_at,
    customer: {
      name: order.customer_name,
      email: order.email,
      phone: order.phone ?? null,
      address: collection ? null : order.address,
    },
    collection,
    lines,
    linesPence,
    discountPence,
    subtotalPence: order.subtotal_pence,
    postagePence,
    // The recorded total when there is one. Before confirmation there is none,
    // and the document is marked pending rather than showing a guessed postage.
    totalPence: order.total_pence ?? order.subtotal_pence,
    shop: {
      name: SITE.name,
      address: [a.street, a.locality, a.postcode].filter(Boolean),
      email: SITE.email,
      phone: SITE.phone,
      url: SITE.url.replace(/^https?:\/\//, ''),
    },
  };
}

/** A UK date, written out - an invoice is read by people, not parsed. */
export function invoiceDate(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Europe/London',
  });
}
