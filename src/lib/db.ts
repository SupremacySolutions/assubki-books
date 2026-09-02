/**
 * Catalogue queries.
 *
 * Everything the public site reads goes through here so the availability rule
 * (`stock - reserved`) is expressed in exactly one place. A page that computed
 * its own availability would eventually disagree with checkout.
 */

import { env } from 'cloudflare:workers';

export interface Category {
  id: number;
  slug: string;
  name: string;
  parent_id: number | null;
  path: string;
  sort: number;
}

export interface CategoryNode extends Category {
  children: CategoryNode[];
  count: number;
}

export interface BookRow {
  id: number;
  slug: string;
  title: string;
  title_ar: string | null;
  price_pence: number;
  stock: number;
  reserved: number;
  available: number;
  image_key: string | null;
  width: number | null;
  height: number | null;
  /** Only set when the listing is a set, so the card can say "4 volumes". */
  volumes: number | null;
  /** Set only for a listing that is one option of a splittable set. */
  set_id: number | null;
  set_from: number | null;
  set_to: number | null;
  /** Copies on their way to the shop, and how many are already claimed. */
  incoming: number;
  reserved_incoming: number;
  /** Free to claim now: `incoming - reserved_incoming`, never negative. */
  reservable: number;
  /** Percent off while a sale is running, or null. Never zero - a book with
      no reduction has no row in sale_items at all. */
  sale_percent: number | null;
  /** How the arrival is described: a vagueness word and a month, never a date. */
  incoming_vague: string | null;
  incoming_month: string | null;
  cat_slugs: string | null;
}

export interface BookDetail extends BookRow {
  legacy_slug: string | null;
  author: string | null;
  publisher: string | null;
  description_html: string | null;
  images: { image_key: string; alt: string | null; width: number | null; height: number | null }[];
  categories: Category[];
}

const db = () => env.DB;

const BOOK_SELECT = `
  SELECT b.id, b.slug, b.title, b.title_ar, b.price_pence, b.stock, b.reserved, b.volumes,
         b.set_id, b.set_from, b.set_to,
         b.incoming, b.reserved_incoming, b.incoming_vague, b.incoming_month,
         (b.stock - b.reserved) AS available,
         /* Free to claim from a delivery. Deliberately a separate number from
            available: one is a copy you can have now, the other is a promise
            about one that is not here yet, and a card that added them together
            would be telling the customer something untrue. */
         MAX(0, b.incoming - b.reserved_incoming) AS reservable,
         /*
          * The sale percentage, if this book is in the sale that is running.
          *
          * The sale id is a scalar subquery with no reference to the outer
          * row, so SQLite works it out once rather than per book - and the
          * partial unique index on status='live' makes it an index probe.
          * A correlated subquery here is exactly what once cost this project
          * most of its daily read budget.
          */
         si.percent_off AS sale_percent,
         i.image_key, i.width, i.height,
         (SELECT group_concat(c2.slug) FROM book_categories bc2
            JOIN categories c2 ON c2.id = bc2.category_id
           WHERE bc2.book_id = b.id) AS cat_slugs
    FROM books b
    LEFT JOIN book_images i ON i.book_id = b.id AND i.sort = 0
    LEFT JOIN sale_items si ON si.book_id = b.id
         AND si.sale_id = (SELECT id FROM sales WHERE status = 'live')
`;

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export async function allCategories(): Promise<Category[]> {
  const { results } = await db()
    .prepare('SELECT id, slug, name, parent_id, path, sort FROM categories ORDER BY sort')
    .all<Category>();
  return results;
}

/**
 * Live book count per category, counting descendants into their parent.
 *
 * **This was 95% of the database's entire read budget.** It used to roll the
 * descendants up in SQL:
 *
 *     JOIN categories d ON d.path = c.path OR d.path LIKE c.path || '/%'
 *
 * An `OR` with a `LIKE` in a join condition cannot use an index, so SQLite
 * nested-loops categories against categories against every book link - about
 * 34,700 rows read *per call*, on the home page and on every catalogue page.
 * At 164 calls a day that was 5.7 million rows against an allowance of five.
 *
 * The same answer comes from reading the 441 links once and rolling them up
 * here, where a string prefix costs nothing. Distinct book ids per ancestor,
 * so a book filed under two children of one parent still counts once.
 */
async function readCategoryCounts(): Promise<Map<number, number>> {
  const [cats, links] = await Promise.all([
    allCategories(),
    db()
      .prepare(
        `SELECT c.path AS path, bc.book_id AS bookId
           FROM book_categories bc
           JOIN categories c ON c.id = bc.category_id
           JOIN books b ON b.id = bc.book_id AND b.status = 'live'`,
      )
      .all<{ path: string; bookId: number }>(),
  ]);

  const counts = new Map<number, number>();
  for (const cat of cats) {
    const seen = new Set<number>();
    for (const link of links.results) {
      if (link.path === cat.path || link.path.startsWith(`${cat.path}/`)) seen.add(link.bookId);
    }
    counts.set(cat.id, seen.size);
  }
  return counts;
}

/**
 * Cached for a minute, like the contact handle.
 *
 * The shelves and what is on them change when the owner edits a listing, which
 * is a few times a day; this is read on the two busiest pages of the site. A
 * minute of staleness in a book count is worth nothing to anyone and saves
 * almost every call.
 */
let countsCache: { at: number; value: Map<number, number> } | null = null;

export async function categoryCounts(): Promise<Map<number, number>> {
  const now = Date.now();
  if (countsCache && now - countsCache.at < 60_000) return countsCache.value;
  const value = await readCategoryCounts();
  countsCache = { at: now, value };
  return value;
}

/** Called after a listing changes, so the owner sees their own edit at once. */
export function forgetCategoryCounts(): void {
  countsCache = null;
}

export async function categoryTree(): Promise<CategoryNode[]> {
  const [cats, counts] = await Promise.all([allCategories(), categoryCounts()]);
  const nodes = new Map<number, CategoryNode>(
    cats.map((c) => [c.id, { ...c, children: [], count: counts.get(c.id) ?? 0 }]),
  );
  const roots: CategoryNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parent_id ? nodes.get(node.parent_id) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  // Empty categories are noise in a browse sidebar.
  const prune = (list: CategoryNode[]): CategoryNode[] =>
    list.filter((n) => n.count > 0).map((n) => ({ ...n, children: prune(n.children) }));
  return prune(roots).sort((a, b) => b.count - a.count);
}

export async function categoryByPath(path: string): Promise<Category | null> {
  return db()
    .prepare('SELECT id, slug, name, parent_id, path, sort FROM categories WHERE path = ?')
    .bind(path)
    .first<Category>();
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * User input cannot go into MATCH raw - an unbalanced quote or a bare `OR` is
 * a syntax error, and FTS operators would let a visitor write their own query.
 * Each word is stripped to letters/digits (Arabic included), quoted, and the
 * last one gets a prefix wildcard so results narrow as you type.
 */
function ftsQuery(raw: string): string | null {
  const words = raw
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8);
  if (!words.length) return null;
  return words.map((w, i) => (i === words.length - 1 ? `"${w}"*` : `"${w}"`)).join(' AND ');
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export type Sort = 'relevance' | 'title' | 'price-asc' | 'price-desc' | 'newest';

export interface ListOptions {
  categoryPath?: string | null;
  q?: string | null;
  inStockOnly?: boolean;
  sort?: Sort;
  page?: number;
  perPage?: number;
}

export interface ListResult {
  books: BookRow[];
  total: number;
  page: number;
  pages: number;
  perPage: number;
}

export async function listBooks(opts: ListOptions = {}): Promise<ListResult> {
  const perPage = opts.perPage ?? 24;
  const page = Math.max(1, opts.page ?? 1);
  const where: string[] = [`b.status = 'live'`];
  const binds: unknown[] = [];
  let from = BOOK_SELECT;

  const match = opts.q ? ftsQuery(opts.q) : null;
  if (match) {
    from += ' JOIN books_fts f ON f.rowid = b.id';
    where.push('books_fts MATCH ?');
    binds.push(match);
  }

  if (opts.categoryPath) {
    // A parent shows everything beneath it: /catalogue/syllabus includes
    // Dars Nizami and Maktab.
    where.push(
      `b.id IN (SELECT bc.book_id FROM book_categories bc
                  JOIN categories c ON c.id = bc.category_id
                 WHERE c.path = ? OR c.path LIKE ? || '/%')`,
    );
    binds.push(opts.categoryPath, opts.categoryPath);
  }

  if (opts.inStockOnly) where.push('(b.stock - b.reserved) > 0');

  const whereSql = ` WHERE ${where.join(' AND ')}`;

  const sort = opts.sort ?? (match ? 'relevance' : 'title');
  const orderBy = {
    relevance: match ? 'f.rank' : 'b.title COLLATE NOCASE',
    title: 'b.title COLLATE NOCASE',
    'price-asc': 'b.price_pence ASC, b.title COLLATE NOCASE',
    'price-desc': 'b.price_pence DESC, b.title COLLATE NOCASE',
    newest: 'b.created_at DESC, b.id DESC',
  }[sort];

  // Out-of-stock titles stay browsable but sink to the bottom of every sort;
  // a shop whose first row is unavailable reads as abandoned.
  const order = ` ORDER BY (b.stock - b.reserved) > 0 DESC, ${orderBy}`;

  /*
   * How many are in stock comes off the same scan as how many there are, so
   * "42 titles · 38 in stock" costs nothing beyond the count we already ran.
   */
  const countSql =
    `SELECT COUNT(DISTINCT b.id) AS n,
            COUNT(DISTINCT CASE WHEN (b.stock - b.reserved) > 0 THEN b.id END) AS inStock
       FROM books b` +
    (match ? ' JOIN books_fts f ON f.rowid = b.id' : '') +
    whereSql;

  const [countRow, listRes] = await Promise.all([
    db().prepare(countSql).bind(...binds).first<{ n: number; inStock: number }>(),
    db()
      .prepare(`${from}${whereSql}${order} LIMIT ? OFFSET ?`)
      .bind(...binds, perPage, (page - 1) * perPage)
      .all<BookRow>(),
  ]);

  const total = countRow?.n ?? 0;
  return {
    books: await applySetAvailability(listRes.results),
    total,
    inStock: countRow?.inStock ?? 0,
    page,
    pages: Math.max(1, Math.ceil(total / perPage)),
    perPage,
  };
}

// ---------------------------------------------------------------------------
// Single book
// ---------------------------------------------------------------------------

export async function bookBySlug(slug: string): Promise<BookDetail | null> {
  const book = await db()
    .prepare(
      `SELECT b.*, (b.stock - b.reserved) AS available,
              MAX(0, b.incoming - b.reserved_incoming) AS reservable,
              (SELECT percent_off FROM sale_items
                WHERE book_id = b.id
                  AND sale_id = (SELECT id FROM sales WHERE status = 'live')) AS sale_percent,
              NULL AS image_key, NULL AS width, NULL AS height, NULL AS cat_slugs
         FROM books b WHERE b.slug = ? AND b.status != 'archived'`,
    )
    .bind(slug)
    .first<BookDetail>();
  if (!book) return null;

  // A listing that is one option of a set has no stock of its own worth
  // reading; what it can sell depends on the volumes and on what the other
  // options have taken.
  if (book.set_id) await applySetAvailability([book]);

  const [images, cats] = await Promise.all([
    db()
      .prepare('SELECT image_key, alt, width, height FROM book_images WHERE book_id = ? ORDER BY sort')
      .bind(book.id)
      .all<BookDetail['images'][number]>(),
    db()
      .prepare(
        `SELECT c.id, c.slug, c.name, c.parent_id, c.path, c.sort
           FROM categories c JOIN book_categories bc ON bc.category_id = c.id
          WHERE bc.book_id = ? ORDER BY c.path`,
      )
      .bind(book.id)
      .all<Category>(),
  ]);

  return { ...book, images: images.results, categories: cats.results };
}

/**
 * For 301ing the old WooCommerce /product/<slug>/ URLs.
 *
 * Compared case-insensitively because the two sides disagree on the case of
 * percent-escapes: WordPress stored `%d8%a7`, but the URL parser normalises the
 * incoming path to `%D8%A7`. An exact match silently sends every Arabic-slugged
 * legacy link - which is most of them - to the catalogue instead of the book.
 * LOWER() is ASCII-only in SQLite, which is exactly the range hex escapes use.
 */
export async function slugForLegacy(legacySlug: string): Promise<string | null> {
  const row = await db()
    .prepare('SELECT slug FROM books WHERE LOWER(legacy_slug) = LOWER(?)')
    .bind(legacySlug)
    .first<{ slug: string }>();
  return row?.slug ?? null;
}

export async function relatedBooks(bookId: number, limit = 6): Promise<BookRow[]> {
  const { results } = await db()
    .prepare(
      `${BOOK_SELECT}
        WHERE b.status = 'live' AND b.id != ?1
          AND b.id IN (SELECT bc.book_id FROM book_categories bc
                        WHERE bc.category_id IN
                          (SELECT category_id FROM book_categories WHERE book_id = ?1))
        ORDER BY (b.stock - b.reserved) > 0 DESC, RANDOM() LIMIT ?2`,
    )
    .bind(bookId, limit)
    .all<BookRow>();
  return applySetAvailability(results);
}

/**
 * Books for the home shelf - in stock, with a cover, most recent first.
 *
 * Deliberately not filtered by cover shape, even though the drifting strip
 * needs upright ones: these same rows are the "recently added" grid, which
 * sizes to whatever shape a cover is and shows a wide one perfectly well.
 * Narrowing the query would have quietly dropped books from that grid too.
 * The strip does its own filtering.
 */
export async function shelfBooks(limit = 18): Promise<BookRow[]> {
  const { results } = await db()
    .prepare(
      `${BOOK_SELECT}
        WHERE b.status = 'live' AND (b.stock - b.reserved) > 0 AND i.image_key IS NOT NULL
        ORDER BY b.created_at DESC, b.id DESC LIMIT ?`,
    )
    .bind(limit)
    .all<BookRow>();
  return applySetAvailability(results);
}

/**
 * Multi-volume sets in stock.
 *
 * The thing this shop is actually known for, and the reason people travel to
 * it - a syllabus set is a decision, not an impulse, so it earns a row of its
 * own rather than being scattered through "recently added".
 *
 * `volumes > 1` rather than a join on the sets tables: a set that is sold only
 * as a whole never gets a `set_id`, and it is still a set to the customer.
 */
export async function setBooks(limit = 10): Promise<BookRow[]> {
  const { results } = await db()
    .prepare(
      `${BOOK_SELECT}
        WHERE b.status = 'live' AND (b.stock - b.reserved) > 0
          AND b.volumes > 1 AND i.image_key IS NOT NULL
        ORDER BY b.volumes DESC, b.created_at DESC LIMIT ?`,
    )
    .bind(limit)
    .all<BookRow>();
  return applySetAvailability(results);
}

/**
 * Titles that have recently come back onto the shelf.
 *
 * Read from the ledger rather than a new column, because the ledger already
 * records every movement with a reason and a time - a book coming back is a
 * positive `stock` delta, and that is a fact the shop already stores rather
 * than one it has to start keeping.
 *
 * A listing being created is not a restock, and neither is a stocktake: both
 * move many books at once and would drown the row in titles that never went
 * anywhere. What is left is a book that genuinely came back.
 *
 * Cached like the shelf counts. This is a public page, and a join across the
 * ledger on every home view is exactly the shape of thing that once ate most
 * of the daily read budget.
 */
let restockedCache: { at: number; value: BookRow[] } | null = null;

export async function backInStock(limit = 10): Promise<BookRow[]> {
  const now = Date.now();
  if (restockedCache && now - restockedCache.at < 60_000) return restockedCache.value;

  const since = Math.floor(now / 1000) - 60 * 60 * 24 * 30;
  const { results } = await db()
    .prepare(
      `${BOOK_SELECT}
         JOIN (SELECT book_id, MAX(at) AS back
                 FROM stock_ledger
                WHERE field = 'stock' AND delta > 0
                  AND reason NOT IN ('listing created', 'stocktake')
                  AND at > ?
                GROUP BY book_id) r ON r.book_id = b.id
        WHERE b.status = 'live' AND (b.stock - b.reserved) > 0 AND i.image_key IS NOT NULL
        ORDER BY r.back DESC LIMIT ?`,
    )
    .bind(since, limit)
    .all<BookRow>();

  const value = await applySetAvailability(results);
  restockedCache = { at: now, value };
  return value;
}

/**
 * Fills in `available` for any listing that is part of a set.
 *
 * An ordinary listing keeps `stock - reserved`, which is what the select
 * already returned. A listing in a set has no stock of its own worth reading:
 * what it can sell is decided by the volumes it covers and by what everyone
 * else has taken.
 *
 *     available = min over the volumes it covers of
 *                   (how many of that volume are on the shelf
 *                    − how many are held by *any* option covering it)
 *
 * The sibling part is the point. Somebody holding volumes 1-2 has spoken for
 * one set's first half, so the complete set can no longer be sold that many
 * times either - which is exactly the behaviour the owner described.
 *
 * Deliberately a second query rather than a subquery inside `BOOK_SELECT`:
 * that select runs on every catalogue page, and a correlated join in it is
 * precisely what cost this database 95% of its read budget once already. Sets
 * are rare, so this runs only when one is actually on the page.
 */
async function applySetAvailability<T extends BookRow>(books: T[]): Promise<T[]> {
  const inSets = books.filter((b) => b.set_id);
  if (inSets.length === 0) return books;

  const ids = [...new Set(inSets.map((b) => b.set_id))];
  const { results } = await db()
    .prepare(
      `SELECT m.id AS bookId,
              MIN(v.have - COALESCE((
                SELECT SUM(o.reserved) FROM books o
                 WHERE o.set_id = m.set_id
                   AND v.volume BETWEEN o.set_from AND o.set_to
              ), 0)) AS available
         FROM books m
         JOIN book_set_stock v
           ON v.set_id = m.set_id AND v.volume BETWEEN m.set_from AND m.set_to
        WHERE m.set_id IN (${ids.map(() => '?').join(',')})
        GROUP BY m.id`,
    )
    .bind(...ids)
    .all<{ bookId: number; available: number }>();

  const byId = new Map(results.map((r) => [r.bookId, r.available]));
  for (const book of books) {
    if (!book.set_id) continue;
    // Never negative: an owner who lowers the shelf count below what is
    // already held should read as "none left", not as a negative number.
    book.available = Math.max(0, byId.get(book.id) ?? 0);
  }
  return books;
}

/**
 * The other ways this set can be bought.
 *
 * Every option is an ordinary listing, so this is just its siblings, ordered
 * widest first - the complete set reads as the headline and the parts as ways
 * of breaking it up, which is how the owner thinks of them.
 */
/**
 * The same, for the portal, where a draft counts.
 *
 * `setOptions` is what the shop front reads and so is filtered to live
 * listings. The owner splitting a draft set needs to see the parts they just
 * made, and filtering them out left the page still offering to build them - a
 * second set, on top of the one that already existed.
 */
export async function setOptionsForOwner(setId: number): Promise<BookRow[]> {
  const { results } = await db()
    .prepare(
      `${BOOK_SELECT}
        WHERE b.set_id = ? AND b.status <> 'archived'
        ORDER BY (b.set_to - b.set_from) DESC, b.set_from`,
    )
    .bind(setId)
    .all<BookRow>();
  return applySetAvailability(results);
}

export async function setOptions(setId: number): Promise<BookRow[]> {
  const { results } = await db()
    .prepare(
      `${BOOK_SELECT}
        WHERE b.set_id = ? AND b.status = 'live'
        ORDER BY (b.set_to - b.set_from) DESC, b.set_from`,
    )
    .bind(setId)
    .all<BookRow>();
  return applySetAvailability(results);
}

export async function catalogueStats(): Promise<{ titles: number; inStock: number }> {
  const row = await db()
    .prepare(
      `SELECT COUNT(*) AS titles,
              SUM(CASE WHEN (stock - reserved) > 0 THEN 1 ELSE 0 END) AS inStock
         FROM books WHERE status = 'live'`,
    )
    .first<{ titles: number; inStock: number }>();
  return { titles: row?.titles ?? 0, inStock: row?.inStock ?? 0 };
}

/** Resolves a list of basket ids to current price and availability. */
export async function booksByIds(ids: number[]): Promise<BookRow[]> {
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  const { results } = await db()
    .prepare(`${BOOK_SELECT} WHERE b.id IN (${placeholders}) AND b.status = 'live'`)
    .bind(...ids)
    .all<BookRow>();
  return applySetAvailability(results);
}
