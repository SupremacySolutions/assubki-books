/**
 * Writing to everyone on a pre-order list.
 *
 * This replaces a `mailto:?bcc=` link, which opened the owner's own mail app
 * with every address in the blind-copy line. The message then came from their
 * personal inbox rather than the shop's address, had none of the shop's
 * letterhead, read like a mass mailing, and left no record of who had been
 * told. Now the owner writes it once in the portal and the shop sends one
 * email per person, from the same address and in the same letterhead as order
 * mail, greeting each by name and reminding them how many copies they asked
 * for.
 *
 * Queued, for the reasons `shipment-notify.ts` gives: one press must not be the
 * request that writes to forty people. The admin action sends the first batch
 * straight away, which for most lists is all of it; the quarter-hourly sweep
 * sends the rest and retries anything the provider refused - over the day's
 * allowance, say - with backoff.
 *
 * Takes its database as an argument where the sweep calls it, because the
 * sweep is a separate Worker with its own binding.
 */

import { env } from 'cloudflare:workers';
import { deliver, shell, button, escapeHtml, contactFooter, contactFooterText } from './email';
import { imageUrl, price, SITE } from './format';
import type { Preorder } from './preorders';

export const MAX_SUBJECT = 150;
export const MAX_MESSAGE = 4000;

/** How many to send per pass. The same budget the back-in-stock drain uses. */
const PER_PASS = 20;

/**
 * Attempts before a message is given up on.
 *
 * Unlike an arrival notice, which holds somebody's copies until it is read and
 * so must never stop trying, a pre-order update goes stale: "the books have
 * arrived" is not worth sending three days late. The backoff doubles from
 * fifteen minutes, so eight goes put the last about thirty-two hours after the
 * first. That always reaches past the next midnight UTC, when Resend's daily
 * allowance resets, so a list that ran out of allowance in the morning still
 * goes out - as the portal tells the owner it will. Six would give up after
 * under eight hours, before the reset.
 */
export const GIVE_UP_AFTER = 8;

/** What the form starts with. The owner changes it to suit the news. */
export function defaultMail(p: Pick<Preorder, 'title'>): { subject: string; message: string } {
  return {
    subject: `${p.title} has arrived`,
    message:
      'Alhamdulillah, the books are in and on the shelf now.\n\n' +
      'Copies are limited, so if you would still like one, please order soon.',
  };
}

/**
 * The button's address, or why there cannot be one.
 *
 * Only a page on the shop's own site, written as a full address or a path.
 * The owner pastes it from the listing; anything else - a typo, a link to
 * somewhere off the site - is refused rather than sent to forty people.
 */
export function shopLink(raw: string, origin: string): { ok: true; href: string | null } | { ok: false } {
  const value = raw.trim();
  if (!value) return { ok: true, href: null };
  const hosts = new Set([new URL(SITE.url).host, new URL(origin).host]);
  try {
    const url = new URL(value, SITE.url);
    if (!/^https?:$/.test(url.protocol) || !hosts.has(url.host)) return { ok: false };
    // Always the real site: a link built on a preview or local origin would be
    // dead in somebody's inbox.
    return { ok: true, href: `${SITE.url}${url.pathname}${url.search}${url.hash}` };
  } catch {
    return { ok: false };
  }
}

export interface MailPerson {
  name: string;
  copies: number;
}

export interface MailContent {
  subject: string;
  message: string;
  link: string | null;
}

type BookFacts = Pick<
  Preorder,
  'title' | 'title_ar' | 'title_ur' | 'author' | 'volumes' | 'price_pence' | 'image_key'
>;

/**
 * One person's email.
 *
 * The owner writes the news; the parts that differ per person - the greeting,
 * the book, how many copies they said they would take - are added here, so the
 * owner never has to write "Dear all" and nobody sees anyone else's number.
 */
export function preorderEmail(book: BookFacts, person: MailPerson, mail: MailContent) {
  const first = person.name.trim().split(/\s+/)[0] || person.name;
  const native = book.title_ar || book.title_ur;
  const byline = [book.author, book.volumes && book.volumes > 1 ? `${book.volumes} volume set` : null]
    .filter(Boolean)
    .join(' · ');
  const each = book.volumes && book.volumes > 1 ? 'per set' : 'each';
  const asked = `You asked for ${person.copies} ${person.copies === 1 ? 'copy' : 'copies'}`;
  const priced = book.price_pence !== null ? ` · ${price(book.price_pence)} ${each}` : '';
  const cover = imageUrl(book.image_key, 'card');
  const why =
    'You are getting this because you registered interest in this book on our pre-orders page, ' +
    'and you can ask to come off the list at any time.';
  const note =
    'Registering interest did not reserve a copy or commit you to anything - it only told us how many to order.';

  const card = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
      style="border-collapse:separate;background:#f5f4f0;border:1px solid #ddd9d1;border-radius:3px">
    <tr>
      ${
        cover
          ? `<td valign="top" width="64" style="padding:14px 0 14px 14px">
               <img src="${escapeHtml(`${SITE.url}${cover}`)}" width="64" alt=""
                    style="display:block;width:64px;height:auto;border:0;border-radius:2px">
             </td>`
          : ''
      }
      <td valign="top" style="padding:14px;line-height:1.45">
        <div style="font-size:15px;font-weight:600;color:#101828">${escapeHtml(book.title)}</div>
        ${native ? `<div style="font-size:14px;color:#4a5568" dir="rtl">${escapeHtml(native)}</div>` : ''}
        ${byline ? `<div style="font-size:13.5px;color:#4a5568">${escapeHtml(byline)}</div>` : ''}
        <div style="margin-top:8px;font-size:14px;color:#101828">${escapeHtml(asked)}${escapeHtml(priced)}</div>
      </td>
    </tr>
  </table>`;

  const html = shell(
    mail.subject,
    `Pre-order: ${book.title}`,
    `<p style="margin:0 0 16px;font-size:15px">السلام عليكم ${escapeHtml(first)},</p>
     <p style="margin:0 0 18px;font-size:15px;line-height:1.6;white-space:pre-line">${escapeHtml(mail.message)}</p>
     ${card}
     ${mail.link ? button(mail.link, 'See it in the shop') : ''}
     <p style="margin:20px 0 0;font-size:13.5px;color:#636b7a;line-height:1.6">${escapeHtml(note)}</p>
     ${contactFooter(why)}`,
    mail.message.replace(/\s+/g, ' ').trim().slice(0, 140),
  );

  const text =
    `${mail.subject}\n\nالسلام عليكم ${first},\n\n${mail.message}\n\n` +
    `${book.title}${native ? `\n${native}` : ''}${byline ? `\n${byline}` : ''}\n${asked}${priced}\n\n` +
    (mail.link ? `See it in the shop: ${mail.link}\n\n` : '') +
    note +
    contactFooterText(why);

  return { subject: mail.subject, html, text };
}

// ---------------------------------------------------------------------------
// Queueing
// ---------------------------------------------------------------------------

export type QueueResult =
  | { ok: true; mailingId: number; recipients: number }
  | { ok: false; why: 'empty' | 'duplicate' };

/**
 * One mailing, addressed to everyone on the list as it stands now.
 *
 * Somebody registering a minute later is not on it; they did not hear the
 * news because there was none yet when they asked. The same message sent
 * twice in ten minutes is taken to be a second press of the button, not a
 * second message, and refused.
 */
export async function queueMailing(preorderId: number, mail: MailContent): Promise<QueueResult> {
  const recent = await env.DB.prepare(
    `SELECT 1 FROM preorder_mailings
      WHERE preorder_id = ? AND subject = ? AND message = ? AND created_at > unixepoch() - 600`,
  )
    .bind(preorderId, mail.subject, mail.message)
    .first();
  if (recent) return { ok: false, why: 'duplicate' };

  const mailing = await env.DB.prepare(
    `INSERT INTO preorder_mailings (preorder_id, subject, message, link, recipients)
     SELECT ?1, ?2, ?3, ?4, COUNT(*) FROM preorder_interest WHERE preorder_id = ?1
     HAVING COUNT(*) > 0
     RETURNING id, recipients`,
  )
    .bind(preorderId, mail.subject, mail.message, mail.link)
    .first<{ id: number; recipients: number }>();
  if (!mailing) return { ok: false, why: 'empty' };

  await env.DB.prepare(
    `INSERT OR IGNORE INTO preorder_mail_queue (mailing_id, interest_id)
     SELECT ?, id FROM preorder_interest WHERE preorder_id = ? ORDER BY id`,
  )
    .bind(mailing.id, preorderId)
    .run();

  return { ok: true, mailingId: mailing.id, recipients: mailing.recipients };
}

interface Due extends BookFacts {
  id: number;
  mailing_id: number;
  name: string;
  email: string;
  copies: number;
  subject: string;
  message: string;
  link: string | null;
}

/**
 * Sends what is owed, and records what happened to each.
 *
 * Each row is leased before it is sent, so the admin action and the sweep can
 * both run this at once without anybody getting the same email twice. Never
 * throws for a send - a refusal is recorded against the row and retried.
 */
export async function drainPreorderMail(
  db: D1Database,
  limit = PER_PASS,
  mailingId?: number,
): Promise<{ sent: number; failed: number }> {
  const { results: due } = await db
    .prepare(
      `SELECT q.id, q.mailing_id, i.name, i.email, i.copies, m.subject, m.message, m.link,
              p.title, p.title_ar, p.title_ur, p.author, p.volumes, p.price_pence, p.image_key
         FROM preorder_mail_queue q
         JOIN preorder_interest i ON i.id = q.interest_id
         JOIN preorder_mailings m ON m.id = q.mailing_id
         JOIN preorders p         ON p.id = m.preorder_id
        WHERE q.sent_at IS NULL AND q.attempts < ?1
          AND q.next_attempt_at <= unixepoch() AND q.lease_until <= unixepoch()
          ${mailingId ? 'AND q.mailing_id = ?3' : ''}
        ORDER BY q.id
        LIMIT ?2`,
    )
    .bind(...(mailingId ? [GIVE_UP_AFTER, Math.min(PER_PASS, limit), mailingId] : [GIVE_UP_AFTER, Math.min(PER_PASS, limit)]))
    .all<Due>();

  let sent = 0;
  let failed = 0;

  for (const row of due) {
    const lease = crypto.randomUUID();
    const claimed = await db
      .prepare(
        `UPDATE preorder_mail_queue SET lease_token = ?, lease_until = unixepoch() + 300
          WHERE id = ? AND sent_at IS NULL AND lease_until <= unixepoch() AND next_attempt_at <= unixepoch()`,
      )
      .bind(lease, row.id)
      .run();
    if (!claimed.meta.changes) continue;

    let ok = false;
    let why = '';
    try {
      ok = await deliver({
        to: row.email,
        ...preorderEmail(row, row, { subject: row.subject, message: row.message, link: row.link }),
      });
      if (!ok) why = 'the mail provider refused it';
    } catch (err) {
      why = String(err).slice(0, 200);
    }

    if (ok) {
      sent++;
      await db.batch([
        db
          .prepare(
            `UPDATE preorder_mail_queue SET sent_at = unixepoch(), attempts = attempts + 1,
               last_error = NULL, lease_token = NULL, lease_until = 0
              WHERE id = ? AND lease_token = ?`,
          )
          .bind(row.id, lease),
        db.prepare('UPDATE preorder_mailings SET sent = sent + 1 WHERE id = ?').bind(row.mailing_id),
      ]);
    } else {
      failed++;
      await db
        .prepare(
          `UPDATE preorder_mail_queue SET attempts = attempts + 1, last_error = ?,
             next_attempt_at = unixepoch() + MIN(86400, 900 * (1 << MIN(attempts, 7))),
             lease_token = NULL, lease_until = 0
            WHERE id = ? AND lease_token = ?`,
        )
        .bind(why || 'nothing delivered', row.id, lease)
        .run();
    }
  }

  return { sent, failed };
}

export interface MailingSummary {
  id: number;
  subject: string;
  recipients: number;
  sent: number;
  /** Still to go - not yet tried, or refused and waiting to try again. */
  waiting: number;
  /** Given up on after GIVE_UP_AFTER refusals. */
  undelivered: number;
  last_error: string | null;
  created_at: number;
}

/** What has been sent for one pre-order, newest first, for the portal. */
export async function mailingsFor(preorderId: number): Promise<MailingSummary[]> {
  const { results } = await env.DB.prepare(
    `SELECT m.id, m.subject, m.recipients, m.sent, m.created_at,
            (SELECT COUNT(*) FROM preorder_mail_queue q
              WHERE q.mailing_id = m.id AND q.sent_at IS NULL AND q.attempts < ?2) AS waiting,
            (SELECT COUNT(*) FROM preorder_mail_queue q
              WHERE q.mailing_id = m.id AND q.sent_at IS NULL AND q.attempts >= ?2) AS undelivered,
            (SELECT q.last_error FROM preorder_mail_queue q
              WHERE q.mailing_id = m.id AND q.sent_at IS NULL AND q.last_error IS NOT NULL
              ORDER BY q.attempts DESC LIMIT 1) AS last_error
       FROM preorder_mailings m
      WHERE m.preorder_id = ?1
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT 20`,
  )
    .bind(preorderId, GIVE_UP_AFTER)
    .all<MailingSummary>();
  return results;
}
