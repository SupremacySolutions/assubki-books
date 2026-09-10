/**
 * Queries used only by the portal. Kept apart from src/lib/db.ts so the public
 * site's query surface stays small and obviously read-only.
 */

import { env } from 'cloudflare:workers';
import { clipToBytes, LIKE_BYTES } from './like';
import type { BookLanguage } from './db';

export interface AdminOrderRow {
  unread_for_owner: number;
  /*
   * The thread's high-water mark, so the portal's poll can decide whether
   * anything moved without reading the messages themselves. Selected already
   * by `o.*`; declared here because the poll is the first caller to want them.
   */
  last_message_id: number | null;
  last_message_at: number | null;
  id: number;
  ref: string;
  /**
   * Ties this order to the others one checkout produced.
   *
   * The owner needs it for one reason above all: postage. A basket holding
   * shelf books and reserved books becomes two orders, and quoting each of
   * them a delivery charge bills one customer twice for one basket.
   */
  split_group: string | null;
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
  /** The reply deadline a landed delivery starts. Null on an ordinary order. */
  pay_by: number | null;
  /** Which shipment this came from, if it is a reservation. */
  shipment_id: number | null;
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
  /** The customer's own words, which are not the same fact. */
  customer_cancel_note: string | null;
  /** Set while a customer is waiting to hear back about cancelling. */
  cancel_requested_at: number | null;
  /** The customer is paying cash when the books change hands. */
  cash_payment: number;
  /** What they asked for at checkout: 'transfer', 'cash', or nothing. */
  payment_preference: string | null;
  /**
   * When books were last taken off this order, if they ever were.
   *
   * A marker rather than the record itself: the amendments live in their own
   * table, and this is what saves every page that shows an order from reading
   * that table for the overwhelming majority of orders that have none.
   */
  amended_at: number | null;
  /** What the order was discounted by, which an amendment scales. */
  discount_pence: number;
  item_count: number;
}

export interface AdminOrderItem {
  /** The line's own id, which is what an amendment acts on. */
  id: number;
  from_incoming: number;
  book_id: number | null;
  title_snapshot: string;
  price_pence_snapshot: number;
  qty: number;
  slug: string | null;
  /** Still on a shipment, which is where it links - it has no product page. */
  shipment_id: number | null;
}

/**
 * The owner's order list, in two halves.
 *
 * Reservations are kept apart from the shop's ordinary orders because they are
 * worked through differently: nothing to pack until a box lands, a deadline
 * that only starts then, and a whole shipment's worth arriving at once. Mixing
 * them into one queue would bury today's parcels under next month's promises.
 *
 * `shipment_id` is what tells them apart - one indexed column rather than a
 * second table, so the order page, the thread, confirming and taking payment
 * are all the same code they have always been.
 */
export async function listOrders(
  status?: string | null,
  kind: 'shop' | 'reservation' = 'shop',
): Promise<AdminOrderRow[]> {
  const clauses = [kind === 'reservation' ? 'o.shipment_id IS NOT NULL' : 'o.shipment_id IS NULL'];
  if (status) clauses.push('o.status = ?');
  const stmt = env.DB.prepare(
    `SELECT o.*, (SELECT COALESCE(SUM(qty),0) FROM order_items WHERE order_id = o.id) AS item_count
       FROM orders o WHERE ${clauses.join(' AND ')}
      ORDER BY CASE o.status WHEN 'requested' THEN 0 WHEN 'awaiting_payment' THEN 1
                             WHEN 'paid' THEN 2 ELSE 3 END, o.created_at DESC
      LIMIT 200`,
  );
  const { results } = await (status ? stmt.bind(status) : stmt).all<AdminOrderRow>();
  return results;
}

/** How many reservation orders are waiting, for the tab to show. */
export async function reservationCount(): Promise<number> {
  const row = await env.DB
    .prepare(
      `SELECT COUNT(*) AS n FROM orders
        WHERE shipment_id IS NOT NULL
          AND status IN ('requested','awaiting_payment','paid','dispatched')`,
    )
    .first<{ n: number }>();
  return row?.n ?? 0;
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
    `SELECT oi.id, oi.from_incoming, oi.book_id, oi.title_snapshot, oi.price_pence_snapshot, oi.qty,
            b.slug, b.shipment_id
       FROM order_items oi LEFT JOIN books b ON b.id = oi.book_id
      WHERE oi.order_id = ? ORDER BY oi.id`,
  )
    .bind(orderId)
    .all<AdminOrderItem>();
  return results;
}

export async function orderCounts(
  kind: 'shop' | 'reservation' = 'shop',
): Promise<Record<string, number>> {
  // Counted over the same half the list shows, or the chips would promise work
  // the page they lead to does not have.
  const { results } = await env.DB.prepare(
    `SELECT status, COUNT(*) AS n FROM orders
      WHERE shipment_id IS ${kind === 'reservation' ? 'NOT NULL' : 'NULL'}
      GROUP BY status`,
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
  title_ur: string | null;
  language: BookLanguage;
  price_pence: number;
  stock: number;
  reserved: number;
  available: number;
  status: string;
  image_key: string | null;
  has_description: number;
  cat_count: number;
  telegram_message_id: number | null;
  /**
   * Real detail in the cover, in pixels across, before anything enlarges it.
   *
   * Not the stored width. A cover wider than the frame loses its sides to the
   * crop, and one narrower has its sides continued outwards - which fills the
   * frame but invents no detail. Either way what survives is the smaller of
   * the two, and that is the number worth showing beside a listing, because
   * the card asks for 600 and the detail view for 840.
   */
  usable_width: number | null;
  /* When it went in the bin, or null. Only ever set on rows the `deleted`
     filter returned, since every other filter excludes them. */
  deleted_at: number | null;
  /* Set when the owner posted the announcement themselves. See migration 0042. */
  announced_by_hand: number | null;
}

/**
 * Filters the owner actually needs, phrased as the job rather than the column:
 * these mirror the backlog counts on the dashboard so clicking through from
 * there lands on exactly that set of listings.
 */
export type BookFilter =
  | 'all'
  | 'no-photo'
  | 'thin-photo'
  | 'english'
  | 'arabic'
  | 'urdu'
  | 'no-description'
  | 'no-subject'
  | 'not-announced'
  | 'out-of-stock'
  | 'low-stock'
  | 'draft'
  | 'archived'
  /* The bin. The only filter that shows listings the others all hide. */
  | 'deleted';

const FILTER_SQL: Record<BookFilter, string> = {
  all: '',
  'no-photo': 'NOT EXISTS (SELECT 1 FROM book_images WHERE book_id = b.id)',
  /*
   * A cover with too few pixels to fill the box it is given.
   *
   * Every cover is cropped to 5:7, so what matters is the width that survives
   * that crop: a wide photo is trimmed at the sides and keeps only `height *
   * 5/7`. Below 300px of usable width the card - which asks for 600 - is
   * showing each pixel as four, and no amount of processing puts detail back
   * that the source never had. The originals these came from are gone, so
   * these are the listings that need photographing again.
   */
  'thin-photo': `EXISTS (
     SELECT 1 FROM book_images i
      WHERE i.book_id = b.id AND i.sort = 0
        AND i.width IS NOT NULL AND i.height > 0
        AND MIN(i.width, CAST(i.height * 5.0 / 7.0 AS INTEGER)) < 300
   )`,
  /*
   * The three languages, straight off the generated column. `idx_books_language`
   * carries status with it, so these cost an index search rather than a scan -
   * which matters because the portal list is one of the few pages that runs a
   * count and a page of rows against the whole catalogue at once.
   */
  english: "b.language = 'english'",
  arabic: "b.language = 'arabic'",
  urdu: "b.language = 'urdu'",
  'no-description': "(b.description_html IS NULL OR b.description_html = '')",
  'no-subject': 'NOT EXISTS (SELECT 1 FROM book_categories WHERE book_id = b.id)',
  /*
   * Two ways to be announced, because the shop's bot is not the only one who
   * can post. Marking a batch announced by hand cannot set a message id - there
   * is no message, the shop never sent one - so it sets `announced_by_hand`
   * instead and this filter has to ask about both. See migration 0042.
   */
  'not-announced': 'b.telegram_message_id IS NULL AND b.announced_by_hand IS NULL',
  'out-of-stock': '(b.stock - b.reserved) <= 0',
  'low-stock': '(b.stock - b.reserved) > 0 AND (b.stock - b.reserved) <= 2',
  draft: "b.status = 'draft'",
  archived: "b.status = 'archived'",
  deleted: 'b.deleted_at IS NOT NULL',
};

export type BookSort =
  | 'recent'
  | 'title'
  | 'price-asc'
  | 'price-desc'
  | 'stock-asc'
  | 'cover-worst';

const SORT_SQL: Record<BookSort, string> = {
  recent: 'b.updated_at DESC, b.id DESC',
  title: 'b.title COLLATE NOCASE',
  'price-asc': 'b.price_pence ASC, b.title COLLATE NOCASE',
  'price-desc': 'b.price_pence DESC, b.title COLLATE NOCASE',
  'stock-asc': '(b.stock - b.reserved) ASC, b.title COLLATE NOCASE',
  /*
   * The re-shooting worklist, worst first.
   *
   * A listing with no cover at all sorts last rather than first: it belongs to
   * "No photo", which is a different job with a different answer, and putting
   * it here would bury the covers that do exist and are too thin to print.
   */
  'cover-worst': `(SELECT MIN(i.width, CAST(i.height * 5.0 / 7.0 AS INTEGER))
                     FROM book_images i
                    WHERE i.book_id = b.id AND i.sort = 0
                      AND i.width > 0 AND i.height > 0) ASC NULLS LAST,
                  b.title COLLATE NOCASE`,
};

export interface BookListResult {
  books: AdminBookRow[];
  total: number;
  page: number;
  pages: number;
  perPage: number;
}

/**
 * Listings that look like parts of this one.
 *
 * The set builder creates part listings from nothing, which is right for a set
 * being set up for the first time and wrong when the parts are already in the
 * catalogue with their own covers, descriptions and channel posts. Adopting
 * them needs candidates, and the honest way to find them is the title: a shop
 * names "Al-Hidayah ...: (1 & 2)" and "... (3 & 4)" off the same stem.
 *
 * The stem is whatever comes before the first colon, falling back to the first
 * few words. Anything already in a set is excluded, and so is this listing.
 */
export async function partCandidates(book: {
  id: number;
  title: string;
}): Promise<{ id: number; title: string; volumes: number | null; price_pence: number }[]> {
  const stem = clipToBytes((book.title.split(':')[0] ?? book.title).trim(), LIKE_BYTES);
  if (stem.length < 6) return [];

  const { results } = await env.DB.prepare(
    `SELECT id, title, volumes, price_pence
       FROM books
      WHERE id <> ? AND set_id IS NULL AND status <> 'archived'
        AND deleted_at IS NULL
        AND title LIKE ? || '%'
      ORDER BY title
      LIMIT 12`,
  )
    .bind(book.id, stem)
    .all<{ id: number; title: string; volumes: number | null; price_pence: number }>();
  return results;
}

export interface BookScope {
  q?: string | null;
  filter?: BookFilter;
  /** A shelf path, including everything beneath it. */
  shelf?: string | null;
  /** Only books already in this sale, applied in SQL rather than after paging. */
  inSale?: number | null;
}

/**
 * The WHERE that turns a set of filters into a set of listings.
 *
 * Extracted so that the page the owner is looking at and "everything matching
 * this filter" are resolved by the same code. A bulk action that rebuilt this
 * itself would eventually select a different thirty-eight books than the thirty
 * -eight the chip promised, and the owner would have no way of telling.
 */
export function bookListWhere(opts: BookScope): { where: string; binds: unknown[] } {
  const search = opts.q?.trim();
  const filter = opts.filter && filter_valid(opts.filter) ? opts.filter : 'all';

  /*
   * A shipment's books are not listings yet.
   *
   * They live in `books` so that orders, holds and the arrival logic need no
   * knowledge of shipments - but a paste of sixty titles would otherwise land
   * sixty draft rows in this list, and two shipments would bury everything the
   * owner actually sells. They have their own page until one is promoted, at
   * which point `shipment_id` is cleared and it appears here like any other.
   */
  /*
   * The bin is hidden everywhere except in the one filter that is the bin.
   *
   * Written as a base clause rather than folded into each FILTER_SQL entry so
   * that a new filter is deleted-safe the moment it is added, without its author
   * having to know this rule exists. `deleted` is the single exception, and it
   * opts out by name rather than by the absence of anything.
   */
  const clauses: string[] = ['b.shipment_id IS NULL'];
  if (filter !== 'deleted') clauses.push('b.deleted_at IS NULL');
  const binds: unknown[] = [];

  if (search) {
    /* Clipped for the same reason as `partCandidates`: the two `%` count
       towards the ceiling too, so this leaves room for them. */
    const needle = clipToBytes(search, LIKE_BYTES);
    clauses.push('(b.title LIKE ? OR b.title_ar LIKE ? OR b.title_ur LIKE ? OR b.slug LIKE ?)');
    binds.push(`%${needle}%`, `%${needle}%`, `%${needle}%`, `%${needle}%`);
  }
  if (FILTER_SQL[filter]) clauses.push(FILTER_SQL[filter]);

  /*
   * Both of these have to be in SQL, not applied to a page of results.
   *
   * The sale editor read a `shelf` parameter and never passed it anywhere, and
   * narrowed "only ones in the sale" by filtering at most 200 already-fetched
   * rows - so on a catalogue of 225 the filter silently hid members, and the
   * pager counted books that the filter would remove.
   */
  const shelf = opts.shelf?.trim();
  if (shelf) {
    clauses.push(
      `EXISTS (SELECT 1 FROM book_categories bc JOIN categories c ON c.id = bc.category_id
                WHERE bc.book_id = b.id AND (c.path = ? OR c.path LIKE ? || '/%'))`,
    );
    binds.push(shelf, shelf);
  }
  if (opts.inSale) {
    clauses.push('EXISTS (SELECT 1 FROM sale_items si WHERE si.book_id = b.id AND si.sale_id = ?)');
    binds.push(opts.inSale);
  }

  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', binds };
}

/**
 * Every listing a set of filters matches, as ids.
 *
 * For "apply this to all 38 matching", where the owner is acting on a
 * description of a set rather than on rows they have ticked. Capped one above
 * the ceiling the caller enforces, so "too many" is a length test rather than a
 * second COUNT - and so a mis-aimed bulk action cannot quietly load the whole
 * catalogue into memory.
 */
export async function bookIdsMatching(opts: BookScope, cap = 1000): Promise<number[]> {
  const { where, binds } = bookListWhere(opts);
  const { results } = await env.DB.prepare(
    `SELECT b.id FROM books b ${where} ORDER BY b.id LIMIT ?`,
  )
    .bind(...binds, cap + 1)
    .all<{ id: number }>();
  return results.map((r) => r.id);
}

export async function listBooksAdmin(opts: BookScope & {
  sort?: BookSort;
  page?: number;
  perPage?: number;
} = {}): Promise<BookListResult> {
  const sort = opts.sort && sort_valid(opts.sort) ? opts.sort : 'recent';
  const perPage = Math.min(Math.max(opts.perPage ?? 40, 10), 200);
  const page = Math.max(1, opts.page ?? 1);
  const { where, binds } = bookListWhere(opts);

  const [countRow, listRes] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM books b ${where}`)
      .bind(...binds)
      .first<{ n: number }>(),
    env.DB.prepare(
      `SELECT b.id, b.slug, b.title, b.title_ar, b.title_ur, b.language,
              b.price_pence, b.stock, b.reserved,
              (b.stock - b.reserved) AS available, b.status, b.telegram_message_id,
              b.announced_by_hand, b.deleted_at,
              (SELECT image_key FROM book_images WHERE book_id = b.id ORDER BY sort LIMIT 1) AS image_key,
              (SELECT MIN(i.width, CAST(i.height * 5.0 / 7.0 AS INTEGER))
                 FROM book_images i
                WHERE i.book_id = b.id AND i.sort = 0
                  AND i.width > 0 AND i.height > 0) AS usable_width,
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
  /*
   * Every count carries the same deleted rule its own filter does.
   *
   * `listBooksAdmin` hides the bin from every filter but `deleted`, so each chip
   * here has to be counted the same way or it promises work the page it leads to
   * does not show - the exact failure the note below already warns about, now
   * with a second way to happen. `all` counts what is really there; `deleted`
   * counts only the bin; everything else counts its own condition among the
   * listings that are not in it.
   */
  const parts = (Object.keys(FILTER_SQL) as BookFilter[]).map((key) =>
    key === 'all'
      ? 'SUM(CASE WHEN b.deleted_at IS NULL THEN 1 ELSE 0 END) AS "all"'
      : key === 'deleted'
        ? `SUM(CASE WHEN ${FILTER_SQL[key]} THEN 1 ELSE 0 END) AS "deleted"`
        : `SUM(CASE WHEN b.deleted_at IS NULL AND (${FILTER_SQL[key]}) THEN 1 ELSE 0 END) AS "${key}"`,
  );
  // The same exclusion the list itself makes, or the chips would promise work
  // that the page they lead to does not show.
  const row = await env.DB.prepare(
    `SELECT ${parts.join(', ')} FROM books b WHERE b.shipment_id IS NULL`,
  ).first<Record<string, number>>();
  return (row ?? {}) as Record<BookFilter, number>;
}

export interface AdminBookDetail extends AdminBookRow {
  delivery_version: number;
  incoming: number;
  reserved_incoming: number;
  incoming_vague: string | null;
  incoming_month: string | null;
  volumes: number | null;
  isbn: string | null;
  set_id: number | null;
  set_from: number | null;
  set_to: number | null;
  telegram_note: string | null;
  description_html: string | null;
  updated_at: number;
  telegram_posted_at: number | null;
  author: string | null;
  publisher: string | null;
  legacy_slug: string | null;
  /** The channel post as the owner rewrote it; null while the shop writes it. */
  telegram_caption: string | null;
  /** Every message the channel post occupies, so a delete can clear all of it. */
  telegram_album_ids: string | null;
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
