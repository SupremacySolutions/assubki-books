/**
 * Telling everyone a shipment has landed.
 *
 * Queued rather than sent, because "mark arrived" cannot be the request that
 * writes to forty people. The mail provider allows a hundred messages a day
 * and a Worker caps how many outbound requests one handler may make; forty
 * sends in one press would risk failing halfway, having told some customers
 * and not others, with nothing recording which.
 *
 * So arrival writes a row per order and returns. The sweep that already runs
 * every fifteen minutes drains it a few at a time, which spreads a burst over
 * hours instead of dropping people, and turns a failed send into a retry
 * rather than a silence.
 *
 * Takes its database as an argument, because the sweep is a separate Worker
 * with its own binding and has to run this same code.
 */

import { deliver, ownerAddress, shell, button, noReply, noReplyText, escapeHtml } from './email';
import { sendMessage, esc, mdLink } from './telegram';

/** How many to send per sweep. Small enough to stay well inside every limit. */
const PER_SWEEP = 15;

/** How many times to try one customer before leaving them for the owner. */
const MAX_ATTEMPTS = 4;

export interface QueuedNotice {
  id: number;
  order_id: number;
  ref: string;
  access_token: string;
  customer_name: string;
  email: string;
  telegram_chat_id: string | null;
  pay_by: number | null;
  shipment_title: string;
}

/**
 * One row per order that had a claim filled.
 *
 * `INSERT OR IGNORE` against the unique pair is the whole de-duplication: a
 * second press of "arrived", or a retry of a request that half-succeeded,
 * cannot tell anybody twice.
 */
export function queueArrivalNotices(
  db: D1Database,
  shipmentId: number,
  orderIds: number[],
): D1PreparedStatement[] {
  return orderIds.map((orderId) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO shipment_notices (shipment_id, order_id) VALUES (?, ?)`,
      )
      .bind(shipmentId, orderId),
  );
}

/** What the customer is told, in the two places they might read it. */
function wording(notice: QueuedNotice, origin: string) {
  const link = `${origin}/order?ref=${encodeURIComponent(notice.ref)}&t=${encodeURIComponent(notice.access_token)}`;
  const by = notice.pay_by
    ? new Date(notice.pay_by * 1000).toLocaleDateString('en-GB', {
        weekday: 'long', day: 'numeric', month: 'long',
      })
    : null;
  return { link, by };
}

async function tellByEmail(notice: QueuedNotice, origin: string): Promise<boolean> {
  const { link, by } = wording(notice, origin);
  const body = `
    <p>The books you reserved from <strong>${escapeHtml(notice.shipment_title)}</strong>
       have arrived, and your copies are set aside in your name.</p>
    <p>We will write again shortly with your total and how to pay. ${
      by
        ? `Please let us know by <strong>${escapeHtml(by)}</strong> - after that the copies go back on the shelf and the reservation is cancelled.`
        : 'Please let us know within seven days.'
    }</p>
    <p>If you need longer, or would rather not go ahead, just reply and tell us.</p>
    ${button('See your order', link)}
    ${noReply(link)}`;
  return deliver({
    to: notice.email,
    replyTo: await ownerAddress(),
    subject: `Your reserved books have arrived - ${notice.ref}`,
    html: shell(
      'Your reserved books have arrived',
      `السلام عليكم ${escapeHtml(notice.customer_name)}`,
      body,
    ),
    text: `Your reserved books from ${notice.shipment_title} have arrived and are set aside for you.${
      by ? ` Please let us know by ${by}.` : ' Please let us know within seven days.'
    }\n\n${link}${noReplyText(link)}`,
  });
}

async function tellByTelegram(notice: QueuedNotice, origin: string): Promise<boolean> {
  const { link, by } = wording(notice, origin);
  return sendMessage(
    notice.telegram_chat_id!,
    [
      `السلام عليكم ${esc(notice.customer_name)}`,
      '',
      `*Your reserved books have arrived*`,
      esc(`From ${notice.shipment_title}. Your copies are set aside in your name.`),
      '',
      esc(
        by
          ? `We will send your total shortly. Please let us know by ${by} - after that the copies go back on the shelf.`
          : 'We will send your total shortly. Please let us know within seven days.',
      ),
      '',
      mdLink('See your order', link),
    ].join('\n'),
  );
}

/**
 * Send a few, and record what happened to each.
 *
 * Telegram is tried first where a chat is bound, because it costs nothing
 * against the mail quota and a shipment can easily have more reservations than
 * the day's allowance. Email is the fallback, and the only route for somebody
 * who never connected a chat.
 */
export async function drainArrivalNotices(
  db: D1Database,
  origin: string,
  limit = PER_SWEEP,
): Promise<{ sent: number; failed: number }> {
  const { results: due } = await db
    .prepare(
      `SELECT n.id, n.order_id, o.ref, o.access_token, o.customer_name, o.email,
              o.telegram_chat_id, o.pay_by, s.title AS shipment_title
         FROM shipment_notices n
         JOIN orders o    ON o.id = n.order_id
         JOIN shipments s ON s.id = n.shipment_id
        WHERE n.sent_at IS NULL AND n.attempts < ?
          /* Somebody who cancelled in the meantime does not want telling. */
          AND o.status NOT IN ('cancelled', 'expired')
        ORDER BY n.id
        LIMIT ?`,
    )
    .bind(MAX_ATTEMPTS, limit)
    .all<QueuedNotice>();

  let sent = 0;
  let failed = 0;

  for (const notice of due) {
    let ok = false;
    let why = '';
    try {
      if (notice.telegram_chat_id) ok = await tellByTelegram(notice, origin);
      if (!ok) ok = await tellByEmail(notice, origin);
    } catch (err) {
      why = String(err).slice(0, 200);
    }

    if (ok) {
      sent++;
      await db
        .prepare('UPDATE shipment_notices SET sent_at = unixepoch(), attempts = attempts + 1 WHERE id = ?')
        .bind(notice.id)
        .run();
    } else {
      failed++;
      await db
        .prepare('UPDATE shipment_notices SET attempts = attempts + 1, last_error = ? WHERE id = ?')
        .bind(why || 'nothing delivered', notice.id)
        .run();
    }
  }

  return { sent, failed };
}

/** What is still waiting to go out, for the portal to show plainly. */
export async function pendingNotices(db: D1Database, shipmentId: number): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM shipment_notices WHERE shipment_id = ? AND sent_at IS NULL')
    .bind(shipmentId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
