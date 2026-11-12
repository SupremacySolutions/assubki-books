import { env } from 'cloudflare:workers';
import { missesQuery, readMisses, type Miss } from './searches';
import { requestCountQuery } from './book-requests';
import { REPOST_AFTER_SECONDS } from './telegram';

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
  /** Of those, the ones whose 48-hour hold has already run out. */
  lapsed: number;
  /** Open reservations, which are worked through on their own page. */
  reservations: number;
  /** How many of those are still waiting to be confirmed. */
  reservationsToConfirm: number;
  /** Of those, the ones whose week to reply has run out - flagged, not closed. */
  reservationsLapsed: number;
  oldestWaitingHours: number | null;
  awaitingPayment: number;
  awaitingPence: number;
  toPost: number;
  /** Money, this period and the one before it. */
  revenuePence: number;
  previousPence: number;
  orders: number;
  averagePence: number;
  /** Share of customers who have ordered more than once, all time. */
  repeatPct: number;
  /** The two numbers behind it - shown instead while there are few customers. */
  customers: number;
  repeatCustomers: number;
  /** One point per day, oldest first. */
  daily: { day: string; pence: number; orders: number }[];
  collection: number;
  posted: number;
  cash: number;
  transfer: number;
  bestSellers: { title: string; qty: number }[];
  lowStock: { title: string; slug: string; left: number }[];
  byShelf: { name: string; pence: number }[];
  /**
   * What people searched for and the shop did not have.
   *
   * The nearest thing here to a customer speaking directly: every row is
   * somebody who came looking and left with nothing.
   */
  misses: Miss[];
  /** Searches that once found nothing and now find a book. */
  answered: Miss[];
  /**
   * How many people asked the shop to go and find something.
   *
   * The half of a fruitless search that can actually be answered: a miss is
   * anonymous, this has an address attached to it. Counted here rather than
   * read on its own page so it costs no extra round trip and inherits this
   * object's minute of cache.
   */
  requests: number;
  /**
   * Customers waiting on an answer.
   *
   * The owner hears about each message on Telegram or by email, but a
   * notification read on a phone and forgotten left nothing on the page they
   * open every day - the only other sign was a badge in the orders list, on
   * whichever half and tab the order happened to sit in. `newest` is where the
   * tile goes, so one tap lands on the conversation rather than on a list.
   */
  unread: {
    messages: number;
    orders: number;
    newest: { ref: string; name: string } | null;
  };
  /** The catalogue worklist - listings missing something. */
  backlog: {
    noImage: number; thinImage: number; noDescription: number; noCategory: number;
    unposted: number; repost: number; outOfStock: number; lowStock: number;
  };
}

/** Paid, sent, or done - an order whose money is real. */
const EARNED = `('paid','dispatched','completed')`;

/*
 * When the money came in, which is not when the request was placed.
 *
 * Every figure below used to be dated by `created_at`. An order placed on the
 * 1st and paid on the 20th then counted towards whichever window held the 1st,
 * so "Taken in the last 30 days" quietly dropped money that had arrived inside
 * it and kept money that had not. Cash orders are often never marked paid -
 * they go straight from confirmed to collected - so they fall back to when the
 * books changed hands, and only an order with neither falls back to the
 * request itself.
 */
const TAKEN_AT = (o = '') =>
  `COALESCE(${o}paid_at, ${o}completed_at, ${o}dispatched_at, ${o}created_at)`;

/*
 * One checkout, however many orders it became.
 *
 * A basket holding shelf books and reserved books is split into two orders
 * sharing a `split_group`. Counted as orders, that one customer was two
 * orders, halved the average, and - worst - made them a "repeat customer" on
 * their first visit.
 */
const CHECKOUT = (o = '') => `COALESCE(${o}split_group, 'o' || ${o}id)`;

/*
 * A listing as the Listings page means it: not a box still on its way, not a
 * part of a set (those are managed from the set), not in the bin, and on sale.
 * The worklist tiles open that page, so they have to count the same rows - a
 * set part was being counted here and not shown there, which is how a tile
 * read 226 and the page behind it 225.
 */
const LIVE_NOT_DELETED = (b = '') =>
  `${b}status = 'live' AND ${b}deleted_at IS NULL AND ${b}shipment_id IS NULL AND ${b}set_part = 0`;

/**
 * Seconds to add to a UTC timestamp to get the shop's own wall clock.
 *
 * D1 only knows UTC, so an order paid at 00:30 in June landed on the day
 * before in the chart. One offset for the whole window is right on every day
 * but the two a year the clocks change, and then only for one hour.
 */
function londonOffsetSeconds(at = new Date()): number {
  const name = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', timeZoneName: 'shortOffset' })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = name.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!m) return 0;
  const secs = Number(m[2]) * 3600 + Number(m[3] ?? 0) * 60;
  return m[1] === '-' ? -secs : secs;
}

/** Today's date on the shop's clock, as YYYY-MM-DD, `back` days ago. */
export function shopDay(back = 0, now = Date.now()): string {
  const at = new Date(now - back * 86_400_000);
  return new Date(at.getTime() + londonOffsetSeconds(at) * 1000).toISOString().slice(0, 10);
}

async function read(days: number): Promise<Dashboard> {
  const now = Math.floor(Date.now() / 1000);
  const from = now - days * DAY;
  const previousFrom = from - days * DAY;
  const offset = londonOffsetSeconds();

  const [waiting, reserved, money, daily, splits, best, low, repeat, shelves, work, misses, requests, unread] =
    await env.DB.batch([
    /*
     * Everything the owner might need to act on, counted in one pass.
     *
     * Shop orders only, because that is what every one of these tiles opens.
     * `/admin/orders` shows one half at a time - `shipment_id IS NULL` unless
     * asked for reservations - so counting both halves here made a tile read 9
     * and its own page read 1, which is how this was reported: "says 8 but
     * there is only 1". A number that disagrees with the page behind it is
     * worse than no number.
     *
     * Reservations are not dropped; they are counted separately below and get
     * their own tile, because they are worked through differently and a
     * deadline on one means something else entirely.
     */
    env.DB.prepare(
      `SELECT
         SUM(CASE WHEN status = 'requested' THEN 1 ELSE 0 END) AS toConfirm,
         SUM(CASE WHEN status = 'requested' AND lapsed_at IS NOT NULL
                  THEN 1 ELSE 0 END) AS lapsed,
         MIN(CASE WHEN status = 'requested' THEN created_at END) AS oldest,
         SUM(CASE WHEN status = 'awaiting_payment' THEN 1 ELSE 0 END) AS awaiting,
         SUM(CASE WHEN status = 'awaiting_payment'
                  THEN COALESCE(total_pence, subtotal_pence) ELSE 0 END) AS awaitingPence,
         SUM(CASE WHEN status = 'paid' AND fulfilment <> 'collection' THEN 1 ELSE 0 END) AS toPost
       FROM orders WHERE shipment_id IS NULL`,
    ),
    /* The other half, on the same terms `reservationCount` uses. */
    env.DB.prepare(
      `SELECT COUNT(*) AS open, SUM(CASE WHEN status = 'requested' THEN 1 ELSE 0 END) AS toConfirm,
              SUM(CASE WHEN status IN ('requested','awaiting_payment') AND lapsed_at IS NOT NULL
                       THEN 1 ELSE 0 END) AS lapsed
         FROM orders
        WHERE shipment_id IS NOT NULL
          AND status IN ('requested','awaiting_payment','paid','dispatched')`,
    ),
    env.DB.prepare(
      `SELECT
         SUM(CASE WHEN t > ?1 THEN pence ELSE 0 END) AS now,
         SUM(CASE WHEN t <= ?1 THEN pence ELSE 0 END) AS before,
         COUNT(DISTINCT CASE WHEN t > ?1 THEN checkout END) AS orders
       FROM (SELECT ${TAKEN_AT()} AS t, COALESCE(total_pence, subtotal_pence) AS pence,
                    ${CHECKOUT()} AS checkout
               FROM orders WHERE status IN ${EARNED})
      WHERE t > ?2`,
    ).bind(from, previousFrom),
    env.DB.prepare(
      `SELECT date(t + ?2, 'unixepoch') AS day, SUM(pence) AS pence,
              COUNT(DISTINCT checkout) AS orders
         FROM (SELECT ${TAKEN_AT()} AS t, COALESCE(total_pence, subtotal_pence) AS pence,
                      ${CHECKOUT()} AS checkout
                 FROM orders WHERE status IN ${EARNED})
        WHERE t > ?1
        GROUP BY day ORDER BY day`,
    ).bind(from, offset),
    /* Per checkout, like the order count beside it, so the two agree. */
    env.DB.prepare(
      `SELECT
         COUNT(DISTINCT CASE WHEN fulfilment = 'collection' THEN checkout END) AS collection,
         COUNT(DISTINCT CASE WHEN fulfilment <> 'collection' THEN checkout END) AS posted,
         COUNT(DISTINCT CASE WHEN cash = 1 THEN checkout END) AS cash,
         COUNT(DISTINCT CASE WHEN cash = 0 THEN checkout END) AS transferred
       FROM (SELECT fulfilment, COALESCE(cash_payment, 0) AS cash, ${CHECKOUT()} AS checkout,
                    ${TAKEN_AT()} AS t
               FROM orders WHERE status IN ${EARNED})
      WHERE t > ?`,
    ).bind(from),
    /*
     * By book, not by the title as it was typed into each order. A listing
     * renamed between two sales was two rows, each looking half as popular.
     */
    env.DB.prepare(
      `SELECT COALESCE(MAX(b.title), MAX(oi.title_snapshot)) AS title, SUM(oi.qty) AS qty
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         LEFT JOIN books b ON b.id = oi.book_id AND b.deleted_at IS NULL
        WHERE o.status IN ${EARNED} AND ${TAKEN_AT('o.')} > ?
        GROUP BY COALESCE('b' || oi.book_id, 't' || oi.title_snapshot)
        ORDER BY qty DESC LIMIT 5`,
    ).bind(from),
    env.DB.prepare(
      `SELECT title, slug, (stock - reserved) AS left_
         FROM books WHERE ${LIVE_NOT_DELETED()}
          AND (stock - reserved) BETWEEN 1 AND 2
        ORDER BY left_, title LIMIT 6`,
    ),
    /*
     * All time, not this period: over thirty days almost nobody has had the
     * chance to come back twice, and a number that is always near zero says
     * nothing. Counted by email, which is the only identity an order has.
     */
    env.DB.prepare(
      `SELECT
         COUNT(*) AS customers,
         SUM(CASE WHEN n > 1 THEN 1 ELSE 0 END) AS came_back
       FROM (SELECT COUNT(DISTINCT ${CHECKOUT()}) AS n FROM orders
              WHERE status IN ${EARNED} GROUP BY lower(trim(email)))`,
    ),
    env.DB.prepare(
      /*
       * One shelf per line, not one row per shelf the book sits on.
       *
       * A title filed under both Hadith and Syllabus was counted in full
       * against each, so the rows added up to more than the shop had taken -
       * on the live dashboard £260 and £260 against a total of £275. Read as a
       * breakdown, which is what a column of money next to shelf names is,
       * that is simply wrong.
       *
       * Each line is attributed to its first top-level shelf by the owner's own
       * ordering, so the figure is deterministic and the rows never exceed the
       * takings.
       */
      /*
       * And by the shelf at the top of the tree, found by path.
       *
       * This used to ask for a shelf the book was filed under *directly* that
       * had no parent - and a third of the catalogue is filed only on a
       * sub-shelf (Tafsir, not Qur'an), so their sales vanished from this
       * panel altogether. The first segment of any shelf's path is its
       * top-level shelf. A sale with no shelf at all is shown as such rather
       * than dropped, so the rows can be checked against the takings.
       */
      `SELECT COALESCE(top.name, 'Not on a shelf') AS name,
              SUM(oi.price_pence_snapshot * oi.qty - oi.multibuy_pence) AS pence
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         LEFT JOIN categories top ON top.id = (
                SELECT t.id
                  FROM book_categories bc2
                  JOIN categories c2 ON c2.id = bc2.category_id
                  JOIN categories t ON t.parent_id IS NULL
                   AND t.path = CASE WHEN instr(c2.path, '/') > 0
                                     THEN substr(c2.path, 1, instr(c2.path, '/') - 1)
                                     ELSE c2.path END
                 WHERE bc2.book_id = oi.book_id
                 ORDER BY t.sort, t.id
                 LIMIT 1
              )
        WHERE o.status IN ${EARNED} AND ${TAKEN_AT('o.')} > ?
        GROUP BY top.id ORDER BY pence DESC LIMIT 6`,
    ).bind(from),
    /*
     * The catalogue worklist. It used to be its own query on every portal home
     * load - 1,786 rows a time, which was tolerable when nobody opened that
     * page and is not now the dashboard lives there. Here it shares the cache.
     */
    env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM books b WHERE ${LIVE_NOT_DELETED('b.')}
            AND NOT EXISTS (SELECT 1 FROM book_images WHERE book_id = b.id)) AS noImage,
         (SELECT COUNT(*) FROM books WHERE ${LIVE_NOT_DELETED()}
            AND (description_html IS NULL OR description_html='')) AS noDescription,
         (SELECT COUNT(*) FROM books b WHERE ${LIVE_NOT_DELETED('b.')}
            AND NOT EXISTS (SELECT 1 FROM book_categories WHERE book_id = b.id)) AS noCategory,
         (SELECT COUNT(*) FROM books b2 WHERE ${LIVE_NOT_DELETED('b2.')}
            AND EXISTS (SELECT 1 FROM book_images i WHERE i.book_id = b2.id AND i.sort = 0
                          AND i.width IS NOT NULL AND i.height > 0
                          AND MIN(i.width, CAST(i.height * 5.0 / 7.0 AS INTEGER)) < 300)) AS thinImage,
         (SELECT COUNT(*) FROM books WHERE ${LIVE_NOT_DELETED()}
            AND telegram_message_id IS NULL) AS unposted,
         (SELECT COUNT(*) FROM books WHERE ${LIVE_NOT_DELETED()}
            AND telegram_message_id IS NOT NULL AND telegram_shown_available = 0
            AND (stock - reserved) > 0
            AND telegram_sold_out_at <= unixepoch() - ${REPOST_AFTER_SECONDS}) AS repost,
         (SELECT COUNT(*) FROM books WHERE ${LIVE_NOT_DELETED()}
            AND (stock - reserved) <= 0) AS outOfStock,
         (SELECT COUNT(*) FROM books WHERE ${LIVE_NOT_DELETED()}
            AND (stock - reserved) > 0 AND (stock - reserved) <= 2) AS lowStock`,
    ),
    // Reads inside the batch the dashboard was already making, so the panel
    // costs no extra round trip and inherits the 60-second cache.
    missesQuery(days),
    requestCountQuery(),
    /*
     * Every order, both halves and every status: a message is unanswered
     * whichever tab its order is on, and one that came in before an order
     * closed is still somebody who was not answered. The newest first, so the
     * tile opens whoever wrote last.
     */
    env.DB.prepare(
      `SELECT ref, customer_name AS name, unread_for_owner AS n
         FROM orders WHERE unread_for_owner > 0
        ORDER BY last_message_at DESC, id DESC`,
    ),
  ]);

  const w = (waiting.results[0] ?? {}) as Record<string, number | null>;
  const rv = (reserved.results[0] ?? {}) as Record<string, number | null>;
  const m = (money.results[0] ?? {}) as Record<string, number | null>;
  const s = (splits.results[0] ?? {}) as Record<string, number | null>;

  const revenuePence = Number(m.now ?? 0);
  const orders = Number(m.orders ?? 0);

  const missRead = await readMisses(
    misses.results.map((r) => {
      const row = r as Record<string, unknown>;
      return {
        terms: String(row.terms),
        times: Number(row.times),
        lastAt: Number(row.lastAt),
        visitors: String(row.visitors ?? '').split(',').filter(Boolean),
      };
    }),
  );

  return {
    toConfirm: Number(w.toConfirm ?? 0),
    lapsed: Number(w.lapsed ?? 0),
    reservations: Number(rv.open ?? 0),
    reservationsToConfirm: Number(rv.toConfirm ?? 0),
    reservationsLapsed: Number(rv.lapsed ?? 0),
    oldestWaitingHours: w.oldest ? Math.floor((now - Number(w.oldest)) / 3600) : null,
    awaitingPayment: Number(w.awaiting ?? 0),
    awaitingPence: Number(w.awaitingPence ?? 0),
    toPost: Number(w.toPost ?? 0),
    revenuePence,
    previousPence: Number(m.before ?? 0),
    orders,
    averagePence: orders > 0 ? Math.round(revenuePence / orders) : 0,
    ...(() => {
      const r = (repeat.results[0] ?? {}) as Record<string, number | null>;
      const customers = Number(r.customers ?? 0);
      const repeatCustomers = Number(r.came_back ?? 0);
      return {
        customers,
        repeatCustomers,
        repeatPct: customers > 0 ? Math.round((repeatCustomers / customers) * 100) : 0,
      };
    })(),
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
    backlog: (() => {
      const b = (work.results[0] ?? {}) as Record<string, number | null>;
      return {
        noImage: Number(b.noImage ?? 0), thinImage: Number(b.thinImage ?? 0),
        noDescription: Number(b.noDescription ?? 0),
        noCategory: Number(b.noCategory ?? 0), unposted: Number(b.unposted ?? 0), repost: Number(b.repost ?? 0),
        outOfStock: Number(b.outOfStock ?? 0), lowStock: Number(b.lowStock ?? 0),
      };
    })(),
    misses: missRead.open,
    answered: missRead.answered,
    requests: Number((requests.results[0] as { n?: number } | undefined)?.n ?? 0),
    unread: (() => {
      const rows = unread.results as { ref: string; name: string; n: number }[];
      return {
        messages: rows.reduce((sum, r) => sum + Number(r.n), 0),
        orders: rows.length,
        newest: rows[0] ? { ref: String(rows[0].ref), name: String(rows[0].name) } : null,
      };
    })(),
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

/**
 * Called after an order moves, so the owner sees their own action.
 *
 * Every other cache of this kind has had one of these from the start -
 * `forgetCategoryCounts`, `forgetHomeRows`, `forgetSale`. The dashboard was the
 * exception, and it is the one showing numbers somebody acts on: confirming an
 * order and then reading "3 to confirm" for another minute is the cache lying
 * to the only person who can tell it is wrong.
 *
 * Like the others it clears the isolate that handled the write, so staleness is
 * bounded by the minute rather than eliminated. That is the deal everywhere
 * else here too.
 */
export function forgetDashboard(): void {
  cache = null;
}
