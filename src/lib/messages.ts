import { env } from 'cloudflare:workers';

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

export async function imageCount(orderId: number): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM messages WHERE order_id = ? AND image_key IS NOT NULL',
  )
    .bind(orderId)
    .first<{ n: number }>();
  return row?.n ?? 0;
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
