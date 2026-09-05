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
  /** How many books are on it, and how many copies are spoken for. */
  items: number;
  copies: number;
  claimed: number;
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
     FROM books b WHERE b.shipment_id = s.id) AS claimed`;

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
): Promise<number> {
  const usable = lines.filter((l) => l.title && l.pricePence !== null);
  if (!usable.length) return 0;

  const statements = usable.map((line, i) => {
    const script = line.script;
    /*
     * The script title goes in `title` as well as its own column. `title` is
     * NOT NULL and is what the portal lists, and leaving `title_ar`/`title_ur`
     * empty would make the generated `language` column call an Arabic book
     * English - and being generated, it cannot be corrected except at source.
     */
    const titleAr = script === 'arabic' ? line.title : null;
    const titleUr = script === 'urdu' ? line.title : null;
    return env.DB.prepare(
      `INSERT INTO books
         (slug, title, title_ar, title_ur, price_pence, volumes, stock, reserved,
          status, incoming, reserved_incoming, shipment_id, shipment_sort)
       VALUES (?,?,?,?,?,?,0,0,'draft',?,0,?,?)`,
    ).bind(
      `sh${shipmentId}-${i + 1}`,
      line.title,
      titleAr,
      titleUr,
      line.pricePence,
      line.volumes,
      line.stock ?? 0,
      shipmentId,
      line.index ?? i + 1,
    );
  });

  await env.DB.batch(statements);
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
