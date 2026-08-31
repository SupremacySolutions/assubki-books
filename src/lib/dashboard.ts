import { env } from 'cloudflare:workers';

/**
 * The numbers behind the dashboard.
 *
 * Written as a handful of grouped aggregates rather than one query per tile,
 * and cached, because this is exactly the shape of thing that became
 * `categoryCounts`: many small reads on a page somebody opens all day. That
 * one query reached 34,000 rows a call and 95% of the whole read budget before
 * anybody noticed, so this one gets measured rather than assumed.
 *
 * Everything here comes from what is already stored. Nothing is recorded to
 * make the dashboard work.
 */

const DAY = 86_400;

export interface Dashboard {
  /** Waiting on the owner right now. */
  toConfirm: number;
  oldestWaitingHours: number | null;
  awaitingPayment: number;
  awaitingPence: number;
  toPost: number;
  /** Money, this period and the one before it. */
  revenuePence: number;
  previousPence: number;
  orders: number;
  averagePence: number;
  /** One point per day, oldest first. */
  daily: { day: string; pence: number; orders: number }[];
  collection: number;
  posted: number;
  cash: number;
  transfer: number;
  bestSellers: { title: string; qty: number }[];
  lowStock: { title: string; slug: string; left: number }[];
  byShelf: { name: string; pence: number }[];
}

/** Paid, sent, or done - an order whose money is real. */
const EARNED = `('paid','dispatched','completed')`;

async function read(days: number): Promise<Dashboard> {
  const now = Math.floor(Date.now() / 1000);
  const from = now - days * DAY;
  const previousFrom = from - days * DAY;

  const [waiting, money, daily, splits, best, low, shelves] = await env.DB.batch([
    // Everything the owner might need to act on, counted in one pass.
    env.DB.prepare(
      `SELECT
         SUM(CASE WHEN status = 'requested' THEN 1 ELSE 0 END) AS toConfirm,
         MIN(CASE WHEN status = 'requested' THEN created_at END) AS oldest,
         SUM(CASE WHEN status = 'awaiting_payment' THEN 1 ELSE 0 END) AS awaiting,
         SUM(CASE WHEN status = 'awaiting_payment'
                  THEN COALESCE(total_pence, subtotal_pence) ELSE 0 END) AS awaitingPence,
         SUM(CASE WHEN status = 'paid' AND fulfilment <> 'collection' THEN 1 ELSE 0 END) AS toPost
       FROM orders`,
    ),
    env.DB.prepare(
      `SELECT
         SUM(CASE WHEN created_at > ?1 THEN COALESCE(total_pence, subtotal_pence) ELSE 0 END) AS now,
         SUM(CASE WHEN created_at <= ?1 THEN COALESCE(total_pence, subtotal_pence) ELSE 0 END) AS before,
         SUM(CASE WHEN created_at > ?1 THEN 1 ELSE 0 END) AS orders
       FROM orders WHERE status IN ${EARNED} AND created_at > ?2`,
    ).bind(from, previousFrom),
    env.DB.prepare(
      `SELECT date(created_at, 'unixepoch') AS day,
              SUM(COALESCE(total_pence, subtotal_pence)) AS pence,
              COUNT(*) AS orders
         FROM orders WHERE status IN ${EARNED} AND created_at > ?
        GROUP BY day ORDER BY day`,
    ).bind(from),
    env.DB.prepare(
      `SELECT
         SUM(CASE WHEN fulfilment = 'collection' THEN 1 ELSE 0 END) AS collection,
         SUM(CASE WHEN fulfilment <> 'collection' THEN 1 ELSE 0 END) AS posted,
         SUM(CASE WHEN COALESCE(cash_payment,0) = 1 THEN 1 ELSE 0 END) AS cash,
         SUM(CASE WHEN COALESCE(cash_payment,0) = 0 THEN 1 ELSE 0 END) AS transferred
       FROM orders WHERE status IN ${EARNED} AND created_at > ?`,
    ).bind(from),
    env.DB.prepare(
      `SELECT oi.title_snapshot AS title, SUM(oi.qty) AS qty
         FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE o.status IN ${EARNED} AND o.created_at > ?
        GROUP BY oi.title_snapshot ORDER BY qty DESC LIMIT 5`,
    ).bind(from),
    env.DB.prepare(
      `SELECT title, slug, (stock - reserved) AS left_
         FROM books WHERE status = 'live' AND (stock - reserved) BETWEEN 1 AND 2
        ORDER BY left_, title LIMIT 6`,
    ),
    env.DB.prepare(
      `SELECT c.name AS name, SUM(oi.price_pence_snapshot * oi.qty) AS pence
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         JOIN book_categories bc ON bc.book_id = oi.book_id
         JOIN categories c ON c.id = bc.category_id AND c.parent_id IS NULL
        WHERE o.status IN ${EARNED} AND o.created_at > ?
        GROUP BY c.id ORDER BY pence DESC LIMIT 5`,
    ).bind(from),
  ]);

  const w = (waiting.results[0] ?? {}) as Record<string, number | null>;
  const m = (money.results[0] ?? {}) as Record<string, number | null>;
  const s = (splits.results[0] ?? {}) as Record<string, number | null>;

  const revenuePence = Number(m.now ?? 0);
  const orders = Number(m.orders ?? 0);

  return {
    toConfirm: Number(w.toConfirm ?? 0),
    oldestWaitingHours: w.oldest ? Math.floor((now - Number(w.oldest)) / 3600) : null,
    awaitingPayment: Number(w.awaiting ?? 0),
    awaitingPence: Number(w.awaitingPence ?? 0),
    toPost: Number(w.toPost ?? 0),
    revenuePence,
    previousPence: Number(m.before ?? 0),
    orders,
    averagePence: orders > 0 ? Math.round(revenuePence / orders) : 0,
    daily: daily.results.map((r) => {
      const row = r as Record<string, unknown>;
      return { day: String(row.day), pence: Number(row.pence), orders: Number(row.orders) };
    }),
    collection: Number(s.collection ?? 0),
    posted: Number(s.posted ?? 0),
    cash: Number(s.cash ?? 0),
    transfer: Number(s.transferred ?? 0),
    bestSellers: best.results.map((r) => {
      const row = r as Record<string, unknown>;
      return { title: String(row.title), qty: Number(row.qty) };
    }),
    lowStock: low.results.map((r) => {
      const row = r as Record<string, unknown>;
      return { title: String(row.title), slug: String(row.slug), left: Number(row.left_) };
    }),
    byShelf: shelves.results.map((r) => {
      const row = r as Record<string, unknown>;
      return { name: String(row.name), pence: Number(row.pence) };
    }),
  };
}

/** Cached for a minute, like the shelf counts and the contact handle. */
let cache: { at: number; days: number; value: Dashboard } | null = null;

export async function dashboard(days = 30): Promise<Dashboard> {
  const now = Date.now();
  if (cache && cache.days === days && now - cache.at < 60_000) return cache.value;
  const value = await read(days);
  cache = { at: now, days, value };
  return value;
}
