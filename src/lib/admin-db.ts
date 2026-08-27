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
  expires_at: number | null;
  confirmed_at: number | null;
  telegram_chat_id: string | null;
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

export async function listBooksAdmin(q?: string | null, limit = 60): Promise<AdminBookRow[]> {
  const search = q?.trim();
  const where = search ? `WHERE b.title LIKE ?1 OR b.title_ar LIKE ?1 OR b.slug LIKE ?1` : '';
  const stmt = env.DB.prepare(
    `SELECT b.id, b.slug, b.title, b.title_ar, b.price_pence, b.stock, b.reserved,
            (b.stock - b.reserved) AS available, b.status, b.telegram_message_id,
            (SELECT image_key FROM book_images WHERE book_id = b.id ORDER BY sort LIMIT 1) AS image_key,
            (CASE WHEN b.description_html IS NULL OR b.description_html = '' THEN 0 ELSE 1 END) AS has_description,
            (SELECT COUNT(*) FROM book_categories WHERE book_id = b.id) AS cat_count
       FROM books b ${where}
      ORDER BY b.updated_at DESC, b.id DESC LIMIT ${limit}`,
  );
  const { results } = await (search ? stmt.bind(`%${search}%`) : stmt).all<AdminBookRow>();
  return results;
}

export interface AdminBookDetail extends AdminBookRow {
  description_html: string | null;
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

/** The work the WooCommerce import could not do for the owner. */
export async function backlog(): Promise<{ noImage: number; noDescription: number; noCategory: number; unposted: number }> {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM books b WHERE b.status='live'
          AND NOT EXISTS (SELECT 1 FROM book_images WHERE book_id = b.id)) AS noImage,
       (SELECT COUNT(*) FROM books WHERE status='live'
          AND (description_html IS NULL OR description_html='')) AS noDescription,
       (SELECT COUNT(*) FROM books b WHERE b.status='live'
          AND NOT EXISTS (SELECT 1 FROM book_categories WHERE book_id = b.id)) AS noCategory,
       (SELECT COUNT(*) FROM books WHERE status='live' AND telegram_message_id IS NULL) AS unposted`,
  ).first<{ noImage: number; noDescription: number; noCategory: number; unposted: number }>();
  return row ?? { noImage: 0, noDescription: 0, noCategory: 0, unposted: 0 };
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
