/**
 * Order notifications.
 *
 * Two moments matter:
 *
 *   1. **Request placed** - the owner needs everything needed to fulfil it in
 *      one email: who, where, what, how many. The customer gets an
 *      acknowledgement and, prominently, the one-tap link that lets the bot
 *      reach them.
 *
 *   2. **Owner confirms** - the first time a real total exists, because postage
 *      is only known once someone looks at the address. This is the message
 *      carrying payment instructions, and it goes by Telegram if the customer
 *      linked their chat, by email otherwise.
 *
 * Every channel fails soft and independently. The order is already committed
 * and the stock already held before any of this runs.
 */

import type { CreatedOrder } from './orders';
import { price, SITE } from './format';
import { deliver, ownerAddress, shell, button, itemRows, escapeHtml } from './email';
import { sendMessage, optInLink, esc, botConfigured } from './telegram';

export interface PlacedInput {
  order: CreatedOrder;
  name: string;
  email: string;
  phone?: string | null;
  telegram?: string | null;
  fulfilment: 'delivery' | 'collection';
  address?: string | null;
  notes?: string | null;
  origin: string;
}

// ---------------------------------------------------------------------------
// 1. Request placed
// ---------------------------------------------------------------------------

function customerPlaced(input: PlacedInput) {
  const { order, name, origin } = input;
  const link = `${origin}/order/${order.ref}?t=${order.token}`;
  const optIn = optInLink(order.ref, order.token);
  const expires = new Date(order.expiresAt * 1000).toUTCString();

  // Someone already reachable does not need asking again.
  const telegramBlock = optIn && !order.telegramChatId
    ? `<div style="margin:22px 0 0;padding:16px;background:#f5f4f0;border:1px solid #ddd9d1;border-radius:3px">
         <p style="margin:0 0 4px;font-size:15px;font-weight:600">Get your payment details on Telegram</p>
         <p style="margin:0 0 12px;font-size:14px;color:#4a5568;line-height:1.55">
           Tap once to connect this order to your Telegram. We will send the total and how to pay
           straight to your chat.
         </p>
         <a href="${escapeHtml(optIn)}" style="background:#229ED9;color:#fff;padding:10px 18px;border-radius:2px;text-decoration:none;font-size:15px;display:inline-block">Connect Telegram</a>
       </div>`
    : '';

  const html = shell(
    'Request received',
    `Reference ${order.ref}`,
    `<p style="margin:0 0 16px;font-size:15px">Assalamu alaikum ${escapeHtml(name)},</p>
     <p style="margin:0 0 18px;font-size:15px;line-height:1.6">
       Thank you - we have your request and these books are held for you.
       <strong>We will reply with the total including postage and how to pay.</strong>
     </p>
     ${itemRows(order.items, order.subtotalPence)}
     <p style="margin:18px 0 0;font-size:14px;color:#4a5568;line-height:1.6">
       ${
         input.fulfilment === 'collection'
           ? 'For collection.'
           : `To be posted to:<br>${escapeHtml(input.address ?? '')}`
       }
     </p>
     ${input.notes ? `<p style="margin:12px 0 0;font-size:14px;color:#4a5568">Your note: ${escapeHtml(input.notes)}</p>` : ''}
     ${telegramBlock}
     ${button(link, 'View your request')}
     <p style="margin:20px 0 0;font-size:13.5px;color:#8b93a1;line-height:1.6">
       We hold these copies until ${escapeHtml(expires)}. If we have not heard from you by then the
       hold lapses and the books return to the shelf - nothing is charged and there is nothing to
       cancel. No payment is taken on our website at any point.
     </p>`,
  );

  const text =
    `Request received - ${order.ref}\n\nAssalamu alaikum ${name},\n\n` +
    `We have your request and these books are held for you. We will reply with the total ` +
    `including postage and how to pay.\n\n` +
    order.items
      .map((i) => `  ${i.title}${i.qty > 1 ? ` x${i.qty}` : ''}  ${price(i.pricePence * i.qty)}`)
      .join('\n') +
    `\n  Subtotal: ${price(order.subtotalPence)}\n\n` +
    (optIn && !order.telegramChatId ? `Get payment details on Telegram: ${optIn}\n\n` : '') +
    `View your request: ${link}\n\nHeld until ${expires}. No payment is taken on our website.\n`;

  return { subject: `Your request ${order.ref} - ${SITE.name}`, html, text };
}

function ownerPlaced(input: PlacedInput) {
  const { order, name, email, origin } = input;

  const contact = [
    `Email: ${escapeHtml(email)}`,
    input.phone ? `Phone: ${escapeHtml(input.phone)}` : null,
    input.telegram ? `Telegram: ${escapeHtml(input.telegram)}` : null,
  ]
    .filter(Boolean)
    .join('<br>');

  const html = shell(
    `New request ${order.ref}`,
    `${order.items.reduce((n, i) => n + i.qty, 0)} book(s) · ${price(order.subtotalPence)}`,
    `<p style="margin:0 0 6px;font-size:16px;font-weight:600">${escapeHtml(name)}</p>
     <p style="margin:0 0 18px;font-size:14px;color:#4a5568;line-height:1.6">${contact}</p>
     ${itemRows(order.items, order.subtotalPence)}
     <p style="margin:18px 0 0;font-size:14px;color:#4a5568;line-height:1.6">
       <strong style="color:#101828">${input.fulfilment === 'collection' ? 'Collection' : 'Deliver to'}</strong><br>
       ${input.fulfilment === 'collection' ? 'Customer is collecting in person.' : escapeHtml(input.address ?? '')}
     </p>
     ${input.notes ? `<p style="margin:12px 0 0;font-size:14px"><strong>Note:</strong> ${escapeHtml(input.notes)}</p>` : ''}
     ${button(`${origin}/admin/orders/${order.ref}`, 'Confirm and send payment details')}
     <p style="margin:18px 0 0;font-size:13.5px;color:#8b93a1">
       Stock is held for 48 hours from now, then released automatically.
     </p>`,
  );

  const text =
    `New request ${order.ref}\n${name}\n${email}` +
    (input.phone ? ` · ${input.phone}` : '') +
    (input.telegram ? ` · ${input.telegram}` : '') +
    `\n\n` +
    order.items.map((i) => `  ${i.title} x${i.qty}  ${price(i.pricePence * i.qty)}`).join('\n') +
    `\n  Subtotal: ${price(order.subtotalPence)}\n\n` +
    (input.fulfilment === 'collection' ? 'Collection\n' : `Deliver to:\n${input.address}\n`) +
    (input.notes ? `\nNote: ${input.notes}\n` : '') +
    `\nConfirm: ${origin}/admin/orders/${order.ref}\n`;

  return { subject: `New request ${order.ref} - ${name}`, html, text };
}

export async function notifyOrderPlaced(input: PlacedInput): Promise<void> {
  const results = await Promise.allSettled([
    deliver({ to: input.email, ...customerPlaced(input) }),
    deliver({ to: ownerAddress(), replyTo: input.email, ...ownerPlaced(input) }),
  ]);
  for (const r of results) {
    if (r.status === 'rejected') console.error('[notify] placed channel failed', r.reason);
  }
}

// ---------------------------------------------------------------------------
// 2. Owner confirms - the message that carries payment instructions
// ---------------------------------------------------------------------------

export interface ConfirmedInput {
  ref: string;
  token: string;
  name: string;
  email: string;
  telegramChatId?: string | null;
  items: { title: string; qty: number; pricePence: number }[];
  subtotalPence: number;
  postagePence: number;
  totalPence: number;
  fulfilment: string;
  paymentInstructions: string;
  origin: string;
}

function confirmedEmail(input: ConfirmedInput) {
  const link = `${input.origin}/order/${input.ref}?t=${input.token}`;

  const html = shell(
    'Your order is confirmed',
    `Reference ${input.ref} · ${price(input.totalPence)} to pay`,
    `<p style="margin:0 0 16px;font-size:15px">Assalamu alaikum ${escapeHtml(input.name)},</p>
     <p style="margin:0 0 18px;font-size:15px;line-height:1.6">
       Your books are reserved. Here is the total and how to pay.
     </p>
     ${itemRows(
       input.items,
       input.subtotalPence,
       input.fulfilment === 'collection' ? [] : [{ label: 'Postage', pence: input.postagePence }],
       'Total to pay',
       input.totalPence,
     )}
     <div style="margin:22px 0 0;padding:16px;background:#f5f4f0;border:1px solid #ddd9d1;border-radius:3px">
       <p style="margin:0 0 8px;font-size:15px;font-weight:600">How to pay</p>
       <p style="margin:0;font-size:14.5px;color:#4a5568;line-height:1.65;white-space:pre-line">${escapeHtml(
         input.paymentInstructions,
       )}</p>
       <p style="margin:12px 0 0;font-size:14.5px">
         Please quote <strong>${escapeHtml(input.ref)}</strong> with your payment.
       </p>
     </div>
     ${button(link, 'View your order')}
     <p style="margin:20px 0 0;font-size:13.5px;color:#8b93a1;line-height:1.6">
       Once your payment reaches us we will confirm and post your books.
     </p>`,
  );

  const text =
    `Your order ${input.ref} is confirmed\n\nAssalamu alaikum ${input.name},\n\n` +
    input.items
      .map((i) => `  ${i.title}${i.qty > 1 ? ` x${i.qty}` : ''}  ${price(i.pricePence * i.qty)}`)
      .join('\n') +
    `\n  Subtotal: ${price(input.subtotalPence)}` +
    (input.fulfilment === 'collection' ? '' : `\n  Postage: ${price(input.postagePence)}`) +
    `\n  TOTAL TO PAY: ${price(input.totalPence)}\n\n` +
    `How to pay\n${input.paymentInstructions}\n\n` +
    `Please quote ${input.ref} with your payment.\n\n${link}\n`;

  return { subject: `Order ${input.ref} confirmed - ${price(input.totalPence)} to pay`, html, text };
}

function confirmedTelegram(input: ConfirmedInput): string {
  const lines = [
    `*${esc(`Order ${input.ref} confirmed`)}*`,
    '',
    ...input.items.map(
      // Every literal here goes through esc() too. A bare "-" is reserved in
      // MarkdownV2 and rejects the whole message, which is how this line
      // silently stopped delivering payment details once.
      (i) => `• ${esc(i.title)}${i.qty > 1 ? esc(` ×${i.qty}`) : ''}${esc(' - ')}${esc(price(i.pricePence * i.qty))}`,
    ),
    '',
    `${esc('Subtotal')} ${esc(price(input.subtotalPence))}`,
  ];
  if (input.fulfilment !== 'collection') {
    lines.push(`${esc('Postage')} ${esc(price(input.postagePence))}`);
  }
  lines.push(
    `*${esc(`Total to pay ${price(input.totalPence)}`)}*`,
    '',
    `*${esc('How to pay')}*`,
    esc(input.paymentInstructions),
    '',
    esc(`Please quote ${input.ref} with your payment.`),
  );
  return lines.join('\n');
}

/**
 * Sends the confirmation. Telegram is preferred when the customer linked their
 * chat - most arrive from the channel, so that is where they actually read -
 * but the email always goes too, because a single channel is a single point of
 * failure for the one message that carries payment details.
 */
export async function notifyOrderConfirmed(
  input: ConfirmedInput,
): Promise<{ email: boolean; telegram: boolean }> {
  const [emailResult, telegramResult] = await Promise.allSettled([
    deliver({ to: input.email, ...confirmedEmail(input) }),
    input.telegramChatId && botConfigured()
      ? sendMessage(input.telegramChatId, confirmedTelegram(input))
      : Promise.resolve(false),
  ]);

  return {
    email: emailResult.status === 'fulfilled' && emailResult.value,
    telegram: telegramResult.status === 'fulfilled' && telegramResult.value,
  };
}

/** Plain status nudges - dispatched, cancelled. */
export async function notifyStatusChange(input: {
  ref: string;
  token: string;
  name: string;
  email: string;
  telegramChatId?: string | null;
  status: string;
  origin: string;
}): Promise<void> {
  const COPY: Record<string, { subject: string; line: string }> = {
    paid: {
      subject: `Payment received - ${input.ref}`,
      line: 'We have received your payment. Your books are being packed.',
    },
    dispatched: {
      subject: `Your books are on the way - ${input.ref}`,
      line: 'Your order has been posted. Thank you for your custom.',
    },
    cancelled: {
      subject: `Order ${input.ref} cancelled`,
      line: 'This request has been cancelled and nothing was charged.',
    },
  };

  const copy = COPY[input.status];
  if (!copy) return;

  const link = `${input.origin}/order/${input.ref}?t=${input.token}`;

  await Promise.allSettled([
    deliver({
      to: input.email,
      subject: copy.subject,
      html: shell(
        copy.subject,
        `Reference ${input.ref}`,
        `<p style="margin:0 0 16px;font-size:15px">Assalamu alaikum ${escapeHtml(input.name)},</p>
         <p style="margin:0;font-size:15px;line-height:1.6">${escapeHtml(copy.line)}</p>
         ${button(link, 'View your order')}`,
      ),
      text: `${copy.subject}\n\nAssalamu alaikum ${input.name},\n\n${copy.line}\n\n${link}\n`,
    }),
    input.telegramChatId && botConfigured()
      ? sendMessage(input.telegramChatId, `*${esc(copy.subject)}*\n\n${esc(copy.line)}`)
      : Promise.resolve(false),
  ]);
}
