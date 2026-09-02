/**
 * Email via Resend.
 *
 * Chosen over Cloudflare Email Sending because it runs on a free tier
 * (3,000/month) with no plan change, and this shop will send a handful a day.
 * The whole surface is one POST, so swapping providers later means rewriting
 * only `deliver()`.
 *
 * Every send fails soft. By the time an email is attempted the order is already
 * in the database and the stock is already held - a bounced notification must
 * never look to the customer like a failed order.
 */

import { env } from 'cloudflare:workers';
import { SITE } from './format';

interface EmailEnv {
  RESEND_API_KEY?: string;
  EMAIL_DRY_RUN?: string;
  ORDER_FROM?: string;
  OWNER_EMAIL?: string;
}

const cfg = () => env as unknown as EmailEnv;

export interface Message {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}

/** Configured is not the same as working - see lastEmailError(). */
export function emailConfigured(): boolean {
  return Boolean(cfg().RESEND_API_KEY && cfg().ORDER_FROM);
}

export async function lastEmailError(): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'last_email_error'`)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export function fromAddress(): string | null {
  return cfg().ORDER_FROM ?? null;
}

export function ownerAddress(): string {
  // OWNER_EMAIL is set in wrangler.jsonc, so this fallback should never show.
  // It is the shop's own address rather than the studio's, so a
  // misconfiguration cannot quietly point customers at the wrong inbox.
  return cfg().OWNER_EMAIL ?? 'orders@assubkibooks.co.uk';
}

/**
 * Records why the last send failed, so the portal can report the truth.
 *
 * Having a key and a From address is not the same as being able to send: a
 * domain that is not verified with the provider rejects every message. Without
 * this, the dashboard reports "email configured" while nothing is reaching
 * anyone - which is exactly what happened.
 */
async function recordFailure(reason: string): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('last_email_error', ?, unixepoch())
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()`,
    )
      .bind(reason.slice(0, 500))
      .run();
  } catch {
    /* never let health-reporting break a send path */
  }
}

async function clearFailure(): Promise<void> {
  try {
    await env.DB.prepare(`DELETE FROM settings WHERE key = 'last_email_error'`).run();
  } catch {
    /* ignore */
  }
}

/**
 * Whether sends are pretend.
 *
 * The test suite places a dozen orders a run and each one emails twice, which
 * is most of a day's free quota. Set EMAIL_DRY_RUN=1 in .dev.vars so working
 * locally costs nothing and the shop keeps its allowance for real customers.
 *
 * It is read from the environment only, and is deliberately not set in
 * wrangler.jsonc - production must never be able to silently stop emailing.
 */
export const emailDryRun = (): boolean => cfg().EMAIL_DRY_RUN === '1';

export async function deliver(msg: Message): Promise<boolean> {
  const { RESEND_API_KEY, ORDER_FROM } = cfg();

  if (emailDryRun()) {
    console.log(`[email] dry run → ${msg.to}: ${msg.subject}`);
    return true;
  }

  if (!RESEND_API_KEY || !ORDER_FROM) {
    console.log(`[email] skipped (no RESEND_API_KEY/ORDER_FROM) → ${msg.to}: ${msg.subject}`);
    await recordFailure('No RESEND_API_KEY or ORDER_FROM is set.');
    return false;
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: ORDER_FROM,
        to: [msg.to],
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`[email] resend rejected → ${msg.to}:`, res.status, body);
      let reason = `${res.status}: ${body}`;
      try {
        const parsed = JSON.parse(body) as { message?: string };
        if (parsed.message) reason = parsed.message;
      } catch {
        /* keep the raw body */
      }
      await recordFailure(reason);
      return false;
    }
    await clearFailure();
    return true;
  } catch (err) {
    console.error(`[email] send threw → ${msg.to}:`, err);
    await recordFailure(String(err));
    return false;
  }
}

// ---------------------------------------------------------------------------
// Shared chrome
// ---------------------------------------------------------------------------

export const escapeHtml = (s: string) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

/**
 * The letterhead every email is wrapped in.
 *
 * The mark is a hosted PNG rather than the SVG the website uses, because no
 * mail client renders inline SVG. It sits beside a text wordmark on purpose:
 * clients that block remote images by default leave a 28px gap, and the shop's
 * name still has to be the first thing read.
 *
 * Tables and `bgcolor` where a plain div would do, because Outlook renders
 * through Word and drops most block-level styling.
 */
export function shell(heading: string, sub: string, inner: string): string {
  return `<!doctype html><html><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
  </head><body style="margin:0;background:#f5f4f0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#101828">
  <div style="max-width:560px;margin:0 auto;padding:28px 22px">
    <div style="background:#0e2a55;color:#ffffff;padding:20px 24px 22px;border-radius:3px 3px 0 0">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse">
        <tr>
          <td valign="middle" style="padding-right:10px">
            <img src="${SITE.url}/email/mark.png" width="28" height="28" alt=""
                 style="display:block;border:0;outline:none;text-decoration:none">
          </td>
          <td valign="middle" style="line-height:1.25">
            <div style="font-size:15px;font-weight:600;color:#ffffff">${escapeHtml(SITE.name)}</div>
            <div style="font-size:12.5px;color:#8fa3c4;direction:rtl">${escapeHtml(SITE.nameAr)}</div>
          </td>
        </tr>
      </table>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:16px 0 0">
        <tr><td height="1" bgcolor="#2a4a78" style="height:1px;line-height:1px;font-size:0">&nbsp;</td></tr>
      </table>
      <h1 style="margin:16px 0 0;font-size:20px;font-weight:600;color:#ffffff">${escapeHtml(heading)}</h1>
      <p style="margin:6px 0 0;color:#c3ccde;font-size:15px">${escapeHtml(sub)}</p>
    </div>
    <div style="background:#fff;border:1px solid #ddd9d1;border-top:none;padding:24px;border-radius:0 0 3px 3px">
      ${inner}
    </div>
    <p style="margin:16px 0 0;font-size:12.5px;color:#8b93a1;text-align:center">
      <a href="${SITE.url}" style="color:#8b93a1;text-decoration:none">assubkibooks.co.uk</a>
    </p>
  </div></body></html>`;
}

/**
 * The line that turns this address into a doorbell rather than an inbox.
 *
 * Customer mail used to carry `replyTo: ownerAddress()`, so a reply landed in
 * the owner's Gmail - outside the app, with nothing about it attached to the
 * order, and invisible to the portal. Every order now has a thread on it, so
 * email's job is to say that something happened and point back at the site.
 *
 * The link is the customer's own order page when there is one. A group basket
 * has no order yet, so it gets the lookup instead - which is also the route
 * back for anybody whose link has gone missing, and the reason
 * `/api/orders/lookup` is still here.
 */
export function noReply(orderLink?: string | null): string {
  const href = orderLink ?? `${SITE.url}/order`;
  const what = orderLink ? 'your order page' : 'your order';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0">
    <tr><td height="1" bgcolor="#ddd9d1" style="height:1px;line-height:1px;font-size:0">&nbsp;</td></tr>
  </table>
  <p style="margin:14px 0 0;font-size:13px;color:#8b93a1;line-height:1.6">
    This address is not monitored - replies to it are not read.
    <a href="${escapeHtml(href)}" style="color:#184485">Answer on ${escapeHtml(what)}</a>,
    where the shop will see it,
    or message us on <a href="${escapeHtml(SITE.telegram)}" style="color:#184485">Telegram</a>.
  </p>`;
}

/** The same thing for the plain-text part. */
export function noReplyText(orderLink?: string | null): string {
  const href = orderLink ?? `${SITE.url}/order`;
  return (
    `\n\n---\nThis address is not monitored - replies to it are not read.\n` +
    `Answer on your order page: ${href}\n` +
    `Or message us on Telegram: ${SITE.telegram}\n`
  );
}

export function button(href: string, label: string): string {
  return `<p style="margin:22px 0 0"><a href="${escapeHtml(href)}" style="background:#184485;color:#fff;padding:11px 20px;border-radius:2px;text-decoration:none;font-size:15px;display:inline-block">${escapeHtml(label)}</a></p>`;
}

export function itemRows(
  items: { title: string; qty: number; pricePence: number }[],
  subtotalPence: number,
  extra: { label: string; pence: number }[] = [],
  totalLabel?: string,
  totalPence?: number,
): string {
  const money = (p: number) => `£${(p / 100).toFixed(2)}`;
  const rows = items
    .map(
      (i) => `<tr>
        <td style="padding:8px 0;border-bottom:1px solid #ddd9d1">${escapeHtml(i.title)}${
          i.qty > 1 ? ` <span style="color:#8b93a1">× ${i.qty}</span>` : ''
        }</td>
        <td style="padding:8px 0;border-bottom:1px solid #ddd9d1;text-align:right;white-space:nowrap">${money(
          i.pricePence * i.qty,
        )}</td></tr>`,
    )
    .join('');

  const extras = extra
    .map(
      (e) => `<tr><td style="padding:6px 0;color:#4a5568">${escapeHtml(e.label)}</td>
        <td style="padding:6px 0;text-align:right;color:#4a5568">${money(e.pence)}</td></tr>`,
    )
    .join('');

  const total =
    totalLabel && totalPence !== undefined
      ? `<tr><td style="padding:10px 0;font-weight:600;border-top:1px solid #ddd9d1">${escapeHtml(
          totalLabel,
        )}</td><td style="padding:10px 0;text-align:right;font-weight:600;border-top:1px solid #ddd9d1">${money(
          totalPence,
        )}</td></tr>`
      : `<tr><td style="padding:10px 0;font-weight:600">Subtotal</td>
         <td style="padding:10px 0;text-align:right;font-weight:600">${money(subtotalPence)}</td></tr>`;

  const subtotalRow =
    totalLabel && totalPence !== undefined
      ? `<tr><td style="padding:6px 0;color:#4a5568">Subtotal</td>
         <td style="padding:6px 0;text-align:right;color:#4a5568">${money(subtotalPence)}</td></tr>`
      : '';

  return `<table style="width:100%;border-collapse:collapse;font-size:15px">${rows}${subtotalRow}${extras}${total}</table>`;
}
