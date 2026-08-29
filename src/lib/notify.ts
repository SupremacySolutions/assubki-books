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
import { statusMessage } from './order-status';
import { getSetting } from './settings';

export interface PlacedInput {
  order: CreatedOrder;
  name: string;
  email: string;
  phone?: string | null;
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
  const link = `${origin}/order?ref=${order.ref}&t=${order.token}`;
  const optIn = optInLink(order.ref, order.token);
  const expires = new Date(order.expiresAt * 1000).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

  // Offered to everyone, as on the order page: checkout no longer asks for a
  // username, and the deep link is the only way the bot is allowed to open a
  // chat at all. Someone already reachable does not need asking again.
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
    `<p style="margin:0 0 16px;font-size:15px">السلام عليكم ${escapeHtml(name)},</p>
     <p style="margin:0 0 18px;font-size:15px;line-height:1.6">
       Thank you - we have your request and these books are held for you.
       <strong>We will reply with the total including postage and how to pay.</strong>
     </p>
     ${itemRows(order.items, order.subtotalPence)}
     <p style="margin:18px 0 0;font-size:14px;color:#4a5568;line-height:1.6;white-space:pre-line">${
       input.fulfilment === 'collection'
         ? 'For collection.'
         : `To be posted to:\n${escapeHtml(input.address ?? '')}`
     }</p>
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
    `Request received - ${order.ref}\n\nالسلام عليكم ${name},\n\n` +
    `We have your request and these books are held for you. We will reply with the total ` +
    `including postage and how to pay.\n\n` +
    order.items
      .map((i) => `  ${i.title}${i.qty > 1 ? ` x${i.qty}` : ''}  ${price(i.pricePence * i.qty)}`)
      .join('\n') +
    `\n  Subtotal: ${price(order.subtotalPence)}\n\n` +
    (input.fulfilment === 'collection'
      ? 'For collection.\n\n'
      : `To be posted to:\n${input.address ?? ''}\n\n`) +
    (optIn && !order.telegramChatId ? `Get payment details on Telegram: ${optIn}\n\n` : '') +
    `View your request: ${link}\n\nHeld until ${expires}. No payment is taken on our website.\n`;

  return { subject: `Your request ${order.ref} - ${SITE.name}`, html, text };
}

function ownerPlaced(input: PlacedInput) {
  const { order, name, email, origin } = input;

  const contact = [
    `Email: ${escapeHtml(email)}`,
    input.phone ? `Phone: ${escapeHtml(input.phone)}` : null,
  ]
    .filter(Boolean)
    .join('<br>');

  const html = shell(
    `New request ${order.ref}`,
    `${order.items.reduce((n, i) => n + i.qty, 0)} book(s) · ${price(order.subtotalPence)}`,
    `<p style="margin:0 0 6px;font-size:16px;font-weight:600">${escapeHtml(name)}</p>
     <p style="margin:0 0 18px;font-size:14px;color:#4a5568;line-height:1.6">${contact}</p>
     ${itemRows(order.items, order.subtotalPence)}
     <p style="margin:18px 0 0;font-size:14px;color:#4a5568;line-height:1.6;white-space:pre-line"><strong style="color:#101828">${
       input.fulfilment === 'collection' ? 'Collection' : 'Deliver to'
     }</strong>\n${
       input.fulfilment === 'collection'
         ? 'Customer is collecting in person.'
         : escapeHtml(input.address ?? '')
     }</p>
     ${input.notes ? `<p style="margin:12px 0 0;font-size:14px"><strong>Note:</strong> ${escapeHtml(input.notes)}</p>` : ''}
     ${button(`${origin}/admin/orders/${order.ref}`, 'Confirm and send payment details')}
     <p style="margin:18px 0 0;font-size:13.5px;color:#8b93a1">
       Stock is held for 48 hours from now, then released automatically.
     </p>`,
  );

  const text =
    `New request ${order.ref}\n${name}\n${email}` +
    (input.phone ? ` · ${input.phone}` : '') +
    `\n\n` +
    order.items.map((i) => `  ${i.title} x${i.qty}  ${price(i.pricePence * i.qty)}`).join('\n') +
    `\n  Subtotal: ${price(order.subtotalPence)}\n\n` +
    (input.fulfilment === 'collection' ? 'Collection\n' : `Deliver to:\n${input.address ?? ''}\n`) +
    (input.notes ? `\nNote: ${input.notes}\n` : '') +
    `\nConfirm: ${origin}/admin/orders/${order.ref}\n`;

  return { subject: `New request ${order.ref} - ${name}`, html, text };
}

/*
 * Customer mail is sent from orders@assubkibooks.co.uk, an address on a domain
 * whose inbound mail still sits at IONOS. Rather than depend on a mailbox
 * existing there, every message to a customer replies to the address the shop
 * actually reads, so a reply cannot fall down a hole nobody is watching.
 */
export async function notifyOrderPlaced(input: PlacedInput): Promise<void> {
  const ownerChatId = await getSetting('owner_telegram_chat_id');
  const telegramOwner = ownerChatId && botConfigured()
    ? sendMessage(
        ownerChatId,
        [
          `*${esc(`New order ${input.order.ref}`)}*`,
          '',
          esc(`${input.name} · ${price(input.order.subtotalPence)}`),
          esc(input.order.items.map((item) => `${item.title} x${item.qty}`).join('\n')),
          '',
          esc(`Open order: ${input.origin}/admin/orders/${input.order.ref}`),
        ].join('\n'),
      )
    : Promise.resolve(false);
  const results = await Promise.allSettled([
    deliver({ to: input.email, replyTo: ownerAddress(), ...customerPlaced(input) }),
    deliver({ to: ownerAddress(), replyTo: input.email, ...ownerPlaced(input) }),
    telegramOwner,
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
  /** Collection orders only: the money is handed over at the door. */
  cashPayment?: boolean;
  origin: string;
}

function confirmedEmail(input: ConfirmedInput) {
  const link = `${input.origin}/order?ref=${input.ref}&t=${input.token}`;
  // Nothing is owed yet on a cash collection, so the message stops asking for
  // money and asks for a time instead. The figures still go, because the
  // customer wants to know what they are bringing.
  const cash = Boolean(input.cashPayment);
  const totalLabel = cash ? 'Total, payable on collection' : 'Total to pay';
  const quote = cash
    ? `Quote ${input.ref} when you collect.`
    : `Please quote ${input.ref} with your payment.`;

  const html = shell(
    'Your order is confirmed',
    `Reference ${input.ref} · ${price(input.totalPence)}${cash ? '' : ' to pay'}`,
    `<p style="margin:0 0 16px;font-size:15px">السلام عليكم ${escapeHtml(input.name)},</p>
     <p style="margin:0 0 18px;font-size:15px;line-height:1.6">
       ${
         cash
           ? 'Your books are set aside. Here is what they come to - you can pay in cash when you collect.'
           : 'Your books are reserved. Here is the total and how to pay.'
       }
     </p>
     ${itemRows(
       input.items,
       input.subtotalPence,
       input.fulfilment === 'collection' ? [] : [{ label: 'Postage', pence: input.postagePence }],
       totalLabel,
       input.totalPence,
     )}
     <div style="margin:22px 0 0;padding:16px;background:#f5f4f0;border:1px solid #ddd9d1;border-radius:3px">
       <p style="margin:0 0 8px;font-size:15px;font-weight:600">${cash ? 'Collecting your books' : 'How to pay'}</p>
       <p style="margin:0;font-size:14.5px;color:#4a5568;line-height:1.65;white-space:pre-line">${escapeHtml(
         input.paymentInstructions,
       )}</p>
       <p style="margin:12px 0 0;font-size:14.5px">${
         cash
           ? `Quote <strong>${escapeHtml(input.ref)}</strong> when you collect.`
           : `Please quote <strong>${escapeHtml(input.ref)}</strong> with your payment.`
       }</p>
     </div>
     ${button(link, 'View your order')}
     <p style="margin:20px 0 0;font-size:13.5px;color:#8b93a1;line-height:1.6">
       ${
         cash
           ? 'No payment is taken on our website. Message us to agree a time and the books will be waiting.'
           : 'Once your payment reaches us we will confirm and post your books.'
       }
     </p>`,
  );

  const text =
    `Your order ${input.ref} is confirmed\n\nالسلام عليكم ${input.name},\n\n` +
    input.items
      .map((i) => `  ${i.title}${i.qty > 1 ? ` x${i.qty}` : ''}  ${price(i.pricePence * i.qty)}`)
      .join('\n') +
    `\n  Subtotal: ${price(input.subtotalPence)}` +
    (input.fulfilment === 'collection' ? '' : `\n  Postage: ${price(input.postagePence)}`) +
    `\n  ${totalLabel.toUpperCase()}: ${price(input.totalPence)}\n\n` +
    `${cash ? 'Collecting your books' : 'How to pay'}\n${input.paymentInstructions}\n\n` +
    `${quote}\n\n${link}\n`;

  const subject = cash
    ? `Order ${input.ref} confirmed - ${price(input.totalPence)} on collection`
    : `Order ${input.ref} confirmed - ${price(input.totalPence)} to pay`;
  return { subject, html, text };
}

function confirmedTelegram(input: ConfirmedInput): string {
  const cash = Boolean(input.cashPayment);
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
    `*${esc(
      cash
        ? `Total ${price(input.totalPence)}, payable on collection`
        : `Total to pay ${price(input.totalPence)}`,
    )}*`,
    '',
    `*${esc(cash ? 'Collecting your books' : 'How to pay')}*`,
    esc(input.paymentInstructions),
    '',
    esc(cash ? `Quote ${input.ref} when you collect.` : `Please quote ${input.ref} with your payment.`),
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
    deliver({ to: input.email, replyTo: ownerAddress(), ...confirmedEmail(input) }),
    input.telegramChatId && botConfigured()
      ? sendMessage(input.telegramChatId, confirmedTelegram(input))
      : Promise.resolve(false),
  ]);

  return {
    email: emailResult.status === 'fulfilled' && emailResult.value,
    telegram: telegramResult.status === 'fulfilled' && telegramResult.value,
  };
}

/**
 * The organiser's own link to a group basket they have just started.
 *
 * Their role is a key, not a browser setting, and a key can be lost: clearing
 * the browser or picking the basket up on a phone used to leave them an
 * ordinary member of their own group, with nobody able to send it. The link is
 * in their inbox now, exactly as an order's link is.
 */
export async function notifyGroupStarted(input: {
  name: string;
  email: string;
  code: string;
  organiserLink: string;
  shareLink: string;
}): Promise<boolean> {
  const html = shell(
    'Your group basket',
    `Reference ${input.code}`,
    `<p style="margin:0 0 16px;font-size:15px">السلام عليكم ${escapeHtml(input.name)},</p>
     <p style="margin:0 0 18px;font-size:15px;line-height:1.6">
       Your group basket is open. Send the first link to everyone adding to it; keep the second for
       yourself - it is the one that sends the order to us when the list is complete.
     </p>
     <p style="margin:0 0 6px;font-size:14px;font-weight:600">The link to share</p>
     <p style="margin:0 0 18px;font-size:13.5px;color:#4a5568;word-break:break-all">${escapeHtml(input.shareLink)}</p>
     <p style="margin:0 0 6px;font-size:14px;font-weight:600">Your own link - keep this one</p>
     <p style="margin:0 0 18px;font-size:13.5px;color:#4a5568;word-break:break-all">${escapeHtml(input.organiserLink)}</p>
     ${button(input.organiserLink, 'Open your group basket')}
     <p style="margin:20px 0 0;font-size:13.5px;color:#8b93a1;line-height:1.6">
       Nothing is held or charged while a group basket is being filled. The books are only set aside
       once you send it, and it lasts a week.
     </p>`,
  );

  const text =
    `Your group basket ${input.code}\n\nالسلام عليكم ${input.name},\n\n` +
    `Share this link with everyone adding to it:\n${input.shareLink}\n\n` +
    `Keep this one for yourself - it sends the order when the list is complete:\n${input.organiserLink}\n\n` +
    `Nothing is held or charged while a group basket is being filled. It lasts a week.\n`;

  return deliver({
    to: input.email,
    replyTo: ownerAddress(),
    subject: `Your group basket ${input.code} - ${SITE.name}`,
    html,
    text,
  });
}

/** Plain status nudges - dispatched, cancelled. */
export async function notifyStatusChange(input: {
  ref: string;
  token: string;
  name: string;
  email: string;
  telegramChatId?: string | null;
  status: string;
  /** Required: without it a collection customer is told their books were posted. */
  fulfilment: string;
  origin: string;
  tracking?: string | null;
  provider?: string | null;
  collectionAddress?: string;
  /** Collection orders only: they are paying cash when they arrive. */
  cashPayment?: boolean;
}): Promise<void> {
  // The words come from lib/order-status so that email, the customer page, the
  // timeline and the portal cannot drift apart - which is exactly how collection
  // orders ended up being described as posted in three of those four places.
  const copy = statusMessage(input.status, input.fulfilment, {
    ref: input.ref,
    tracking: input.tracking,
    provider: input.provider,
    collectionAddress: input.collectionAddress,
    cashPayment: input.cashPayment,
  });
  if (!copy) return;

  const link = `${input.origin}/order?ref=${input.ref}&t=${input.token}`;

  await Promise.allSettled([
    deliver({
      to: input.email,
      replyTo: ownerAddress(),
      subject: copy.subject,
      html: shell(
        copy.subject,
        `Reference ${input.ref}`,
        `<p style="margin:0 0 16px;font-size:15px">السلام عليكم ${escapeHtml(input.name)},</p>
         <p style="margin:0;font-size:15px;line-height:1.6">${escapeHtml(copy.line)}</p>
         ${copy.trackingLink ? button(copy.trackingLink, 'Track this parcel') : ''}
         ${button(link, 'View your order')}`,
      ),
      text:
        `${copy.subject}\n\nالسلام عليكم ${input.name},\n\n${copy.line}\n\n` +
        (copy.trackingLink ? `Track it here: ${copy.trackingLink}\n\n` : '') +
        `${link}\n`,
    }),
    input.telegramChatId && botConfigured()
      ? sendMessage(
          input.telegramChatId,
          `*${esc(copy.subject)}*\n\n${esc(copy.line)}` +
            (copy.trackingLink ? `\n\n${esc(`Track it here: ${copy.trackingLink}`)}` : ''),
        )
      : Promise.resolve(false),
  ]);
}
