/**
 * Queries used only by the portal. Kept apart from src/lib/db.ts so the public
 * site's query surface stays small and obviously read-only.
 */

import { env } from 'cloudflare:workers';

export interface AdminOrderRow {
  id: number;
  ref: string;
  access_token: string;
  customer_name: string;
  email: string;
  phone: string | null;
  telegram: string | null;
  fulfilment: string;
  address: string | null;
  notes: string | null;
  status: string;
  subtotal_pence: number;
  postage_pence: number | null;
  total_pence: number | null;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
  confirmed_at: number | null;
  /** Set when payment was recorded, and when the order was closed. */
  paid_at: number | null;
  dispatched_at: number | null;
  completed_at: number | null;
  telegram_chat_id: string | null;
  tracking_number: string | null;
  postage_provider: string | null;
  postage_service: string | null;
  /** The wording that was actually sent, kept so it can be looked back at. */
  payment_message: string | null;
  /** The owner's own words when cancelling. */
  cancel_note: string | null;
  /** The customer is paying cash when the books change hands. */
  cash_payment: number;
  /** What they asked for at checkout: 'transfer', 'cash', or nothing. */
  payment_preference: string | null;
  item_count: number;
}

export interface AdminOrderItem {
  book_id: number | null;
  title_snapshot: string;
  price_pence_snapshot: number;
  qty: number;
  slug: string | null;
}

export async function listOrders(status?: string | null): Promise<AdminOrderRow[]> {
  const where = status ? 'WHERE o.status = ?' : '';
  const stmt = env.DB.prepare(
    `SELECT o.*, (SELECT COALESCE(SUM(qty),0) FROM order_items WHERE order_id = o.id) AS item_count
       FROM orders o ${where}
      ORDER BY CASE o.status WHEN 'requested' THEN 0 WHEN 'awaiting_payment' THEN 1
                             WHEN 'paid' THEN 2 ELSE 3 END, o.created_at DESC
      LIMIT 200`,
  );
  const { results } = await (status ? stmt.bind(status) : stmt).all<AdminOrderRow>();
  return results;
}

/**
 * The postage on the most recent posted order that carried any.
 *
 * This replaced a "usual postage" setting. The owner typed over it on most
 * orders anyway, so it was a number to maintain that rarely applied; what they
 * charged last time needs no maintaining and is right more often.
 */
export async function lastPostagePence(): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT postage_pence FROM orders
      WHERE fulfilment <> 'collection' AND postage_pence IS NOT NULL AND postage_pence > 0
      ORDER BY confirmed_at DESC, id DESC LIMIT 1`,
  ).first<{ postage_pence: number }>();
  return row?.postage_pence ?? 0;
}

export async function getOrderByRef(ref: string): Promise<AdminOrderRow | null> {
  return env.DB.prepare(
    `SELECT o.*, (SELECT COALESCE(SUM(qty),0) FROM order_items WHERE order_id = o.id) AS item_count
       FROM orders o WHERE o.ref = ?`,
  )
    .bind(ref)
    .first<AdminOrderRow>();
}

export async function getOrderItems(orderId: number): Promise<AdminOrderItem[]> {
  const { results } = await env.DB.prepare(
    `SELECT oi.book_id, oi.title_snapshot, oi.price_pence_snapshot, oi.qty, b.slug
       FROM order_items oi LEFT JOIN books b ON b.id = oi.book_id
      WHERE oi.order_id = ?`,
  )
    .bind(orderId)
    .all<AdminOrderItem>();
  return results;
}

export async function orderCounts(): Promise<Record<string, number>> {
  const { results } = await env.DB.prepare(
    'SELECT status, COUNT(*) AS n FROM orders GROUP BY status',
  ).all<{ status: string; n: number }>();
  return Object.fromEntries(results.map((r) => [r.status, r.n]));
}

// ---------------------------------------------------------------------------
// Listings
// ---------------------------------------------------------------------------

export interface AdminBookRow {
  id: number;
  slug: string;
  title: string;
  title_ar: string | null;
  price_pence: number;
  stock: number;
  reserved: number;
  available: number;
  status: string;
  image_key: string | null;
  has_description: number;
  cat_count: number;
  telegram_message_id: number | null;
}

/**
 * Filters the owner actually needs, phrased as the job rather than the column:
 * these mirror the backlog counts on the dashboard so clicking through from
 * there lands on exactly that set of listings.
 */
export type BookFilter =
  | 'all'
  | 'no-photo'
  | 'no-description'
  | 'no-subject'
  | 'not-announced'
  | 'out-of-stock'
  | 'low-stock'
  | 'draft'
  | 'archived';

const FILTER_SQL: Record<BookFilter, string> = {
  all: '',
  'no-photo': 'NOT EXISTS (SELECT 1 FROM book_images WHERE book_id = b.id)',
  'no-description': "(b.description_html IS NULL OR b.description_html = '')",
  'no-subject': 'NOT EXISTS (SELECT 1 FROM book_categories WHERE book_id = b.id)',
  'not-announced': 'b.telegram_message_id IS NULL',
  'out-of-stock': '(b.stock - b.reserved) <= 0',
  'low-stock': '(b.stock - b.reserved) > 0 AND (b.stock - b.reserved) <= 2',
  draft: "b.status = 'draft'",
  archived: "b.status = 'archived'",
};

export type BookSort = 'recent' | 'title' | 'price-asc' | 'price-desc' | 'stock-asc';

const SORT_SQL: Record<BookSort, string> = {
  recent: 'b.updated_at DESC, b.id DESC',
  title: 'b.title COLLATE NOCASE',
  'price-asc': 'b.price_pence ASC, b.title COLLATE NOCASE',
  'price-desc': 'b.price_pence DESC, b.title COLLATE NOCASE',
  'stock-asc': '(b.stock - b.reserved) ASC, b.title COLLATE NOCASE',
};

export interface BookListResult {
  books: AdminBookRow[];
  total: number;
  page: number;
  pages: number;
  perPage: number;
}

export async function listBooksAdmin(opts: {
  q?: string | null;
  filter?: BookFilter;
  sort?: BookSort;
  page?: number;
  perPage?: number;
} = {}): Promise<BookListResult> {
  const search = opts.q?.trim();
  const filter = opts.filter && filter_valid(opts.filter) ? opts.filter : 'all';
  const sort = opts.sort && sort_valid(opts.sort) ? opts.sort : 'recent';
  const perPage = Math.min(Math.max(opts.perPage ?? 40, 10), 200);
  const page = Math.max(1, opts.page ?? 1);

  const clauses: string[] = [];
  const binds: unknown[] = [];

  if (search) {
    clauses.push('(b.title LIKE ? OR b.title_ar LIKE ? OR b.slug LIKE ?)');
    binds.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (FILTER_SQL[filter]) clauses.push(FILTER_SQL[filter]);

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const [countRow, listRes] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM books b ${where}`)
      .bind(...binds)
      .first<{ n: number }>(),
    env.DB.prepare(
      `SELECT b.id, b.slug, b.title, b.title_ar, b.price_pence, b.stock, b.reserved,
              (b.stock - b.reserved) AS available, b.status, b.telegram_message_id,
              (SELECT image_key FROM book_images WHERE book_id = b.id ORDER BY sort LIMIT 1) AS image_key,
              (CASE WHEN b.description_html IS NULL OR b.description_html = '' THEN 0 ELSE 1 END) AS has_description,
              (SELECT COUNT(*) FROM book_categories WHERE book_id = b.id) AS cat_count
         FROM books b ${where}
        ORDER BY ${SORT_SQL[sort]} LIMIT ? OFFSET ?`,
    )
      .bind(...binds, perPage, (page - 1) * perPage)
      .all<AdminBookRow>(),
  ]);

  const total = countRow?.n ?? 0;
  return {
    books: listRes.results,
    total,
    page,
    pages: Math.max(1, Math.ceil(total / perPage)),
    perPage,
  };
}

const filter_valid = (v: string): v is BookFilter => v in FILTER_SQL;
const sort_valid = (v: string): v is BookSort => v in SORT_SQL;

/** Counts for each filter, so the chips can show how much work is in each. */
export async function bookFilterCounts(): Promise<Record<BookFilter, number>> {
  const parts = (Object.keys(FILTER_SQL) as BookFilter[]).map((key) =>
    key === 'all'
      ? 'COUNT(*) AS "all"'
      : `SUM(CASE WHEN ${FILTER_SQL[key]} THEN 1 ELSE 0 END) AS "${key}"`,
  );
  const row = await env.DB.prepare(`SELECT ${parts.join(', ')} FROM books b`).first<
    Record<string, number>
  >();
  return (row ?? {}) as Record<BookFilter, number>;
}

export interface AdminBookDetail extends AdminBookRow {
  description_html: string | null;
  updated_at: number;
  telegram_posted_at: number | null;
  author: string | null;
  publisher: string | null;
  legacy_slug: string | null;
  images: { id: number; image_key: string; alt: string | null; sort: number }[];
  categoryIds: number[];
}

export async function getBookAdmin(id: number): Promise<AdminBookDetail | null> {
  const book = await env.DB.prepare(
    `SELECT b.*, (b.stock - b.reserved) AS available, NULL AS image_key,
            (CASE WHEN b.description_html IS NULL OR b.description_html = '' THEN 0 ELSE 1 END) AS has_description,
            0 AS cat_count
       FROM books b WHERE b.id = ?`,
  )
    .bind(id)
    .first<AdminBookDetail>();
  if (!book) return null;

  const [images, cats] = await Promise.all([
    env.DB.prepare(
      'SELECT id, image_key, alt, sort FROM book_images WHERE book_id = ? ORDER BY sort',
    )
      .bind(id)
      .all<AdminBookDetail['images'][number]>(),
    env.DB.prepare('SELECT category_id FROM book_categories WHERE book_id = ?')
      .bind(id)
      .all<{ category_id: number }>(),
  ]);

  return { ...book, images: images.results, categoryIds: cats.results.map((c) => c.category_id) };
}


/**
 * Adjusts stock and records why. Stock changes are the thing most likely to be
 * disputed later ("I ordered it, you said it was in stock"), so they are never
 * a bare UPDATE.
 */
export async function setStock(bookId: number, stock: number, reason: string): Promise<void> {
  const current = await env.DB.prepare('SELECT stock, reserved FROM books WHERE id = ?')
    .bind(bookId)
    .first<{ stock: number; reserved: number }>();
  if (!current) throw new Error('No such book');

  // Refuse to drop stock below what is already promised to customers.
  const floor = current.reserved;
  const next = Math.max(stock, floor);

  await env.DB.batch([
    env.DB.prepare('UPDATE books SET stock = ?, updated_at = unixepoch() WHERE id = ?').bind(
      next,
      bookId,
    ),
    env.DB.prepare(
      `INSERT INTO stock_ledger (book_id, delta, field, reason) VALUES (?, ?, 'stock', ?)`,
    ).bind(bookId, next - current.stock, reason),
  ]);
}
