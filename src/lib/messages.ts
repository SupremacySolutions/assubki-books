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

/** The whole conversation, oldest first, as both sides read it. */
export async function thread(orderId: number): Promise<Message[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, sender, via, body, image_key, had_image, created_at
       FROM messages WHERE order_id = ? ORDER BY created_at, id`,
  )
    .bind(orderId)
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

  const [inserted] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO messages (order_id, sender, via, body, image_key, had_image)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
    ).bind(input.orderId, input.sender, input.via, body, imageKey, imageKey ? 1 : 0),
    env.DB.prepare(
      `UPDATE orders SET ${side} = ${side} + 1, last_message_at = unixepoch(),
                         updated_at = unixepoch()
        WHERE id = ?`,
    ).bind(input.orderId),
  ]);

  const row = (inserted.results as { id: number }[] | undefined)?.[0];
  return row?.id ?? null;
}

/**
 * Marks the thread read for one side.
 *
 * Per thread, never per message: the shop can know "they have opened this" and
 * must never claim to know "they have seen this particular line".
 */
export async function markRead(orderId: number, side: Sender): Promise<void> {
  const column = side === 'customer' ? 'unread_for_customer' : 'unread_for_owner';
  await env.DB.prepare(
    `UPDATE orders SET ${column} = 0 WHERE id = ? AND ${column} > 0`,
  )
    .bind(orderId)
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
