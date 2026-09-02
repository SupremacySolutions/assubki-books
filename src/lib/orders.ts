/**
 * Order requests.
 *
 * An order here is a *request to buy*, not a sale. No money moves. What the
 * request does is put a 48-hour hold on the copies so the owner can arrange
 * payment over Telegram without someone else taking the same book.
 */

import { env } from 'cloudflare:workers';
import { whenText } from './incoming';
import { salePrice, orderDiscount, totals } from './sales';
import { releaseHold } from './stock-release';
import type { AddressParts } from './address';

export const HOLD_HOURS = 48;

/** No 0/O/1/I - these get read aloud and typed back over Telegram. */
const REF_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export interface RequestedItem {
  bookId: number;
  qty: number;
}

export interface OrderInput {
  name: string;
  email: string;
  phone?: string | null;
  fulfilment: 'delivery' | 'collection';
  /** The formatted block, which is what every page and email reads. */
  address?: string | null;
  /** The same address in parts, for labels and customs forms. */
  addressParts?: AddressParts | null;
  /** What the customer said they would rather do: 'transfer' or 'cash'. */
  paymentPreference?: string | null;
  notes?: string | null;
  items: RequestedItem[];
}

export interface CreatedOrder {
  ref: string;
  token: string;
  subtotalPence: number;
  /**
   * When the hold lapses, or null for an order waiting on a delivery.
   *
   * A reservation cannot be given 48 hours to complete: the thing it is for
   * does not exist yet. Null keeps it out of the expiry sweep, which is already
   * written to skip it - see the WHERE clause in expireStaleHolds.
   */
  expiresAt: number | null;
  /** Roughly when the delivery is due, for an order that is waiting on one. */
  waitingWhen: string | null;
  /** Carried over from an earlier order by the same customer, if any. */
  telegramChatId: string | null;
  items: { bookId: number; title: string; qty: number; pricePence: number; fromIncoming: boolean }[];
}

export class StockConflict extends Error {
  constructor(
    public readonly problems: { bookId: number; title: string; wanted: number; available: number }[],
  ) {
    super('Some titles are no longer available in the quantity requested');
    this.name = 'StockConflict';
  }
}

function randomRef(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  let out = '';
  for (const b of bytes) out += REF_ALPHABET[b % REF_ALPHABET.length];
  return `ASB-${out}`;
}

function randomToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Releases holds that were never confirmed.
 *
 * A dedicated cron Worker runs this on a schedule, but it also runs at the top
 * of order creation: whether a customer can buy the last copy must not depend
 * on when a scheduled job last fired.
 */
export async function expireStaleHolds(): Promise<number> {
  const now = Math.floor(Date.now() / 1000);

  const { results: stale } = await env.DB.prepare(
    `SELECT id FROM orders WHERE status = 'requested' AND expires_at IS NOT NULL AND expires_at <= ?`,
  )
    .bind(now)
    .all<{ id: number }>();

  if (!stale.length) return 0;

  const statements = [];
  for (const { id } of stale) {
    statements.push(
      ...releaseHold(id, 'hold expired'),
      env.DB.prepare(
        `UPDATE orders SET status = 'expired', updated_at = unixepoch() WHERE id = ?`,
      ).bind(id),
    );
  }

  await env.DB.batch(statements);
  return stale.length;
}

export async function createOrder(input: OrderInput): Promise<CreatedOrder> {
  await expireStaleHolds();

  const ids = input.items.map((i) => i.bookId);
  const placeholders = ids.map(() => '?').join(',');
  const { results: books } = await env.DB.prepare(
    /*
     * The price a customer is charged is decided here, once, server-side - so
     * the sale has to be applied here too. Anywhere else and a sale ending
     * mid-order would reprice an order already placed, and the customer would
     * be charged something other than what they were shown.
     */
    `SELECT b.id, b.title, b.price_pence, (b.stock - b.reserved) AS available,
            MAX(0, b.incoming - b.reserved_incoming) AS reservable,
            si.percent_off AS sale_percent
       FROM books b
       LEFT JOIN sale_items si ON si.book_id = b.id
            AND si.sale_id = (SELECT id FROM sales WHERE status = 'live')
      WHERE b.id IN (${placeholders}) AND b.status = 'live'`,
  )
    .bind(...ids)
    .all<{
      id: number; title: string; price_pence: number;
      available: number; reservable: number; sale_percent: number | null;
    }>();

  const byId = new Map(books.map((b) => [b.id, b]));

  // Check first so the customer gets a readable message naming the titles.
  // Correctness does not rest on this check - see the CHECK constraint below.
  const problems = [];
  for (const item of input.items) {
    const book = byId.get(item.bookId);
    if (!book) {
      problems.push({ bookId: item.bookId, title: 'Unavailable title', wanted: item.qty, available: 0 });
    } else if (book.available < item.qty && book.reservable < item.qty) {
      /*
       * Neither on the shelf nor claimable from a delivery. The two are checked
       * separately and never added together: a line is one or the other, so a
       * customer is never sold "two, one of which is imaginary".
       */
      problems.push({
        bookId: item.bookId,
        title: book.title,
        wanted: item.qty,
        available: Math.max(0, Math.max(book.available, book.reservable)),
      });
    }
  }
  if (problems.length) throw new StockConflict(problems);

  const items = input.items.map((item) => {
    const book = byId.get(item.bookId)!;
    return {
      bookId: book.id,
      title: book.title,
      qty: item.qty,
      // The reduced price, which is what price_pence_snapshot must record.
      pricePence: salePrice(book.price_pence, book.sale_percent),
      // On the shelf if it can be; a claim on the delivery only when it cannot.
      fromIncoming: book.available < item.qty,
    };
  });
  /*
   * The order discount, worked out once and written down.
   *
   * `items` already carries reduced prices, so this is the "after sale" figure
   * the threshold is meant to be tested against. Stored rather than recomputed
   * later: the rule can be switched off tomorrow, and an order must still show
   * the discount it was actually given.
   */
  const discountRule = await orderDiscount();
  const figures = totals(
    items.map((i) => ({ pricePence: i.pricePence, qty: i.qty })),
    discountRule,
  );
  const discountPence = figures.orderDiscountPence;
  const subtotalPence = figures.subtotalPence;

  // A customer who has already started the bot stays reachable: Telegram grants
  // that permission per person, not per order, so making them tap Connect again
  // for every order would be asking for something they already gave.
  const priorLink = await env.DB.prepare(
    `SELECT telegram_chat_id FROM orders
      WHERE email = ? AND telegram_chat_id IS NOT NULL
      ORDER BY telegram_linked_at DESC LIMIT 1`,
  )
    .bind(input.email)
    .first<{ telegram_chat_id: string }>();
  /*
   * An order containing a claim on a delivery is never given an expiry. The
   * customer cannot complete it inside 48 hours because the books are not here
   * - sweeping it would release a copy somebody was promised.
   */
  const waitsForStock = items.some((i) => i.fromIncoming);
  const expiresAt = waitsForStock ? null : Math.floor(Date.now() / 1000) + HOLD_HOURS * 3600;

  const waitingWhen = waitsForStock
    ? await (async () => {
        const row = await env.DB.prepare(
          `SELECT incoming_vague AS v, incoming_month AS m FROM books WHERE id = ?`,
        )
          .bind(items.find((i) => i.fromIncoming)!.bookId)
          .first<{ v: string | null; m: string | null }>();
        return whenText(row?.v ?? null, row?.m ?? null);
      })()
    : null;
  const token = randomToken();

  // A ref collision is a 1-in-a-million event, not an error worth surfacing.
  for (let attempt = 0; attempt < 5; attempt++) {
    const ref = randomRef();
    const statements = [
      env.DB.prepare(
        `INSERT INTO orders (ref, access_token, customer_name, email, phone,
                             fulfilment, address, notes, status, subtotal_pence, discount_pence,
                             expires_at,
                             telegram_chat_id, telegram_linked_at,
                             address_line1, address_line2, address_city,
                             address_region, address_postcode, address_country,
                             payment_preference, cash_payment)
         VALUES (?,?,?,?,?,?,?,?,'requested',?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        ref,
        token,
        input.name,
        input.email,
        input.phone ?? null,
        input.fulfilment,
        input.address ?? null,
        input.notes ?? null,
        subtotalPence,
        discountPence,
        expiresAt,
        priorLink?.telegram_chat_id ?? null,
        priorLink ? Math.floor(Date.now() / 1000) : null,
        input.addressParts?.line1 ?? null,
        input.addressParts?.line2 ?? null,
        input.addressParts?.city ?? null,
        input.addressParts?.region ?? null,
        input.addressParts?.postcode ?? null,
        input.addressParts?.country ?? null,
        input.paymentPreference ?? null,
        // Their stated preference pre-sets the owner's tick, so the common case
        // needs no action. It stays the owner's to change - the two are kept in
        // separate columns precisely so this is a starting point, not a fact.
        input.paymentPreference === 'cash' ? 1 : 0,
      ),
    ];

    for (const item of items) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO order_items (order_id, book_id, title_snapshot, price_pence_snapshot, qty, from_incoming)
           VALUES ((SELECT id FROM orders WHERE ref = ?), ?, ?, ?, ?, ?)`,
        ).bind(ref, item.bookId, item.title, item.pricePence, item.qty, item.fromIncoming ? 1 : 0),
      );

      if (item.fromIncoming) {
        /*
         * A claim on a delivery. It cannot use `reserved`, which counts copies
         * held out of `stock` and is bounded by CHECK (reserved <= stock) -
         * there is nothing on the shelf to hold.
         *
         * Safe against two people claiming the last free copy at once for the
         * same reason shelf stock is: the books_incoming_not_oversold trigger
         * aborts the statement and D1 rolls the whole batch back. The read
         * above is for a readable message, not for correctness.
         *
         * No ledger row - stock_ledger.field is CHECK (field IN
         * ('stock','reserved')) and a claim moved neither. Nothing has come
         * off any shelf yet.
         */
        statements.push(
          env.DB.prepare(
            `UPDATE books SET reserved_incoming = reserved_incoming + ? WHERE id = ?`,
          ).bind(item.qty, item.bookId),
        );
      } else {
        statements.push(
          // If this pushes reserved past stock the CHECK constraint fails, the
          // statement errors, and D1 rolls the whole batch back. That - not the
          // read above - is what makes two simultaneous requests for the last
          // copy safe.
          env.DB.prepare(`UPDATE books SET reserved = reserved + ? WHERE id = ?`).bind(
            item.qty,
            item.bookId,
          ),
          env.DB.prepare(
            `INSERT INTO stock_ledger (book_id, delta, field, reason, order_id)
             VALUES (?, ?, 'reserved', 'order requested', (SELECT id FROM orders WHERE ref = ?))`,
          ).bind(item.bookId, item.qty, ref),
        );
      }
    }

    try {
      await env.DB.batch(statements);
      return {
        ref,
        token,
        subtotalPence,
        expiresAt,
        waitingWhen,
        telegramChatId: priorLink?.telegram_chat_id ?? null,
        items,
      };
    } catch (err) {
      const message = String(err);
      if (message.includes('orders.ref') || message.includes('UNIQUE')) continue; // ref clash, retry
      if (message.includes('reserved <= stock')) {
        // Someone took the last copy between the read and the write.
        throw new StockConflict(
          items.map((i) => ({ bookId: i.bookId, title: i.title, wanted: i.qty, available: -1 })),
        );
      }
      throw err;
    }
  }

  throw new Error('Could not allocate an order reference');
}

/**
 * Finds an order from what a customer can remember.
 *
 * Both the reference and the email must match, and a miss is reported the same
 * way whether the reference was wrong or the email was: telling someone a
 * reference exists but the email is wrong would confirm an order to a stranger.
 */
export async function findOrder(ref: string, email: string): Promise<{ ref: string; token: string } | null> {
  const row = await env.DB.prepare(
    `SELECT ref, access_token FROM orders
      WHERE UPPER(ref) = UPPER(?) AND LOWER(email) = LOWER(?)`,
  )
    .bind(ref.trim(), email.trim())
    .first<{ ref: string; access_token: string }>();
  return row ? { ref: row.ref, token: row.access_token } : null;
}

export interface OrderView {
  ref: string;
  status: string;
  customer_name: string;
  email: string;
  fulfilment: string;
  address: string | null;
  notes: string | null;
  subtotal_pence: number;
  created_at: number;
  expires_at: number | null;
  telegram_chat_id: string | null;
  postage_pence: number | null;
  total_pence: number | null;
  confirmed_at: number | null;
  paid_at: number | null;
  dispatched_at: number | null;
  completed_at: number | null;
  tracking_number: string | null;
  postage_provider: string | null;
  postage_service: string | null;
  /**
   * The handle typed at checkout. No longer asked for - Telegram is now offered
   * to everyone through the deep link - but orders placed before that still
   * carry one, and the portal shows it as a way to reach them.
   */
  telegram: string | null;
  /** For collection orders: whether payment will be made in cash on pickup. */
  cash_payment: number;
  /** What the owner said when cancelling, if anything. */
  cancel_note: string | null;
  /** What the customer said, if anything. A different fact from the above. */
  customer_cancel_note: string | null;
  /** Set while a customer is waiting on the shop to answer a cancellation. */
  cancel_requested_at: number | null;
  /** The order's own id, for routes that act on it. */
  id: number;
  items: {
    title_snapshot: string; price_pence_snapshot: number; qty: number; slug: string | null;
    /** This line is a claim on a delivery, not a copy off the shelf. */
    from_incoming: number;
    incoming_vague: string | null;
    incoming_month: string | null;
  }[];
}

/** Token-checked so a guessed reference cannot expose someone else's order. */
export async function getOrder(ref: string, token: string): Promise<OrderView | null> {
  const order = await env.DB.prepare(
    `SELECT id, ref, status, customer_name, email, fulfilment, address, notes,
            subtotal_pence, postage_pence, total_pence, created_at, expires_at,
            confirmed_at, paid_at, dispatched_at, completed_at, tracking_number,
            postage_provider, postage_service, telegram, cancel_note,
            customer_cancel_note, cancel_requested_at,
            access_token, telegram_chat_id, COALESCE(cash_payment, 0) as cash_payment
       FROM orders WHERE ref = ?`,
  )
    .bind(ref)
    .first<OrderView & { access_token: string }>();

  if (!order) return null;

  // Constant-time-ish comparison: length check then full scan, so a timing
  // difference does not leak the token a character at a time.
  const a = new TextEncoder().encode(order.access_token);
  const b = new TextEncoder().encode(token);
  if (a.length !== b.length) return null;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  if (diff !== 0) return null;

  const { results: items } = await env.DB.prepare(
    `SELECT oi.title_snapshot, oi.price_pence_snapshot, oi.qty, b.slug,
            oi.from_incoming, b.incoming_vague, b.incoming_month
       FROM order_items oi LEFT JOIN books b ON b.id = oi.book_id
      WHERE oi.order_id = (SELECT id FROM orders WHERE ref = ?)`,
  )
    .bind(ref)
    .all<OrderView['items'][number]>();

  const { access_token: _drop, ...rest } = order;
  return { ...rest, items };
}
