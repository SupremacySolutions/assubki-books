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
  SELECT b.id, b.slug, b.title, b.title_ar, b.price_pence, b.stock, b.reserved,
         (b.stock - b.reserved) AS available,
         i.image_key, i.width, i.height,
         (SELECT group_concat(c2.slug) FROM book_categories bc2
            JOIN categories c2 ON c2.id = bc2.category_id
           WHERE bc2.book_id = b.id) AS cat_slugs
    FROM books b
    LEFT JOIN book_images i ON i.book_id = b.id AND i.sort = 0
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

/** Live book count per category, counting descendants into their parent. */
export async function categoryCounts(): Promise<Map<number, number>> {
  const { results } = await db()
    .prepare(
      `SELECT c.id, COUNT(DISTINCT b.id) AS n
         FROM categories c
         JOIN categories d ON d.path = c.path OR d.path LIKE c.path || '/%'
         JOIN book_categories bc ON bc.category_id = d.id
         JOIN books b ON b.id = bc.book_id AND b.status = 'live'
        GROUP BY c.id`,
    )
    .all<{ id: number; n: number }>();
  return new Map(results.map((r) => [r.id, r.n]));
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

  const countSql =
    `SELECT COUNT(DISTINCT b.id) AS n FROM books b` +
    (match ? ' JOIN books_fts f ON f.rowid = b.id' : '') +
    whereSql;

  const [countRow, listRes] = await Promise.all([
    db().prepare(countSql).bind(...binds).first<{ n: number }>(),
    db()
      .prepare(`${from}${whereSql}${order} LIMIT ? OFFSET ?`)
      .bind(...binds, perPage, (page - 1) * perPage)
      .all<BookRow>(),
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

// ---------------------------------------------------------------------------
// Single book
// ---------------------------------------------------------------------------

export async function bookBySlug(slug: string): Promise<BookDetail | null> {
  const book = await db()
    .prepare(
      `SELECT b.*, (b.stock - b.reserved) AS available, NULL AS image_key,
              NULL AS width, NULL AS height, NULL AS cat_slugs
         FROM books b WHERE b.slug = ? AND b.status != 'archived'`,
    )
    .bind(slug)
    .first<BookDetail>();
  if (!book) return null;

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
  return results;
}

/** Books for the home shelf - in stock, with a cover, most recent first. */
export async function shelfBooks(limit = 18): Promise<BookRow[]> {
  const { results } = await db()
    .prepare(
      `${BOOK_SELECT}
        WHERE b.status = 'live' AND (b.stock - b.reserved) > 0 AND i.image_key IS NOT NULL
        ORDER BY b.created_at DESC, b.id DESC LIMIT ?`,
    )
    .bind(limit)
    .all<BookRow>();
  return results;
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
  return results;
}
