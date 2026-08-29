/**
 * Baskets several people fill and one person sends.
 *
 * The shape follows the rest of the shop: holding the link is the permission,
 * the code is readable aloud, and nothing here reserves stock. Copies are taken
 * off the shelf only when the organiser submits, through the same createOrder
 * path with the same CHECK constraint behind it - so a group basket cannot
 * promise a copy that a single-customer order then takes.
 */

import { env } from 'cloudflare:workers';
import { booksByIds } from './db';

/** A week: long enough for a madrasah to collect its list, short enough to sweep. */
export const GROUP_DAYS = 7;

/** Caps. Generous for a class, mean enough that nobody can fill the table. */
export const MAX_TITLES = 100;
export const MAX_QTY = 99;
export const MAX_PEOPLE = 30;

// Same alphabet as an order reference - no 0/O or 1/I to mishear.
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function randomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return `GRP-${out}`;
}

function randomToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** A person's name as it will be shown to everyone else in the group. */
export function cleanName(raw: unknown): string {
  return String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

export interface GroupLine {
  bookId: number;
  slug: string;
  title: string;
  titleAr: string | null;
  pricePence: number;
  available: number;
  imageKey: string | null;
  qty: number;
  addedBy: string;
}

export interface GroupView {
  code: string;
  organiser: string;
  expiresAt: number;
  orderRef: string | null;
  lines: GroupLine[];
  /** Total across everyone, at today's prices. */
  subtotalPence: number;
  people: string[];
}

export async function createGroup(organiser: string): Promise<{ code: string; token: string }> {
  const token = randomToken();
  const expires = Math.floor(Date.now() / 1000) + GROUP_DAYS * 86_400;

  // A code clash is a 1-in-33-million event, not an error worth surfacing.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    try {
      await env.DB.prepare(
        `INSERT INTO group_baskets (code, token, organiser, expires_at) VALUES (?,?,?,?)`,
      )
        .bind(code, token, organiser, expires)
        .run();
      return { code, token };
    } catch (err) {
      if (String(err).includes('UNIQUE')) continue;
      throw err;
    }
  }
  throw new Error('could not allocate a group code');
}

async function findGroup(code: string, token: string) {
  const row = await env.DB.prepare(
    `SELECT id, code, token, organiser, expires_at, order_ref FROM group_baskets WHERE code = ?`,
  )
    .bind(code)
    .first<{
      id: number;
      code: string;
      token: string;
      organiser: string;
      expires_at: number;
      order_ref: string | null;
    }>();

  if (!row) return null;
  // Compared in full rather than trusted by prefix; a wrong link is not a group.
  if (row.token !== token) return null;
  if (row.expires_at < Math.floor(Date.now() / 1000) && !row.order_ref) return null;
  return row;
}

/**
 * The basket as everyone in the group sees it.
 *
 * Prices and availability come from the catalogue on every read, never from
 * what was stored when the line was added - the same rule the single-customer
 * basket follows, for the same reason.
 */
export async function getGroup(code: string, token: string): Promise<GroupView | null> {
  const group = await findGroup(code, token);
  if (!group) return null;

  const { results } = await env.DB.prepare(
    `SELECT book_id, qty, added_by FROM group_basket_items
      WHERE group_id = ? ORDER BY updated_at`,
  )
    .bind(group.id)
    .all<{ book_id: number; qty: number; added_by: string }>();

  const books = results.length ? await booksByIds([...new Set(results.map((r) => r.book_id))]) : [];
  const byId = new Map(books.map((b) => [b.id, b]));

  const lines: GroupLine[] = [];
  let subtotalPence = 0;

  for (const row of results) {
    const book = byId.get(row.book_id);
    // Delisted since it was added: dropped rather than shown as a broken row.
    if (!book) continue;
    lines.push({
      bookId: book.id,
      slug: book.slug,
      title: book.title,
      titleAr: book.title_ar,
      pricePence: book.price_pence,
      available: Math.max(0, book.available),
      imageKey: book.image_key,
      qty: row.qty,
      addedBy: row.added_by,
    });
    subtotalPence += book.price_pence * row.qty;
  }

  return {
    code: group.code,
    organiser: group.organiser,
    expiresAt: group.expires_at,
    orderRef: group.order_ref,
    lines,
    subtotalPence,
    people: [...new Set(lines.map((l) => l.addedBy))],
  };
}

export type LineResult = 'ok' | 'not-found' | 'sent' | 'full';

/**
 * Set one person's quantity for one book. Zero removes their line.
 *
 * Per person rather than per book: two people each wanting three copies is six
 * copies and two names, not a disagreement about the number three.
 */
export async function setGroupLine(
  code: string,
  token: string,
  bookId: number,
  qty: number,
  person: string,
): Promise<LineResult> {
  const group = await findGroup(code, token);
  if (!group) return 'not-found';
  if (group.order_ref) return 'sent';

  if (qty <= 0) {
    await env.DB.prepare(
      `DELETE FROM group_basket_items WHERE group_id = ? AND book_id = ? AND added_by = ?`,
    )
      .bind(group.id, bookId, person)
      .run();
    return 'ok';
  }

  const counts = await env.DB.prepare(
    `SELECT COUNT(DISTINCT book_id) AS titles, COUNT(DISTINCT added_by) AS people
       FROM group_basket_items WHERE group_id = ?`,
  )
    .bind(group.id)
    .first<{ titles: number; people: number }>();

  const known = await env.DB.prepare(
    `SELECT 1 FROM group_basket_items WHERE group_id = ? AND book_id = ? LIMIT 1`,
  )
    .bind(group.id, bookId)
    .first();
  const knownPerson = await env.DB.prepare(
    `SELECT 1 FROM group_basket_items WHERE group_id = ? AND added_by = ? LIMIT 1`,
  )
    .bind(group.id, person)
    .first();

  if ((!known && (counts?.titles ?? 0) >= MAX_TITLES) ||
      (!knownPerson && (counts?.people ?? 0) >= MAX_PEOPLE)) {
    return 'full';
  }

  await env.DB.prepare(
    `INSERT INTO group_basket_items (group_id, book_id, qty, added_by)
     VALUES (?,?,?,?)
     ON CONFLICT(group_id, book_id, added_by)
       DO UPDATE SET qty = excluded.qty, updated_at = unixepoch()`,
  )
    .bind(group.id, bookId, Math.min(qty, MAX_QTY), person)
    .run();

  return 'ok';
}

/**
 * The group's lines merged into an order, plus who wanted what.
 *
 * The breakdown travels with the order because the organiser has to hand the
 * books out at the other end, and the shop packs one parcel either way.
 */
export async function groupForOrder(
  code: string,
  token: string,
): Promise<{ items: { bookId: number; qty: number }[]; breakdown: string; organiser: string } | null> {
  const view = await getGroup(code, token);
  if (!view || view.orderRef) return null;

  const merged = new Map<number, number>();
  for (const line of view.lines) merged.set(line.bookId, (merged.get(line.bookId) ?? 0) + line.qty);

  const byPerson = new Map<string, string[]>();
  for (const line of view.lines) {
    const list = byPerson.get(line.addedBy) ?? [];
    list.push(`${line.title}${line.qty > 1 ? ` x${line.qty}` : ''}`);
    byPerson.set(line.addedBy, list);
  }

  const breakdown = [...byPerson]
    .map(([person, titles]) => `${person}: ${titles.join(', ')}`)
    .join('\n');

  return {
    items: [...merged].map(([bookId, qty]) => ({ bookId, qty })),
    breakdown,
    organiser: view.organiser,
  };
}

/** Called once the order exists, so nobody adds to a basket already sent. */
export async function markGroupSent(code: string, orderRef: string): Promise<void> {
  await env.DB.prepare(`UPDATE group_baskets SET order_ref = ? WHERE code = ?`)
    .bind(orderRef, code)
    .run();
}

/**
 * Clears out groups nobody ever sent.
 *
 * Runs on the same cron as the hold sweep - a table of abandoned baskets is not
 * worth a Worker of its own.
 */
export async function expireGroups(): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const stale = await env.DB.prepare(
    `SELECT id FROM group_baskets WHERE order_ref IS NULL AND expires_at < ?`,
  )
    .bind(now)
    .all<{ id: number }>();

  if (!stale.results.length) return 0;

  const ids = stale.results.map((r) => r.id);
  const holes = ids.map(() => '?').join(',');
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM group_basket_items WHERE group_id IN (${holes})`).bind(...ids),
    env.DB.prepare(`DELETE FROM group_baskets WHERE id IN (${holes})`).bind(...ids),
  ]);
  return ids.length;
}
