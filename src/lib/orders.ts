/**
 * Order requests.
 *
 * An order here is a *request to buy*, not a sale. No money moves. What the
 * request does is put a 48-hour hold on the copies so the owner can arrange
 * payment over Telegram without someone else taking the same book.
 */

import { env } from 'cloudflare:workers';

export const HOLD_HOURS = 48;

/** No 0/O/1/I — these get read aloud and typed back over Telegram. */
const REF_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export interface RequestedItem {
  bookId: number;
  qty: number;
}

export interface OrderInput {
  name: string;
  email: string;
  phone?: string | null;
  telegram?: string | null;
  fulfilment: 'delivery' | 'collection';
  address?: string | null;
  notes?: string | null;
  items: RequestedItem[];
}

export interface CreatedOrder {
  ref: string;
  token: string;
  subtotalPence: number;
  expiresAt: number;
  items: { bookId: number; title: string; qty: number; pricePence: number }[];
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
      env.DB.prepare(
        `UPDATE books SET reserved = MAX(0, reserved - COALESCE(
           (SELECT SUM(qty) FROM order_items WHERE order_id = ?1 AND book_id = books.id), 0))
          WHERE id IN (SELECT book_id FROM order_items WHERE order_id = ?1 AND book_id IS NOT NULL)`,
      ).bind(id),
      env.DB.prepare(
        `INSERT INTO stock_ledger (book_id, delta, field, reason, order_id)
         SELECT book_id, -SUM(qty), 'reserved', 'hold expired', ?1
           FROM order_items WHERE order_id = ?1 AND book_id IS NOT NULL GROUP BY book_id`,
      ).bind(id),
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
    `SELECT id, title, price_pence, (stock - reserved) AS available
       FROM books WHERE id IN (${placeholders}) AND status = 'live'`,
  )
    .bind(...ids)
    .all<{ id: number; title: string; price_pence: number; available: number }>();

  const byId = new Map(books.map((b) => [b.id, b]));

  // Check first so the customer gets a readable message naming the titles.
  // Correctness does not rest on this check — see the CHECK constraint below.
  const problems = [];
  for (const item of input.items) {
    const book = byId.get(item.bookId);
    if (!book) {
      problems.push({ bookId: item.bookId, title: 'Unavailable title', wanted: item.qty, available: 0 });
    } else if (book.available < item.qty) {
      problems.push({
        bookId: item.bookId,
        title: book.title,
        wanted: item.qty,
        available: Math.max(0, book.available),
      });
    }
  }
  if (problems.length) throw new StockConflict(problems);

  const items = input.items.map((item) => {
    const book = byId.get(item.bookId)!;
    return { bookId: book.id, title: book.title, qty: item.qty, pricePence: book.price_pence };
  });
  const subtotalPence = items.reduce((n, i) => n + i.pricePence * i.qty, 0);
  const expiresAt = Math.floor(Date.now() / 1000) + HOLD_HOURS * 3600;
  const token = randomToken();

  // A ref collision is a 1-in-a-million event, not an error worth surfacing.
  for (let attempt = 0; attempt < 5; attempt++) {
    const ref = randomRef();
    const statements = [
      env.DB.prepare(
        `INSERT INTO orders (ref, access_token, customer_name, email, phone, telegram,
                             fulfilment, address, notes, status, subtotal_pence, expires_at)
         VALUES (?,?,?,?,?,?,?,?,?,'requested',?,?)`,
      ).bind(
        ref,
        token,
        input.name,
        input.email,
        input.phone ?? null,
        input.telegram ?? null,
        input.fulfilment,
        input.address ?? null,
        input.notes ?? null,
        subtotalPence,
        expiresAt,
      ),
    ];

    for (const item of items) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO order_items (order_id, book_id, title_snapshot, price_pence_snapshot, qty)
           VALUES ((SELECT id FROM orders WHERE ref = ?), ?, ?, ?, ?)`,
        ).bind(ref, item.bookId, item.title, item.pricePence, item.qty),
        // If this pushes reserved past stock the CHECK constraint fails, the
        // statement errors, and D1 rolls the whole batch back. That — not the
        // read above — is what makes two simultaneous requests for the last
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

    try {
      await env.DB.batch(statements);
      return { ref, token, subtotalPence, expiresAt, items };
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
  items: { title_snapshot: string; price_pence_snapshot: number; qty: number; slug: string | null }[];
}

/** Token-checked so a guessed reference cannot expose someone else's order. */
export async function getOrder(ref: string, token: string): Promise<OrderView | null> {
  const order = await env.DB.prepare(
    `SELECT ref, status, customer_name, email, fulfilment, address, notes,
            subtotal_pence, created_at, expires_at, access_token
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
    `SELECT oi.title_snapshot, oi.price_pence_snapshot, oi.qty, b.slug
       FROM order_items oi LEFT JOIN books b ON b.id = oi.book_id
      WHERE oi.order_id = (SELECT id FROM orders WHERE ref = ?)`,
  )
    .bind(ref)
    .all<OrderView['items'][number]>();

  const { access_token: _drop, ...rest } = order;
  return { ...rest, items };
}
