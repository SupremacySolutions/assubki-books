/**
 * Shipments: a box of books, from a pasted list to a shelf.
 *
 * A shipment item is an ordinary `books` row carrying `shipment_id`. Nothing
 * else in the shop needs to know that - orders, holds, threads and the arrival
 * logic all treat it as a book with a delivery coming, which is what it is.
 *
 * The four states are worth naming, because each closes a door:
 *
 *   draft   - being pasted and checked. Nobody outside the portal can see it.
 *   open    - customers can reserve. This is the only state a reservation can
 *             be created in, enforced in the order query rather than the UI.
 *   arrived - the box landed. The list stays readable so people can see what
 *             came, but nothing new can be claimed.
 *   closed  - put away.
 */

import { env } from 'cloudflare:workers';
import type { ParsedLine } from './shipment-parse';
import { foldArabic, likeNeedle } from './like';
import { STUCK_AFTER } from './shipment-notify';

export type ShipmentStatus = 'draft' | 'open' | 'arrived' | 'closed';

export interface Shipment {
  id: number;
  title: string;
  note: string | null;
  status: ShipmentStatus;
  incoming_vague: string | null;
  incoming_month: string | null;
  created_at: number;
  opened_at: number | null;
  arrived_at: number | null;
  delivery_version: number;
  /** How many books are on it, and how many copies are spoken for. */
  items: number;
  copies: number;
  claimed: number;
  /** Distinct customers still waiting on a copy from this box. */
  orders_waiting: number;
  /** Rows a customer could not reserve: no title, no price, or no count. */
  holes: number;
  /** Copies nobody claimed, waiting to be turned into ordinary listings. */
  spare: number;
  /** Customers the arrival message keeps failing to reach. */
  stuck: number;
}

export interface ShipmentItem {
  id: number;
  slug: string;
  title: string;
  title_ar: string | null;
  title_ur: string | null;
  price_pence: number;
  volumes: number | null;
  incoming: number;
  reserved_incoming: number;
  stock: number;
  /** Held by a filled claim. What is left to sell is stock less this. */
  reserved: number;
  status: string;
  shipment_sort: number | null;
}

const COUNTS = `
  (SELECT COUNT(*)                    FROM books b WHERE b.shipment_id = s.id) AS items,
  (SELECT COALESCE(SUM(b.incoming),0) FROM books b WHERE b.shipment_id = s.id) AS copies,
  (SELECT COALESCE(SUM(b.reserved_incoming),0)
     FROM books b WHERE b.shipment_id = s.id) AS claimed,
  /* People, not copies. The header counts customers waiting on this box, and a
     claim that has been filled is no longer waiting - which is why this counts
     open claims rather than order rows. */
  (SELECT COUNT(DISTINCT oi.order_id)
     FROM order_items oi
     JOIN books b  ON b.id = oi.book_id
     JOIN orders o ON o.id = oi.order_id
    WHERE b.shipment_id = s.id AND oi.from_incoming = 1
      AND o.status NOT IN ('cancelled','expired')) AS orders_waiting,
  /* What the index needs to say what each shipment is waiting for, rather than
     making the owner open every one of them to find out. */
  (SELECT COUNT(*) FROM books b WHERE b.shipment_id = s.id
     AND (TRIM(b.title) = '' OR b.price_pence <= 0
          OR (b.incoming <= 0 AND s.status IN ('draft','open')))) AS holes,
  (SELECT COALESCE(SUM(CASE WHEN b.incoming = 0 THEN MAX(0, b.stock - b.reserved) ELSE 0 END),0)
     FROM books b WHERE b.shipment_id = s.id) AS spare,
  (SELECT COUNT(*) FROM shipment_notices n
    WHERE n.shipment_id = s.id AND n.sent_at IS NULL
      AND n.attempts >= ${STUCK_AFTER}) AS stuck`;

export async function listShipments(): Promise<Shipment[]> {
  const { results } = await env.DB.prepare(
    `SELECT s.*, ${COUNTS} FROM shipments s
      ORDER BY CASE s.status WHEN 'open' THEN 0 WHEN 'draft' THEN 1
                             WHEN 'arrived' THEN 2 ELSE 3 END,
               s.created_at DESC`,
  ).all<Shipment>();
  return results;
}

export async function getShipment(id: number): Promise<Shipment | null> {
  return env.DB.prepare(`SELECT s.*, ${COUNTS} FROM shipments s WHERE s.id = ?`)
    .bind(id)
    .first<Shipment>();
}

/**
 * The books on a shipment as a customer sees them, with what is left to claim.
 *
 * `free` is the same arithmetic the rest of the shop uses for a delivery -
 * what is coming, less what is already spoken for - so a shipment page and a
 * book page can never disagree about whether a copy is available.
 */
/** A page of a shipment's list. A big shipment is read a screen at a time. */
export const SHIPMENT_PAGE = 24;

/**
 * One page of a shipment, for the customer's page.
 *
 * A shipment can carry hundreds of titles, and reading all of them to render
 * twenty is both a slower page and a bigger bill against a database charged
 * by rows read. The count is a separate statement rather than a window
 * function so the paged query stays a plain indexed range scan.
 */
export type PublicFilter = 'available' | 'all' | 'sets';

export const PUBLIC_FILTERS: PublicFilter[] = ['available', 'all', 'sets'];

export function asPublicFilter(value: string | null, fallback: PublicFilter): PublicFilter {
  return PUBLIC_FILTERS.includes(value as PublicFilter) ? (value as PublicFilter) : fallback;
}

export async function publicShipmentPage(
  id: number,
  page = 1,
  perPage = SHIPMENT_PAGE,
  opts: { q?: string; filter?: PublicFilter } = {},
): Promise<{
  items: (ShipmentItem & { free: number })[];
  total: number;
  page: number;
  pages: number;
  counts: Record<PublicFilter, number>;
}> {
  const filter = opts.filter ?? 'all';
  /* Same as the owner's page: whole numbers only, because these two reach the
     SQL as text rather than as bound values. */
  const size = Math.max(1, Math.min(200, Math.trunc(perPage)));
  const needle = likeNeedle(foldArabic(opts.q ?? ''));

  /* Three hundred titles with no way to look for one is the real problem with
     the built page; paging thirteen pages to find a book somebody told you
     about is worse than the scroll. The same folding the owner's search uses,
     so the two boxes behave alike. */
  const search = needle
    ? ` AND (${folded('LOWER(title)')} LIKE ?2 ESCAPE '\\'
          OR ${folded("LOWER(COALESCE(title_ar,''))")} LIKE ?2 ESCAPE '\\'
          OR ${folded("LOWER(COALESCE(title_ur,''))")} LIKE ?2 ESCAPE '\\')`
    : '';
  const bindSearch = needle ? [needle] : [];

  const counted = await env.DB.prepare(
    `SELECT COUNT(*) AS all_n,
            COALESCE(SUM(CASE WHEN incoming - reserved_incoming > 0 THEN 1 ELSE 0 END),0) AS available_n,
            COALESCE(SUM(CASE WHEN volumes > 1 THEN 1 ELSE 0 END),0) AS sets_n
       FROM books WHERE shipment_id = ?1${search}`,
  )
    .bind(id, ...bindSearch)
    .first<{ all_n: number; available_n: number; sets_n: number }>();

  const where =
    filter === 'available'
      ? ' AND incoming - reserved_incoming > 0'
      : filter === 'sets'
        ? ' AND volumes > 1'
        : '';
  const total =
    filter === 'available'
      ? (counted?.available_n ?? 0)
      : filter === 'sets'
        ? (counted?.sets_n ?? 0)
        : (counted?.all_n ?? 0);

  const pages = Math.max(1, Math.ceil(total / size));
  const at = Math.min(Math.max(1, page), pages);

  const { results } = await env.DB.prepare(
    `SELECT id, slug, title, title_ar, title_ur, price_pence, volumes,
            incoming, reserved_incoming, stock, reserved, status, shipment_sort,
            MAX(0, incoming - reserved_incoming) AS free
       FROM books WHERE shipment_id = ?1${search}${where}
      ORDER BY shipment_sort, id
      LIMIT ${size} OFFSET ${(at - 1) * size}`,
  )
    .bind(id, ...bindSearch)
    .all<ShipmentItem & { free: number }>();

  return {
    items: results,
    total,
    page: at,
    pages,
    counts: {
      all: counted?.all_n ?? 0,
      available: counted?.available_n ?? 0,
      sets: counted?.sets_n ?? 0,
    },
  };
}

/**
 * Just the rows somebody actually chose.
 *
 * The checkout needs the price and the remaining count of the titles in the
 * basket and nothing else, so it asks for those rather than reading a whole
 * shipment to find four of them. Ids are filtered to integers by the caller
 * and the shipment is named in the WHERE, so a forged id reaches nothing.
 */
export async function publicShipmentItemsByIds(
  shipmentId: number,
  ids: number[],
): Promise<(ShipmentItem & { free: number })[]> {
  if (!ids.length) return [];
  const holes = ids.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT id, slug, title, title_ar, title_ur, price_pence, volumes,
            incoming, reserved_incoming, stock, reserved, status, shipment_sort,
            MAX(0, incoming - reserved_incoming) AS free
       FROM books WHERE shipment_id = ? AND id IN (${holes})
      ORDER BY shipment_sort, id`,
  )
    .bind(shipmentId, ...ids)
    .all<ShipmentItem & { free: number }>();
  return results;
}

export async function publicShipmentItems(id: number): Promise<
  (ShipmentItem & { free: number })[]
> {
  const { results } = await env.DB.prepare(
    `SELECT id, slug, title, title_ar, title_ur, price_pence, volumes,
            incoming, reserved_incoming, stock, reserved, status, shipment_sort,
            MAX(0, incoming - reserved_incoming) AS free
       FROM books WHERE shipment_id = ?
      ORDER BY shipment_sort, id`,
  )
    .bind(id)
    .all<ShipmentItem & { free: number }>();
  return results;
}

/** The books on a shipment, in the order the owner arranged them. */
export async function shipmentItems(id: number): Promise<ShipmentItem[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, slug, title, title_ar, title_ur, price_pence, volumes,
            incoming, reserved_incoming, stock, reserved, status, shipment_sort
       FROM books WHERE shipment_id = ?
      ORDER BY shipment_sort, id`,
  )
    .bind(id)
    .all<ShipmentItem>();
  return results;
}

export async function createShipment(fields: {
  title: string;
  note: string | null;
  vague: string | null;
  month: string | null;
}): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO shipments (title, note, incoming_vague, incoming_month)
     VALUES (?,?,?,?) RETURNING id`,
  )
    .bind(fields.title, fields.note, fields.vague, fields.month)
    .first<{ id: number }>();
  return row!.id;
}

/**
 * The next free number in this shipment's slug series.
 *
 * The import numbers its rows `sh12-1`, `sh12-2` and so on, which is unique by
 * construction only for a single paste into an empty shipment. A second paste,
 * or a row added by hand, would start the count again and collide on
 * `books.slug`, which is UNIQUE - the insert fails and the owner is told
 * nothing useful.
 *
 * So the series continues from the highest number already issued rather than
 * from how many rows are on the shipment now. It reads every slug ever issued
 * under this prefix, including a row that has since been promoted out of the
 * shipment and still carries its imported slug, so a number is never handed
 * out twice.
 */
async function nextSlugIndex(shipmentId: number): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(MAX(CAST(SUBSTR(slug, LENGTH('sh' || ?1 || '-') + 1) AS INTEGER)), 0) AS n
       FROM books WHERE slug LIKE 'sh' || ?1 || '-%'`,
  )
    .bind(shipmentId)
    .first<{ n: number }>();
  return (row?.n ?? 0) + 1;
}

/**
 * The pasted list, as rows in `books`.
 *
 * The slug is arithmetic - `sh12-4` - and not derived from the title, which
 * matters more than it looks. `slugify` strips Arabic entirely, so every line
 * of an Arabic list produces the same empty base; `uniqueSlug` resolves that
 * by querying once per attempt, so row 40 costs 40 reads and a 60-row paste
 * costs about 1,800 in one request before giving up at its 59th try. A number
 * that is unique by construction costs none. The slug is re-derived from a
 * real title when the item is promoted to a listing, which is the only moment
 * it becomes an address anybody can see.
 *
 * Written in one batch so a list either lands whole or not at all.
 */
export async function importLines(
  shipmentId: number,
  lines: ParsedLine[],
  /*
   * The shipment's expected date, copied onto every book it carries.
   *
   * Stored twice on purpose. The shipment owns it - one field the owner edits,
   * and `details.ts` writes both - but everything that talks to a customer
   * about an order reads it off the book: the confirmation email, the order
   * page and the journey strip all ask "when is the line I am waiting on
   * due?", and a book with no answer made them say "due shortly" while the
   * shipment page said "expected late November 2026". Same shop, two dates.
   */
  when: { vague: string | null; month: string | null } = { vague: null, month: null },
): Promise<number> {
  /*
   * A line the parser could not read is kept, not dropped.
   *
   * It used to be counted in a flash message and discarded, which told the
   * owner six titles had been lost and gave no way to get them back - the
   * supplier's message would have to be pasted again in full. So an unreadable
   * line becomes a row like any other, carrying whatever text was on it, with
   * a nought where the price should be. That is exactly the shape of a row the
   * "needs fixing" filter is for, and `openShipment` already refuses to open a
   * shipment carrying one, so nothing half-read can reach a customer.
   */
  const usable = lines.filter((l) => (l.title || l.raw).trim());
  if (!usable.length) return 0;

  const from = await nextSlugIndex(shipmentId);
  const data=JSON.stringify(usable.map((line,i)=>{
    const title = (line.title || line.raw).trim().slice(0, 200);
    const readable = Boolean(line.title) && line.pricePence !== null;
    return {
      slug:`sh${shipmentId}-${from+i}`,title,
      ar:readable&&line.script==='arabic'?title:null,
      ur:readable&&line.script==='urdu'?title:null,
      price:line.pricePence??0,volumes:line.volumes,incoming:line.stock??0,
      sort:line.index??i+1,
    };
  }));
  await env.DB.prepare(`INSERT INTO books
    (slug,title,title_ar,title_ur,price_pence,volumes,stock,reserved,status,incoming,reserved_incoming,
     incoming_vague,incoming_month,shipment_id,shipment_sort)
    SELECT json_extract(value,'$.slug'),json_extract(value,'$.title'),json_extract(value,'$.ar'),
      json_extract(value,'$.ur'),json_extract(value,'$.price'),json_extract(value,'$.volumes'),0,0,'draft',
      json_extract(value,'$.incoming'),0,?2,?3,?4,json_extract(value,'$.sort') FROM json_each(?1)`)
    .bind(data,when.month?when.vague:null,when.month,shipmentId).run();
  return usable.length;
}

/**
 * Opening a shipment to customers.
 *
 * Refused while any row is unfinished. A customer reserving a book with no
 * price is an order the shop cannot fulfil, and a row with no copies coming is
 * a promise of nothing - both are worth catching here rather than explaining
 * afterwards.
 */
export async function openShipment(id: number): Promise<{ ok: boolean; why?: string }> {
  const bad = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM books
      WHERE shipment_id = ? AND (title IS NULL OR title = '' OR price_pence <= 0 OR incoming <= 0)`,
  )
    .bind(id)
    .first<{ n: number }>();
  if ((bad?.n ?? 0) > 0) {
    return { ok: false, why: `${bad!.n} of these still needs a title, a price or a number of copies` };
  }

  const empty = await env.DB.prepare('SELECT COUNT(*) AS n FROM books WHERE shipment_id = ?')
    .bind(id)
    .first<{ n: number }>();
  if ((empty?.n ?? 0) === 0) return { ok: false, why: 'there is nothing on this shipment yet' };

  // Conditional, so two clicks cannot reopen an arrived shipment.
  const done = await env.DB.prepare(
    `UPDATE shipments SET status = 'open', opened_at = unixepoch(), updated_at = unixepoch()
      WHERE id = ? AND status = 'draft'`,
  )
    .bind(id)
    .run();
  return done.meta.changes ? { ok: true } : { ok: false, why: 'this shipment is not a draft' };
}

/** Put away. Reservations are already shut; this only tidies the list. */
export async function closeShipment(id: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE shipments SET status = 'closed', updated_at = unixepoch()
      WHERE id = ? AND status = 'arrived'`,
  )
    .bind(id)
    .run();
}

/**
 * The shipments a customer may see.
 *
 * Everything except drafts, so a list stays readable after the box has landed -
 * people want to see what came, and a shipment that vanished the moment it
 * arrived would look like it had been withdrawn.
 */
export async function publicShipments(): Promise<Shipment[]> {
  const { results } = await env.DB.prepare(
    `SELECT s.*, ${COUNTS} FROM shipments s
      WHERE s.status IN ('open','arrived')
      ORDER BY CASE s.status WHEN 'open' THEN 0 ELSE 1 END, s.created_at DESC`,
  ).all<Shipment>();
  return results;
}

/**
 * A page of a shipment as the owner works on it.
 *
 * The customer's page and this one page the same rows for different reasons.
 * A customer is browsing; the owner is hunting for one title among three
 * hundred to put a price on it, which is why this one also searches and
 * filters. Both exist because a shipment can carry a few hundred titles and
 * rendering all of them was costing a page of forty screens and a read of
 * every row to show twenty-five.
 */
export const ADMIN_SHIPMENT_PAGE = 25;

export type ShipmentFilter = 'all' | 'fixing' | 'claimed' | 'unclaimed';

export const SHIPMENT_FILTERS: ShipmentFilter[] = ['all', 'fixing', 'claimed', 'unclaimed'];

export function asFilter(value: string | null): ShipmentFilter {
  return SHIPMENT_FILTERS.includes(value as ShipmentFilter) ? (value as ShipmentFilter) : 'all';
}

/**
 * Arabic as it is stored, reduced to Arabic as it is typed.
 *
 * The supplier's list arrives fully pointed and nobody searches that way, so
 * both sides of the comparison have their marks stripped and their alef and
 * ya variants folded. It is a chain of REPLACE rather than a stored column
 * because a LIKE '%x%' scans regardless - no index is being given up - and a
 * shipment is a few hundred rows, not the catalogue.
 *
 * `foldArabic` in `like.ts` is the same transformation in TypeScript, applied
 * to what the owner typed. The two must be changed together.
 */
const MARKS = ['ً','ٌ','ٍ','َ','ُ','ِ','ّ','ْ','ٰ','ـ'];
const FOLDS: [string, string][] = [
  ['آ','ا'], ['أ','ا'], ['إ','ا'], ['ٱ','ا'],
  ['ى','ي'], ['ة','ه'],
];
function folded(column: string): string {
  let expr = column;
  for (const mark of MARKS) expr = `REPLACE(${expr},'${mark}','')`;
  for (const [from, to] of FOLDS) expr = `REPLACE(${expr},'${from}','${to}')`;
  return expr;
}

/**
 * A row is unusable while it has no title, no price, or no copies coming.
 *
 * `openShipment` refuses a list with any of these in it, so the same three
 * conditions decide the "needs fixing" filter - one definition, and the
 * button's refusal is already explained by the time it happens.
 *
 * After a delivery has landed `incoming` is nought on every title that came,
 * which is the shipment working correctly rather than three hundred broken
 * rows, so the copies clause only applies while copies are still expected.
 */
function fixingSql(expectingMore: boolean): string {
  return expectingMore
    ? `(TRIM(title) = '' OR price_pence <= 0 OR incoming <= 0)`
    : `(TRIM(title) = '' OR price_pence <= 0)`;
}

export interface AdminShipmentPage {
  items: (ShipmentItem & { free: number; spare: number })[];
  /** Rows matching the current search and filter. */
  total: number;
  page: number;
  pages: number;
  /** Every chip's count, under the current search but not the current filter. */
  counts: Record<ShipmentFilter, number>;
}

export async function adminShipmentPage(
  id: number,
  opts: {
    q?: string;
    filter?: ShipmentFilter;
    page?: number;
    perPage?: number;
    /** False once the box has landed, so filled rows stop reading as broken. */
    expectingMore?: boolean;
  } = {},
): Promise<AdminShipmentPage> {
  /* Interpolated into the SQL below rather than bound, so they are forced to
     whole numbers here - a page size is arithmetic, never text. */
  const perPage = Math.max(1, Math.min(200, Math.trunc(opts.perPage ?? ADMIN_SHIPMENT_PAGE)));
  const filter = opts.filter ?? 'all';
  const expectingMore = opts.expectingMore ?? true;
  const needle = likeNeedle(foldArabic(opts.q ?? ''));

  /* The search is one bound value used three times, so a title in any of the
     three scripts is found by the same box. */
  const search = needle
    ? ` AND (${folded('LOWER(title)')} LIKE ?2 ESCAPE '\\'
          OR ${folded("LOWER(COALESCE(title_ar,''))")} LIKE ?2 ESCAPE '\\'
          OR ${folded("LOWER(COALESCE(title_ur,''))")} LIKE ?2 ESCAPE '\\')`
    : '';
  const bindSearch = needle ? [needle] : [];

  const fixing = fixingSql(expectingMore);
  const counts = await env.DB.prepare(
    `SELECT COUNT(*) AS all_n,
            COALESCE(SUM(CASE WHEN ${fixing} THEN 1 ELSE 0 END),0) AS fixing_n,
            COALESCE(SUM(CASE WHEN reserved_incoming > 0 THEN 1 ELSE 0 END),0) AS claimed_n,
            COALESCE(SUM(CASE WHEN reserved_incoming = 0 THEN 1 ELSE 0 END),0) AS unclaimed_n
       FROM books WHERE shipment_id = ?1${search}`,
  )
    .bind(id, ...bindSearch)
    .first<{ all_n: number; fixing_n: number; claimed_n: number; unclaimed_n: number }>();

  const where =
    filter === 'fixing'
      ? ` AND ${fixing}`
      : filter === 'claimed'
        ? ' AND reserved_incoming > 0'
        : filter === 'unclaimed'
          ? ' AND reserved_incoming = 0'
          : '';

  const total =
    filter === 'fixing'
      ? (counts?.fixing_n ?? 0)
      : filter === 'claimed'
        ? (counts?.claimed_n ?? 0)
        : filter === 'unclaimed'
          ? (counts?.unclaimed_n ?? 0)
          : (counts?.all_n ?? 0);

  const pages = Math.max(1, Math.ceil(total / perPage));
  const at = Math.min(Math.max(1, opts.page ?? 1), pages);

  const { results } = await env.DB.prepare(
    `SELECT id, slug, title, title_ar, title_ur, price_pence, volumes,
            incoming, reserved_incoming, stock, reserved, status, shipment_sort,
            MAX(0, incoming - reserved_incoming) AS free,
            /* What is left to sell once the claims on it are honoured. A title
               still expecting copies has nothing spare yet by definition. */
            CASE WHEN incoming > 0 THEN 0 ELSE MAX(0, stock - reserved) END AS spare
       FROM books WHERE shipment_id = ?1${search}${where}
      ORDER BY shipment_sort, id
      LIMIT ${perPage} OFFSET ${(at - 1) * perPage}`,
  )
    .bind(id, ...bindSearch)
    .all<ShipmentItem & { free: number; spare: number }>();

  return {
    items: results,
    total,
    page: at,
    pages,
    counts: {
      all: counts?.all_n ?? 0,
      fixing: counts?.fixing_n ?? 0,
      claimed: counts?.claimed_n ?? 0,
      unclaimed: counts?.unclaimed_n ?? 0,
    },
  };
}

/**
 * The titles somebody is waiting on, first.
 *
 * A receipt for three hundred titles is unreadable if the six that matter are
 * scattered through it, so the receive page asks for them separately and
 * collapses the rest behind a disclosure. The remainder still post their
 * expected count, so leaving them alone records them as arriving in full.
 */
export async function receiveRows(id: number): Promise<{
  claimed: (ShipmentItem & { free: number })[];
  rest: (ShipmentItem & { free: number })[];
}> {
  const { results } = await env.DB.prepare(
    `SELECT id, slug, title, title_ar, title_ur, price_pence, volumes,
            incoming, reserved_incoming, stock, reserved, status, shipment_sort,
            MAX(0, incoming - reserved_incoming) AS free
       FROM books WHERE shipment_id = ?
      ORDER BY reserved_incoming DESC, shipment_sort, id`,
  )
    .bind(id)
    .all<ShipmentItem & { free: number }>();
  return {
    claimed: results.filter((r) => r.reserved_incoming > 0),
    rest: results.filter((r) => r.reserved_incoming === 0),
  };
}

/**
 * Add one title to a shipment by hand.
 *
 * The parser drops a line it cannot read, and until now the only trace was a
 * number in a flash message - the owner was told six lines were lost and given
 * no way to put them back. This is that way. It is also how an owner adds a
 * title the supplier forgot to list.
 *
 * The insert is conditional on the shipment still being editable, so a stale
 * form cannot add a row to a box that has already landed.
 */
export async function addShipmentRow(
  shipmentId: number,
  fields: {
    title: string;
    price_pence: number;
    incoming: number;
    volumes: number | null;
    script: string;
  },
): Promise<number | null> {
  const index = await nextSlugIndex(shipmentId);
  const row = await env.DB.prepare(
    `INSERT INTO books (slug, title, title_ar, title_ur, price_pence, volumes,
                        stock, reserved, status, incoming, reserved_incoming,
                        incoming_vague, incoming_month, shipment_id, shipment_sort)
     SELECT ?2, ?3,
            CASE WHEN ?7 = 'arabic' THEN ?3 END,
            CASE WHEN ?7 = 'urdu'   THEN ?3 END,
            ?4, ?5, 0, 0, 'draft', ?6, 0,
            s.incoming_vague, s.incoming_month, s.id,
            (SELECT COALESCE(MAX(shipment_sort), 0) + 1 FROM books WHERE shipment_id = s.id)
       FROM shipments s
      WHERE s.id = ?1 AND s.status IN ('draft','open')
     RETURNING id`,
  )
    .bind(
      shipmentId,
      `sh${shipmentId}-${index}`,
      fields.title,
      fields.price_pence,
      fields.volumes,
      fields.incoming,
      fields.script,
    )
    .first<{ id: number }>();
  return row?.id ?? null;
}
