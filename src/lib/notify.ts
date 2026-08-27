/**
 * Order notifications: confirmation to the customer, alert to the owner.
 *
 * Both channels are optional and fail soft. Email Sending needs the Workers
 * Paid plan and an onboarded domain, and the Telegram bot needs a token — none
 * of which exist on a preview deployment. The books are already held and the
 * order is already in the database by the time this runs, so a missing binding
 * degrades to a log line rather than a lost order.
 */

import { env } from 'cloudflare:workers';
import type { CreatedOrder } from './orders';
import { price, SITE } from './format';

interface NotifyInput {
  order: CreatedOrder;
  name: string;
  email: string;
  fulfilment: 'delivery' | 'collection';
  address?: string | null;
  notes?: string | null;
  origin: string;
}

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function itemsTable(order: CreatedOrder): string {
  const rows = order.items
    .map(
      (i) =>
        `<tr>
           <td style="padding:8px 0;border-bottom:1px solid #ddd9d1">${escape(i.title)}${
             i.qty > 1 ? ` <span style="color:#8b93a1">× ${i.qty}</span>` : ''
           }</td>
           <td style="padding:8px 0;border-bottom:1px solid #ddd9d1;text-align:right;white-space:nowrap">${price(
             i.pricePence * i.qty,
           )}</td>
         </tr>`,
    )
    .join('');
  return `<table style="width:100%;border-collapse:collapse;font-size:15px">
    ${rows}
    <tr><td style="padding:10px 0;font-weight:600">Subtotal</td>
        <td style="padding:10px 0;text-align:right;font-weight:600">${price(order.subtotalPence)}</td></tr>
  </table>`;
}

function customerEmail(input: NotifyInput): { subject: string; html: string; text: string } {
  const { order, name, origin } = input;
  const link = `${origin}/order/${order.ref}?t=${order.token}`;
  const expires = new Date(order.expiresAt * 1000).toUTCString();

  const html = `<!doctype html><html><body style="margin:0;background:#f5f4f0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#101828">
    <div style="max-width:560px;margin:0 auto;padding:28px 22px">
      <div style="background:#0e2a55;color:#fff;padding:22px 24px;border-radius:3px">
        <h1 style="margin:0;font-size:20px;font-weight:600">Request received</h1>
        <p style="margin:6px 0 0;color:#c3ccde;font-size:15px">Reference ${order.ref}</p>
      </div>
      <div style="background:#fff;border:1px solid #ddd9d1;border-top:none;padding:24px;border-radius:0 0 3px 3px">
        <p style="margin:0 0 16px;font-size:15px">Assalamu alaikum ${escape(name)},</p>
        <p style="margin:0 0 18px;font-size:15px;line-height:1.6">
          Thank you — we have your request and these books are now held for you.
          <strong>We will reply with the total including postage and how to pay.</strong>
        </p>
        ${itemsTable(order)}
        <p style="margin:18px 0 0;font-size:14px;color:#4a5568;line-height:1.6">
          ${input.fulfilment === 'collection' ? 'For collection.' : `To be posted to:<br>${escape(input.address ?? '')}`}
        </p>
        ${input.notes ? `<p style="margin:12px 0 0;font-size:14px;color:#4a5568">Your note: ${escape(input.notes)}</p>` : ''}
        <p style="margin:22px 0 0"><a href="${link}" style="background:#184485;color:#fff;padding:11px 20px;border-radius:2px;text-decoration:none;font-size:15px;display:inline-block">View your request</a></p>
        <p style="margin:20px 0 0;font-size:13.5px;color:#8b93a1;line-height:1.6">
          We hold these copies until ${expires}. If we have not heard from you by then the hold
          lapses and the books return to the shelf — nothing is charged and there is nothing to
          cancel. No payment is taken on our website at any point.
        </p>
      </div>
      <p style="margin:16px 0 0;font-size:12.5px;color:#8b93a1;text-align:center">${SITE.name} · ${SITE.nameAr}</p>
    </div></body></html>`;

  const text =
    `Request received — ${order.ref}\n\n` +
    `Assalamu alaikum ${name},\n\nWe have your request and these books are held for you. ` +
    `We will reply with the total including postage and how to pay.\n\n` +
    order.items.map((i) => `  ${i.title}${i.qty > 1 ? ` x${i.qty}` : ''}  ${price(i.pricePence * i.qty)}`).join('\n') +
    `\n  Subtotal: ${price(order.subtotalPence)}\n\n` +
    `View your request: ${link}\n\nHeld until ${expires}. No payment is taken on our website.\n`;

  return { subject: `Your request ${order.ref} — ${SITE.name}`, html, text };
}

function ownerEmail(input: NotifyInput): { subject: string; html: string; text: string } {
  const { order, name, email } = input;
  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#101828">
    <div style="max-width:560px;margin:0 auto;padding:24px">
      <h1 style="font-size:19px;margin:0 0 4px">New request ${order.ref}</h1>
      <p style="margin:0 0 18px;color:#4a5568;font-size:15px">${escape(name)} · ${escape(email)}
        ${input.phone ? ` · ${escape(String(input.phone))}` : ''}</p>
      ${itemsTable(order)}
      <p style="margin:16px 0 0;font-size:14px;color:#4a5568">
        ${input.fulfilment === 'collection' ? 'Collection' : `Delivery to:<br>${escape(input.address ?? '')}`}
      </p>
      ${input.notes ? `<p style="margin:10px 0 0;font-size:14px">Note: ${escape(input.notes)}</p>` : ''}
      <p style="margin:18px 0 0;font-size:13.5px;color:#8b93a1">Stock is held for 48 hours, then released automatically.</p>
    </div></body></html>`;

  const text =
    `New request ${order.ref}\n${name} · ${email}\n\n` +
    order.items.map((i) => `  ${i.title} x${i.qty}  ${price(i.pricePence * i.qty)}`).join('\n') +
    `\n  Subtotal: ${price(order.subtotalPence)}\n`;

  return { subject: `New request ${order.ref} — ${name}`, html, text };
}

interface SendEmailBinding {
  send(msg: { to: string; from: string; subject: string; html?: string; text?: string }): Promise<unknown>;
}

async function send(
  to: string,
  msg: { subject: string; html: string; text: string },
): Promise<void> {
  const binding = (env as unknown as { EMAIL?: SendEmailBinding }).EMAIL;
  const from = (env as unknown as { ORDER_FROM?: string }).ORDER_FROM;

  if (!binding || !from) {
    console.log(`[notify] email skipped (no EMAIL binding or ORDER_FROM) → ${to}: ${msg.subject}`);
    return;
  }

  await binding.send({ to, from, subject: msg.subject, html: msg.html, text: msg.text });
}

async function sendTelegram(input: NotifyInput): Promise<void> {
  const e = env as unknown as { TELEGRAM_BOT_TOKEN?: string; TELEGRAM_OWNER_CHAT_ID?: string };
  if (!e.TELEGRAM_BOT_TOKEN || !e.TELEGRAM_OWNER_CHAT_ID) {
    console.log(`[notify] telegram skipped (no bot token) → ${input.order.ref}`);
    return;
  }

  const { order, name, email, origin } = input;
  const lines = [
    `*New request ${order.ref}*`,
    `${name} — ${email}`,
    '',
    ...order.items.map((i) => `• ${i.title}${i.qty > 1 ? ` ×${i.qty}` : ''} — ${price(i.pricePence * i.qty)}`),
    '',
    `Subtotal *${price(order.subtotalPence)}* · ${input.fulfilment}`,
    `${origin}/order/${order.ref}?t=${order.token}`,
  ];

  const res = await fetch(`https://api.telegram.org/bot${e.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: e.TELEGRAM_OWNER_CHAT_ID,
      text: lines.join('\n'),
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) console.error('[notify] telegram failed', res.status, await res.text());
}

export async function sendOrderEmails(input: NotifyInput & { phone?: string | null }): Promise<void> {
  const ownerTo = (env as unknown as { OWNER_EMAIL?: string }).OWNER_EMAIL ?? SITE.email;

  // One failing channel must not suppress the others.
  const results = await Promise.allSettled([
    send(input.email, customerEmail(input)),
    send(ownerTo, ownerEmail(input)),
    sendTelegram(input),
  ]);

  for (const r of results) {
    if (r.status === 'rejected') console.error('[notify] channel failed', r.reason);
  }
}
