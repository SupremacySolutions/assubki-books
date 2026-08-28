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

interface EmailEnv {
  RESEND_API_KEY?: string;
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
  return cfg().OWNER_EMAIL ?? 'support.supremacysolutions@gmail.com';
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

export async function deliver(msg: Message): Promise<boolean> {
  const { RESEND_API_KEY, ORDER_FROM } = cfg();

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

export function shell(heading: string, sub: string, inner: string): string {
  return `<!doctype html><html><body style="margin:0;background:#f5f4f0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#101828">
  <div style="max-width:560px;margin:0 auto;padding:28px 22px">
    <div style="background:#0e2a55;color:#fff;padding:22px 24px;border-radius:3px 3px 0 0">
      <h1 style="margin:0;font-size:20px;font-weight:600">${escapeHtml(heading)}</h1>
      <p style="margin:6px 0 0;color:#c3ccde;font-size:15px">${escapeHtml(sub)}</p>
    </div>
    <div style="background:#fff;border:1px solid #ddd9d1;border-top:none;padding:24px;border-radius:0 0 3px 3px">
      ${inner}
    </div>
    <p style="margin:16px 0 0;font-size:12.5px;color:#8b93a1;text-align:center">
      As-Subkī Books · مكتبة السبكي
    </p>
  </div></body></html>`;
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
