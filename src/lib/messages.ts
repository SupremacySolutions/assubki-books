import { env } from 'cloudflare:workers';
import { forgetDashboard } from './dashboard';

/**
 * The conversation on an order.
 *
 * One thread per order, and the order's own token is the whole authority for
 * reaching it - a forwarded link must never open somebody else's thread. That
 * is why nothing here takes a ref: every caller has already been through
 * `getOrder`, and hands this an `order_id` it proved it was allowed to have.
 *
 * There is no thread before there is an order. No unauthenticated creation, no
 * second kind of token, no spam surface: the contact form and the Telegram
 * channel remain what a browser uses.
 */

/** Long enough for a real question, short enough not to be an essay. */
export const BODY_MAX = 2000;
/** The same number the bot already enforces on payment screenshots. */
export const IMAGES_PER_ORDER = 5;
/**
 * The shop's own photos on one order - a picture of the edition, the parcel
 * label, the books on the counter. Counted apart from the customer's, so the
 * shop sending photos can never use up the customer's room for a receipt.
 */
export const OWNER_IMAGES_PER_ORDER = 20;

/** What a photo may be, on either side. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const IMAGE_TYPES = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
]);
/** Per order, per hour, counting the customer's messages only. */
export const PER_HOUR = 20;

/** Screenshots live under a prefix that the public /img route will not serve. */
export const PROOF_PREFIX = 'proofs/';

export type Sender = 'customer' | 'owner';
export type Via = 'web' | 'telegram';

export interface Message {
  id: number;
  sender: Sender;
  via: Via;
  body: string | null;
  image_key: string | null;
  /** There was a photo here, whether or not it has since been swept. */
  had_image: number;
  created_at: number;
}

/**
 * The conversation, oldest first, as both sides read it.
 *
 * `sinceId` narrows it to what a caller has not seen. The poll passes one so an
 * update reads the new messages rather than the whole thread and throws most of
 * it away; a page render passes nothing and gets everything.
 *
 * Ordered by id, not by `created_at`: whole seconds do not order two messages
 * written inside one, and the order they are read in has to match the order the
 * cursor advances in.
 */
export async function thread(orderId: number, sinceId = 0): Promise<Message[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, sender, via, body, image_key, had_image, created_at
       FROM messages WHERE order_id = ? AND id > ? ORDER BY id`,
  )
    .bind(orderId, sinceId)
    .all<Message>();
  return results;
}

/** One message, checked to belong to this order. Used by the image readers. */
export async function messageInOrder(orderId: number, id: number): Promise<Message | null> {
  return env.DB.prepare(
    `SELECT id, sender, via, body, image_key, had_image, created_at
       FROM messages WHERE order_id = ? AND id = ?`,
  )
    .bind(orderId, id)
    .first<Message>();
}

/** Photos on an order, from one side. Each side has its own allowance. */
export async function imageCount(orderId: number, sender: Sender = 'customer'): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM messages WHERE order_id = ? AND sender = ? AND image_key IS NOT NULL',
  )
    .bind(orderId, sender)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export type ImageRefusal = 'big' | 'type' | 'nostore';

/**
 * Puts a photo where only the two people on this order can read it.
 *
 * `proofs/`, and nothing else, because src/pages/img/[...key].ts serves
 * `books/` and `uploads/` to the whole internet with a year-long cache. Both
 * sides' photos live here and are swept with the order, six months after it
 * closes: a customer's screenshot shows a bank balance, and the shop's photo
 * of a parcel shows an address.
 *
 * The order id rather than the reference: a reference is short, guessable and
 * printed on emails, and the key should not be either.
 */
export async function storeImage(
  orderId: number,
  image: File,
): Promise<{ key: string } | { refusal: ImageRefusal }> {
  if (image.size > MAX_IMAGE_BYTES) return { refusal: 'big' };
  const ext = IMAGE_TYPES.get(image.type);
  if (!ext) return { refusal: 'type' };
  const bucket = (env as unknown as { UPLOADS?: R2Bucket }).UPLOADS;
  if (!bucket) return { refusal: 'nostore' };
  const key = `${PROOF_PREFIX}${orderId}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
  await bucket.put(key, image.stream(), {
    httpMetadata: { contentType: image.type, cacheControl: 'private, no-store' },
  });
  return { key };
}

/** Takes a stored photo back out, when the message it belonged to did not land. */
export async function dropImage(key: string | null): Promise<void> {
  if (!key) return;
  await (env as unknown as { UPLOADS?: R2Bucket }).UPLOADS?.delete(key).catch(() => {});
}

/**
 * Whether this order has had its hour's worth.
 *
 * Counted in D1 rather than in memory for the same reason the login throttle
 * is: Workers isolates are ephemeral and there are many at once, so a
 * module-level counter resets constantly and protects nothing.
 *
 * Only the customer's own messages count. The owner answering ten times in an
 * hour is the shop working, not abuse.
 */
export async function overHourlyCap(orderId: number): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM messages
      WHERE order_id = ? AND sender = 'customer' AND created_at > unixepoch() - 3600`,
  )
    .bind(orderId)
    .first<{ n: number }>();
  return (row?.n ?? 0) >= PER_HOUR;
}

export interface PostInput {
  orderId: number;
  sender: Sender;
  via: Via;
  body?: string | null;
  imageKey?: string | null;
}

/**
 * Writes a message and moves the counters with it, in one batch.
 *
 * The insert and the counter bump cannot be allowed to come apart - a message
 * nobody is told about is worse than no message - so they go together and the
 * unread count belongs to the *other* side.
 */
export async function postMessage(input: PostInput): Promise<number | null> {
  const body = normaliseBody(input.body);
  const imageKey = input.imageKey ?? null;
  if (!body && !imageKey) return null;

  const side = input.sender === 'customer' ? 'unread_for_owner' : 'unread_for_customer';

  /*
   * The hourly cap is enforced here, not only by the check before the call.
   *
   * `overHourlyCap` is a SELECT and this is an INSERT, and twenty-five requests
   * arriving together all read the same count below the limit and all wrote -
   * twenty-five messages against a cap of twenty. The check remains, because it
   * is what turns a refusal into a sentence the customer can read; this is what
   * makes the number true.
   *
   * `INSERT ... SELECT ... WHERE` simply inserts no row when the cap is
   * reached, so `RETURNING id` comes back empty and the caller already treats
   * that as a refusal. The owner is not capped: answering ten times in an hour
   * is the shop working.
   */
  const [inserted] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO messages (order_id, sender, via, body, image_key, had_image)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6
        WHERE ?2 <> 'customer'
           OR (SELECT COUNT(*) FROM messages
                WHERE order_id = ?1 AND sender = 'customer'
                  AND created_at > unixepoch() - 3600) < ?7
       RETURNING id`,
    ).bind(
      input.orderId,
      input.sender,
      input.via,
      body,
      imageKey,
      imageKey ? 1 : 0,
      PER_HOUR,
    ),
    /*
     * `last_message_id` is what the poll compares against, and it has to be an
     * id rather than a time: two messages inside one second made a
     * second-resolution cursor ambiguous, and the newer one went undelivered
     * until a reload. `last_message_at` stays for the sweep and the debounce,
     * which do want a clock.
     */
    /*
     * Conditional on the message actually landing. The insert above can now
     * decline, and a counter bumped for a message that does not exist would
     * show the other side a badge with nothing behind it.
     */
    env.DB.prepare(
      `UPDATE orders
          SET ${side} = ${side} + 1,
              last_message_id = (SELECT MAX(id) FROM messages WHERE order_id = ?1),
              last_message_at = unixepoch(),
              updated_at = unixepoch()
        WHERE id = ?1
          AND (SELECT MAX(id) FROM messages WHERE order_id = ?1)
              IS NOT (SELECT last_message_id FROM orders WHERE id = ?1)`,
    ).bind(input.orderId),
  ]);

  const row = (inserted.results as { id: number }[] | undefined)?.[0];
  // The dashboard counts unanswered messages, so a new one should show there
  // now rather than after the minute its cache would otherwise keep.
  if (row && input.sender === 'customer') {
    forgetDashboard();
    forgetUnreadTotal();
  }
  return row?.id ?? null;
}

/**
 * Marks the thread read for one side, up to the message they were shown.
 *
 * Per thread, never per message: the shop can know "they have opened this" and
 * must never claim to know "they have seen this particular line". `throughId`
 * is not a read receipt - it is the newest message that was actually in the
 * response, and everything after it is still unread.
 *
 * It used to set the counter to nought outright, which lost any message that
 * arrived between reading the thread and acknowledging it: the badge cleared
 * while the message it was counting had never been sent to anybody. Both sides
 * poll, so both sides lost messages that way.
 *
 * Recounting rather than decrementing also means the number repairs itself. A
 * counter that has drifted for any other reason comes back to the truth the
 * next time somebody opens the thread.
 */
export async function markRead(
  orderId: number,
  side: Sender,
  throughId: number,
): Promise<void> {
  const column = side === 'customer' ? 'unread_for_customer' : 'unread_for_owner';
  const cursor = side === 'customer' ? 'read_cursor_customer' : 'read_cursor_owner';
  // Unread for the owner means written by the customer, and the other way round.
  const from: Sender = side === 'customer' ? 'owner' : 'customer';
  /*
   * The cursor only ever moves forward.
   *
   * Recounting from whatever id the latest request carried was still order
   * dependent: two polls, or two tabs, can finish out of order, and an older
   * acknowledgement then put the badge back for a message already read.
   * `MAX` makes a late arrival harmless - it can only ever confirm ground
   * already covered.
   *
   * Every SET expression reads the row as it was before this statement, so
   * both mentions of the cursor mean the same old value.
   */
  await env.DB.prepare(
    `UPDATE orders
        SET ${cursor} = MAX(${cursor}, ?2),
            ${column} = (SELECT COUNT(*) FROM messages
                          WHERE order_id = ?1 AND sender = ?3
                            AND id > MAX(${cursor}, ?2))
      WHERE id = ?1`,
  )
    .bind(orderId, throughId, from)
    .run();
  // Reading a thread is what takes it off the dashboard's tile.
  if (side === 'owner') {
    forgetDashboard();
    forgetUnreadTotal();
  }
}

// ---------------------------------------------------------------------------
// The owner's inbox
// ---------------------------------------------------------------------------

/**
 * Unread customer messages across the shop, for the badge on the portal's
 * Messages tab.
 *
 * It is on every portal page, so it reads through the partial index on
 * `unread_for_owner > 0` - only the orders actually waiting, usually none -
 * and is held for thirty seconds. Like the dashboard's cache it is cleared by
 * the isolate that handled a new message or a read.
 */
let unreadCache: { at: number; value: number } | null = null;

export async function unreadTotal(): Promise<number> {
  const now = Date.now();
  if (unreadCache && now - unreadCache.at < 30_000) return unreadCache.value;
  try {
    const row = await env.DB.prepare(
      `SELECT COALESCE(SUM(unread_for_owner), 0) AS n FROM orders WHERE unread_for_owner > 0`,
    ).first<{ n: number }>();
    unreadCache = { at: now, value: Number(row?.n ?? 0) };
  } catch {
    // A badge is never worth a broken page.
    unreadCache = { at: now, value: 0 };
  }
  return unreadCache.value;
}

export function forgetUnreadTotal(): void {
  unreadCache = null;
}

export interface Conversation {
  ref: string;
  name: string;
  status: string;
  unread: number;
  lastAt: number;
  telegram: boolean;
  /** The newest message, so the list can say who spoke last and what about. */
  lastSender: Sender;
  lastBody: string | null;
  lastHadImage: number;
  lastVia: Via;
  reservation: boolean;
  fulfilment: string;
  cash: number;
}

export type InboxView = 'waiting' | 'open' | 'all';

/**
 * Every order with a conversation on it, newest first.
 *
 * "Waiting" is the one the owner works from: the customer spoke last on an
 * order that is still open, whether or not the thread has been opened. Unread
 * alone was not enough - opening a message on a phone and meaning to answer
 * it later cleared the count and left nothing to come back to.
 *
 * One query, reading the newest message by primary key rather than a
 * subquery per row, and capped: this is a page somebody opens all day.
 */
export async function inbox(view: InboxView, q: string | null = null): Promise<Conversation[]> {
  const clauses = ['o.last_message_id IS NOT NULL'];
  const binds: unknown[] = [];
  if (view === 'waiting') {
    clauses.push(`(o.unread_for_owner > 0 OR (m.sender = 'customer'
                    AND o.status NOT IN ('completed','cancelled','expired')))`);
  } else if (view === 'open') {
    clauses.push(`o.status NOT IN ('completed','cancelled','expired')`);
  }
  const needle = q?.trim().slice(0, 40);
  if (needle) {
    clauses.push('(o.ref LIKE ? OR o.customer_name LIKE ? OR o.email LIKE ?)');
    binds.push(`%${needle}%`, `%${needle}%`, `%${needle}%`);
  }
  const { results } = await env.DB.prepare(
    `SELECT o.ref, o.customer_name AS name, o.status, o.unread_for_owner AS unread,
            o.last_message_at AS lastAt, o.telegram_chat_id IS NOT NULL AS telegram,
            o.shipment_id IS NOT NULL AS reservation, o.fulfilment,
            COALESCE(o.cash_payment, 0) AS cash,
            m.sender AS lastSender, m.body AS lastBody, m.had_image AS lastHadImage, m.via AS lastVia
       FROM orders o
       JOIN messages m ON m.id = o.last_message_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY o.unread_for_owner > 0 DESC, o.last_message_at DESC, o.id DESC
      LIMIT 150`,
  )
    .bind(...binds)
    .all<Conversation>();
  return results.map((r) => ({ ...r, telegram: Boolean(r.telegram), reservation: Boolean(r.reservation) }));
}

// ---------------------------------------------------------------------------
// Saved replies
// ---------------------------------------------------------------------------

/**
 * The things the owner types every day, one tap away.
 *
 * Kept in Settings as plain text - one reply per paragraph, with an optional
 * short label before a `|` - because that is something anybody can edit
 * without a form per reply. `{name}`, `{ref}` and `{total}` are filled in
 * from the order the reply is used on.
 *
 * A reply can start `[collect]` or `[post]` to appear only on orders going
 * that way. Offering "your order has been posted" on a collection order is
 * exactly the wording drift `order-status.ts` exists to prevent, and a button
 * makes it one tap away.
 */
export const DEFAULT_REPLIES = [
  'Received|Jazakallahu khayran, we have received your payment. We will be in touch about the next step shortly.',
  '[collect] Ready to collect|Assalamu alaykum {name}, your books are ready to collect. Let us know a time that suits you.',
  '[post] Sent today|Your order {ref} went out today, in sha Allah it will reach you in the next few days.',
  'Checking|Thank you for your message - let me check and come back to you shortly.',
].join('\n\n');

export interface QuickReply {
  label: string;
  text: string;
}

export function quickReplies(
  raw: string | null | undefined,
  fill: { name: string; ref: string; total: string; collection: boolean },
): QuickReply[] {
  const source = (raw ?? '').trim() || DEFAULT_REPLIES;
  const first = fill.name.trim().split(/\s+/)[0] ?? '';
  return source
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .flatMap((block) => {
      const tag = block.match(/^\[(collect|post)\]\s*/i);
      if (!tag) return [block];
      const forCollection = tag[1].toLowerCase() === 'collect';
      return forCollection === fill.collection ? [block.slice(tag[0].length)] : [];
    })
    .slice(0, 12)
    .map((block) => {
      const bar = block.indexOf('|');
      const hasLabel = bar > 0 && bar <= 40;
      const body = (hasLabel ? block.slice(bar + 1) : block)
        .trim()
        .replace(/\{name\}/gi, first)
        .replace(/\{ref\}/gi, fill.ref)
        .replace(/\{total\}/gi, fill.total);
      const label = hasLabel
        ? block.slice(0, bar).trim()
        : body.length > 28 ? `${body.slice(0, 27).trimEnd()}…` : body;
      return { label, text: body.slice(0, BODY_MAX) };
    });
}

/** Trimmed, capped, and empty-means-nothing rather than empty-means-blank. */
export function normaliseBody(value: unknown): string | null {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, BODY_MAX) : null;
}

/**
 * Whether a thread still takes new messages.
 *
 * A closed order keeps its conversation readable - it is the record of what was
 * agreed - but there is nobody left to answer, so it stops taking words.
 */
export function threadOpen(status: string): boolean {
  return !['completed', 'cancelled', 'expired'].includes(status);
}
