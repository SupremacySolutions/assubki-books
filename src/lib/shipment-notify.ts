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
const PER_SWEEP = 5;

/** Failed notices keep retrying with backoff; they never silently disappear. */

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
    <p>See your order for the latest total and payment instructions. ${
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
          ? `See your order for payment details. Please let us know by ${by} - after that the copies go back on the shelf.`
          : 'See your order for payment details. Please let us know within seven days.',
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
              o.telegram_chat_id, o.pay_by, COALESCE(s.title,'your reservation') AS shipment_title
         FROM shipment_notices n
         JOIN orders o    ON o.id = n.order_id
         LEFT JOIN shipments s ON s.id = n.shipment_id
        WHERE n.sent_at IS NULL AND n.next_attempt_at<=unixepoch() AND n.lease_until<=unixepoch()
          /* Somebody who cancelled in the meantime does not want telling. */
          AND o.status IN ('requested','awaiting_payment')
          AND NOT EXISTS (SELECT 1 FROM order_items WHERE order_id=o.id AND from_incoming=1)
        ORDER BY n.id
        LIMIT ?`,
    )
    .bind(Math.min(PER_SWEEP,limit))
    .all<QueuedNotice>();

  let sent = 0;
  let failed = 0;

  for (const notice of due) {
    const lease=crypto.randomUUID();
    const claimed=await db.prepare(`UPDATE shipment_notices SET lease_token=?,lease_until=unixepoch()+300
      WHERE id=? AND sent_at IS NULL AND lease_until<=unixepoch() AND next_attempt_at<=unixepoch()`)
      .bind(lease,notice.id).run();
    if (!claimed.meta.changes) continue;
    // A delayed or previously failed notice must still give a full week.
    const current=await db.prepare(`UPDATE orders SET pay_by=MAX(COALESCE(pay_by,0),unixepoch()+7*86400)
      WHERE id=? AND status IN ('requested','awaiting_payment')
        AND NOT EXISTS (SELECT 1 FROM order_items WHERE order_id=orders.id AND from_incoming=1)
      RETURNING pay_by`).bind(notice.order_id).first<{pay_by:number}>();
    if (!current) {
      await db.prepare('UPDATE shipment_notices SET lease_until=0,lease_token=NULL WHERE id=? AND lease_token=?').bind(notice.id,lease).run();
      continue;
    }
    notice.pay_by=current.pay_by;
    let ok=false, why='';
    try {
      if (notice.telegram_chat_id) ok=await tellByTelegram(notice,origin);
    } catch(err) { why=String(err).slice(0,200); }
    if (!ok) {
      try { ok=await tellByEmail(notice,origin); }
      catch(err) { why=String(err).slice(0,200); }
    }
    if (ok) {
      sent++;
      await db.prepare(`UPDATE shipment_notices SET sent_at=unixepoch(),attempts=attempts+1,
        last_error=NULL,lease_token=NULL,lease_until=0 WHERE id=? AND lease_token=?`).bind(notice.id,lease).run();
    } else {
      failed++;
      await db.prepare(`UPDATE shipment_notices SET attempts=attempts+1,last_error=?,
        next_attempt_at=unixepoch()+MIN(86400,900*(1 << MIN(attempts,7))),lease_token=NULL,lease_until=0
        WHERE id=? AND lease_token=?`).bind(why||'nothing delivered',notice.id,lease).run();
    }
  }

  return { sent, failed };
}

/** What is still waiting to go out, for the portal to show plainly. */
/**
 * Notices that keep failing, and what they last said.
 *
 * These matter more than they look. A reservation is deliberately not expired
 * while its notice is unsent - releasing somebody's copies for not answering a
 * message nobody sent them would be indefensible - and the retry now backs off
 * and tries again indefinitely rather than giving up after four goes. Put
 * together, one address that will never accept mail holds its copies for ever,
 * silently, and the only trace is a column nothing reads.
 *
 * So this is what reads it. Anything that has failed a few times is worth the
 * owner's attention, because by then it is not a blip.
 */
export async function stuckNotices(
  db: D1Database,
  shipmentId?: number,
): Promise<{ orders: number; lastError: string | null }> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n,
              (SELECT last_error FROM shipment_notices
                WHERE sent_at IS NULL AND attempts >= ?1
                  ${shipmentId ? 'AND shipment_id = ?2' : ''}
                ORDER BY attempts DESC, id LIMIT 1) AS last_error
         FROM shipment_notices
        WHERE sent_at IS NULL AND attempts >= ?1
          ${shipmentId ? 'AND shipment_id = ?2' : ''}`,
    )
    .bind(...(shipmentId ? [STUCK_AFTER, shipmentId] : [STUCK_AFTER]))
    .first<{ n: number; last_error: string | null }>();
  return { orders: row?.n ?? 0, lastError: row?.last_error ?? null };
}

/**
 * How many failures before it is the owner's problem rather than the network's.
 *
 * Three, because the backoff doubles: by the third attempt roughly an hour has
 * passed, which is long enough that a provider having a bad minute has already
 * cleared.
 */
const STUCK_AFTER = 3;

export async function pendingNotices(db: D1Database, shipmentId: number): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM shipment_notices n JOIN orders o ON o.id=n.order_id
      WHERE n.shipment_id=? AND n.sent_at IS NULL AND o.status IN ('requested','awaiting_payment')
        AND NOT EXISTS (SELECT 1 FROM order_items WHERE order_id=o.id AND from_incoming=1)`)
    .bind(shipmentId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
