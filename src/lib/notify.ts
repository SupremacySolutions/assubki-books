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

import { env } from 'cloudflare:workers';
import type { CreatedOrder } from './orders';
import { claimWaiting } from './stock-alerts';
import { price, SITE } from './format';
import { deliver, ownerAddress, shell, button, itemRows, escapeHtml, noReply, noReplyText } from './email';
import { sendMessage, sendMessageId, optInLink, esc, botConfigured, mdLink } from './telegram';
import { statusMessage, cashMoment, BACK_IN_STOCK } from './order-status';
import { getSetting } from './settings';

export interface PlacedInput {
  order: CreatedOrder;
  name: string;
  email: string;
  phone?: string | null;
  fulfilment: 'delivery' | 'collection';
  /** What the customer asked for at checkout, if they said. */
  paymentPreference?: string | null;
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
  const expires = order.expiresAt
    ? new Date(order.expiresAt * 1000).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
    : null;

  /*
   * Three different things can have happened, and the standing wording is only
   * true for one of them.
   *
   * A reservation is not "held for 48 hours" - the books are not here to hold,
   * and there is no deadline for the customer to meet. A mixed order is neither
   * one nor the other: part of it is on the shelf and part of it is on a lorry,
   * and the only thing that matters is that it all travels together.
   */
  const waiting = order.items.filter((i) => i.fromIncoming);
  const onShelf = order.items.filter((i) => !i.fromIncoming);
  const kind: 'held' | 'mixed' | 'reserved' =
    waiting.length === 0 ? 'held' : onShelf.length === 0 ? 'reserved' : 'mixed';
  const due = order.waitingWhen ? ` expected ${order.waitingWhen}` : '';

  const opening = {
    held: 'Thank you - we have your request and these books are held for you.',
    reserved: `Thank you - we have your request and ${waiting.length === 1 ? 'this copy is' : 'these copies are'} reserved for you from our next delivery,${due || ' due shortly'}.`,
    mixed: `Thank you - we have your request. Some of it is on the shelf, and the rest is reserved for you from our next delivery,${due || ' due shortly'}.`,
  }[kind];

  const closing = {
    held: `We hold these copies until ${escapeHtml(expires ?? '')}. If we have not heard from you by then the hold lapses and the books return to the shelf - nothing is charged and there is nothing to cancel. No payment is taken on our website at any point.`,
    reserved: 'Your reservation does not run out - it stands until the delivery arrives, however long that takes. We will write again the moment it is in. No payment is taken on our website at any point.',
    mixed: 'Your whole order goes out in one parcel once everything has arrived, so nothing is sent before then. The reservation does not run out, and we will write again the moment the delivery is in. No payment is taken on our website at any point.',
  }[kind];

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
       ${escapeHtml(opening)}
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
       ${closing}
     </p>
     ${noReply(link)}`,
  );

  const text =
    `Request received - ${order.ref}\n\nالسلام عليكم ${name},\n\n` +
    `${opening} We will reply with the total including postage and how to pay.\n\n` +
    order.items
      .map((i) => `  ${i.title}${i.qty > 1 ? ` x${i.qty}` : ''}  ${price(i.pricePence * i.qty)}`)
      .join('\n') +
    `\n  Subtotal: ${price(order.subtotalPence)}\n\n` +
    (input.fulfilment === 'collection'
      ? 'For collection.\n\n'
      : `To be posted to:\n${input.address ?? ''}\n\n`) +
    (optIn && !order.telegramChatId ? `Get payment details on Telegram: ${optIn}\n\n` : '') +
    `View your request: ${link}\n\n${closing}\n` +
    noReplyText(link);

  return {
    subject:
      kind === 'reserved'
        ? `Reserved for you ${order.ref} - ${SITE.name}`
        : `Your request ${order.ref} - ${SITE.name}`,
    html,
    text,
  };
}

function ownerPlaced(input: PlacedInput) {
  const { order, name, email, origin } = input;
  const ownerWaiting = order.items.filter((i) => i.fromIncoming);

  const contact = [
    `Email: ${escapeHtml(email)}`,
    input.phone ? `Phone: ${escapeHtml(input.phone)}` : null,
    // What they would rather do about paying. Only shown when they said, since
    // an absent answer is not a preference for either.
    input.paymentPreference
      ? `Would rather pay: ${input.paymentPreference === 'cash' ? 'cash in person' : 'bank transfer'}`
      : null,
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
     ${
       ownerWaiting.length > 0
         ? `<p style="margin:14px 0 0;padding:12px 14px;background:#fbfaf7;border-left:3px solid #8a6714;font-size:14px;color:#4a5568;line-height:1.6">
              <strong style="color:#101828">Do not pack this yet.</strong><br>
              ${escapeHtml(ownerWaiting.map((i) => `${i.title}${i.qty > 1 ? ` x${i.qty}` : ''}`).join(', '))}
              ${ownerWaiting.length === 1 ? 'is' : 'are'} reserved from a delivery that has not arrived.
              The whole order goes out together once it is in.
            </p>`
         : ''
     }
     ${button(`${origin}/admin/orders/${order.ref}`, 'Confirm and send payment details')}
     <p style="margin:18px 0 0;font-size:13.5px;color:#8b93a1">
       ${
         ownerWaiting.length > 0
           ? 'This order has no 48-hour hold - a reservation stands until the delivery lands.'
           : 'Stock is held for 48 hours from now, then released automatically.'
       }
     </p>`,
  );

  const text =
    `New request ${order.ref}\n${name}\n${email}` +
    (input.phone ? ` · ${input.phone}` : '') +
    (input.paymentPreference
      ? `\nWould rather pay: ${input.paymentPreference === 'cash' ? 'cash in person' : 'bank transfer'}`
      : '') +
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

  /*
   * A customer whose chat is already linked hears about it here.
   *
   * There was never a placement message to the customer - only email - and a
   * first-time customer does not notice, because tapping the connect link
   * produces a welcome of its own. A returning customer, whose chat is carried
   * forward by email address in `createOrder`, got nothing at all until the
   * order was confirmed or cancelled: they had connected once, and Telegram
   * then stayed silent through the part where they were waiting.
   */
  const telegramCustomer =
    input.order.telegramChatId && botConfigured()
      ? sendMessage(
          input.order.telegramChatId,
          [
            esc(`السلام عليكم ${input.name.trim().split(/\s+/)[0]}`),
            '',
            `*${esc(`We have your request, ${input.order.ref}`)}*`,
            '',
            esc(input.order.items.map((i) => `• ${i.title}${i.qty > 1 ? ` ×${i.qty}` : ''}`).join('\n')),
            '',
            esc('The shop will confirm it shortly and send the total and how to pay here.'),
          ].join('\n'),
        )
      : Promise.resolve(false);
  const telegramOwner = ownerChatId && botConfigured()
    ? sendMessage(
        ownerChatId,
        [
          `*${esc(`New order ${input.order.ref}`)}*`,
          '',
          esc(`${input.name} · ${price(input.order.subtotalPence)}`),
          esc(input.order.items.map((item) => `${item.title} x${item.qty}`).join('\n')),
          '',
          mdLink(`Open order ${input.order.ref}`, `${input.origin}/admin/orders/${input.order.ref}`),
        ].join('\n'),
      )
    : Promise.resolve(false);
  const results = await Promise.allSettled([
    deliver({ to: input.email, ...customerPlaced(input) }),
    deliver({ to: ownerAddress(), replyTo: input.email, ...ownerPlaced(input) }),
    telegramOwner,
    telegramCustomer,
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

  // Nothing is owed yet on a cash order, so the message stops asking for money
  // and asks for a time instead. The figures still go, because the customer
  // wants to know what they are bringing. Cash is no longer collection-only,
  // so the moment the money changes hands has to be said per journey.
  const cash = Boolean(input.cashPayment);
  const moment = cashMoment(input.fulfilment);
  const totalLabel = cash ? `Total, payable ${moment}` : 'Total to pay';
  const quote = cash
    ? `Quote ${input.ref} ${moment}.`
    : `Please quote ${input.ref} with your payment.`;
  const heading = cash ? 'Paying in cash' : 'How to pay';

  const html = shell(
    'Your order is confirmed',
    `Reference ${input.ref} · ${price(input.totalPence)}${cash ? '' : ' to pay'}`,
    `<p style="margin:0 0 16px;font-size:15px">السلام عليكم ${escapeHtml(input.name)},</p>
     <p style="margin:0 0 18px;font-size:15px;line-height:1.6">
       ${
         cash
           ? `Your books are set aside. Here is what they come to - you can pay in cash ${moment}.`
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
       <p style="margin:0 0 8px;font-size:15px;font-weight:600">${heading}</p>
       <p style="margin:0;font-size:14.5px;color:#4a5568;line-height:1.65;white-space:pre-line">${escapeHtml(
         input.paymentInstructions,
       )}</p>
       <p style="margin:12px 0 0;font-size:14.5px">${
         cash
           ? `Quote <strong>${escapeHtml(input.ref)}</strong> ${escapeHtml(moment)}.`
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
     </p>
     ${noReply(link)}`,
  );

  const text =
    `Your order ${input.ref} is confirmed\n\nالسلام عليكم ${input.name},\n\n` +
    input.items
      .map((i) => `  ${i.title}${i.qty > 1 ? ` x${i.qty}` : ''}  ${price(i.pricePence * i.qty)}`)
      .join('\n') +
    `\n  Subtotal: ${price(input.subtotalPence)}` +
    (input.fulfilment === 'collection' ? '' : `\n  Postage: ${price(input.postagePence)}`) +
    `\n  ${totalLabel.toUpperCase()}: ${price(input.totalPence)}\n\n` +
    `${heading}\n${input.paymentInstructions}\n\n` +
    `${quote}\n\n${link}\n` +
    noReplyText(link);

  const subject = cash
    ? `Order ${input.ref} confirmed - ${price(input.totalPence)} in cash`
    : `Order ${input.ref} confirmed - ${price(input.totalPence)} to pay`;
  return { subject, html, text };
}

function confirmedTelegram(input: ConfirmedInput): string {
  const cash = Boolean(input.cashPayment);
  const moment = cashMoment(input.fulfilment);
  /*
   * Opens with the greeting and their first name.
   *
   * A customer whose chat carried over from a previous order never saw the
   * bot's connect message for this one, so without this the first thing they
   * get is a bare "Order ASB-XXXX confirmed" arriving unannounced.
   *
   * No full stop after the name: the greeting reads right to left and the
   * name ends it, so a stop lands at the left-hand edge and looks as though it
   * belongs to the next line.
   */
  const first = input.name.trim().split(/\s+/)[0];
  const lines = [
    ...(first ? [esc(`السلام عليكم ${first}`), ''] : []),
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
        ? `Total ${price(input.totalPence)}, payable ${moment}`
        : `Total to pay ${price(input.totalPence)}`,
    )}*`,
    '',
    `*${esc(cash ? 'Paying in cash' : 'How to pay')}*`,
    esc(input.paymentInstructions),
    '',
    esc(cash ? `Quote ${input.ref} ${moment}.` : `Please quote ${input.ref} with your payment.`),
  );

  // Only where there is a payment to prove. A cash order has nothing to send a
  // screenshot of - the money changes hands in person.
  if (!cash) {
    lines.push('', esc('When you have paid, send a screenshot here and it will reach the shop.'));
  }

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
     </p>
     ${noReply(null)}`,
  );

  const text =
    `Your group basket ${input.code}\n\nالسلام عليكم ${input.name},\n\n` +
    `Share this link with everyone adding to it:\n${input.shareLink}\n\n` +
    `Keep this one for yourself - it sends the order when the list is complete:\n${input.organiserLink}\n\n` +
    `Nothing is held or charged while a group basket is being filled. It lasts a week.\n` +
    noReplyText(null);

  return deliver({
    to: input.email,
    subject: `Your group basket ${input.code} - ${SITE.name}`,
    html,
    text,
  });
}

/** Plain status nudges - dispatched, cancelled. */
/**
 * Tells the owner a customer wants out of an order.
 *
 * The same two channels a new order uses, for the same reason: this needs an
 * answer, and the owner is not sitting in the portal waiting for one. It is
 * only an alert - the request is already recorded on the order, so a failure
 * here loses a nudge, not the fact.
 */
export async function notifyCancelRequest(input: {
  ref: string;
  name: string;
  email: string;
  reason: string | null;
  origin: string;
}): Promise<void> {
  const link = `${input.origin}/admin/orders/${input.ref}`;
  const ownerChatId = await getSetting('owner_telegram_chat_id');

  await Promise.allSettled([
    deliver({
      to: ownerAddress(),
      replyTo: input.email,
      subject: `Cancellation asked for - ${input.ref}`,
      html: shell(
        `Cancellation asked for`,
        `Reference ${input.ref}`,
        `<p style="margin:0;font-size:15px;line-height:1.6">${escapeHtml(input.name)} has asked to cancel this order. It is still live until you answer.</p>` +
          (input.reason
            ? `<p style="margin:16px 0 0;font-size:15px;line-height:1.6;white-space:pre-line"><strong>Their reason:</strong><br>${escapeHtml(input.reason)}</p>`
            : `<p style="margin:16px 0 0;font-size:15px;color:#6f7787">They did not give a reason.</p>`) +
          button(link, 'Open the order'),
      ),
      text:
        `${input.name} has asked to cancel ${input.ref}. It is still live until you answer.\n\n` +
        (input.reason ? `Their reason:\n${input.reason}\n\n` : 'They did not give a reason.\n\n') +
        `${link}\n`,
    }),
    ownerChatId && botConfigured()
      ? sendMessage(
          ownerChatId,
          `*${esc(`Cancellation asked for - ${input.ref}`)}*\n\n` +
            esc(`${input.name} has asked to cancel. It is still live until you answer.`) +
            (input.reason ? `\n\n${esc(input.reason)}` : '') +
            `\n\n${mdLink(`Open ${input.ref}`, link)}`,
        )
      : Promise.resolve(false),
  ]);
}

/**
 * Tells a customer the shop is keeping their order after all.
 *
 * Without this they sit on a page that says "still live until we reply" with
 * no reply ever coming, which is worse than never having offered to ask.
 */
export async function notifyCancelDeclined(input: {
  ref: string;
  token: string;
  name: string;
  email: string;
  telegramChatId?: string | null;
  note: string | null;
  origin: string;
}): Promise<void> {
  const link = `${input.origin}/order?ref=${input.ref}&t=${input.token}`;
  const line = 'We have looked at your order and it is going ahead as it stands.';

  await Promise.allSettled([
    deliver({
      to: input.email,
      subject: `Your order stands - ${input.ref}`,
      html: shell(
        'Your order stands',
        `Reference ${input.ref}`,
        `<p style="margin:0 0 16px;font-size:15px">السلام عليكم ${escapeHtml(input.name)},</p>
         <p style="margin:0;font-size:15px;line-height:1.6">${escapeHtml(line)}</p>` +
          (input.note
            ? `<p style="margin:16px 0 0;font-size:15px;line-height:1.6;white-space:pre-line">${escapeHtml(input.note)}</p>`
            : '') +
          button(link, 'View your order') +
          noReply(link),
      ),
      text:
        `Your order stands - ${input.ref}\n\nالسلام عليكم ${input.name},\n\n${line}\n\n` +
        (input.note ? `${input.note}\n\n` : '') +
        `${link}\n` +
        noReplyText(link),
    }),
    input.telegramChatId && botConfigured()
      ? sendMessage(
          input.telegramChatId,
          `*${esc(`Your order stands - ${input.ref}`)}*\n\n${esc(line)}` +
            (input.note ? `\n\n${esc(input.note)}` : ''),
        )
      : Promise.resolve(false),
  ]);
}

/**
 * Why the last status notification failed, and a way to clear it.
 *
 * `deliver()` already records send failures so the portal can say "email is
 * failing" rather than "email is configured". Nothing recorded a failure
 * *before* the send - so when notifyStatusChange threw on a bad reference, the
 * caller's .catch wrote a line to a log nobody reads and the portal went on
 * saying everything was fine for two days.
 */
export async function lastNotifyError(): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'last_notify_error'`)
    .first<{ value: string }>();
  return row?.value ?? null;
}

async function recordNotifyFailure(reason: string): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('last_notify_error', ?, unixepoch())
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()`,
    ).bind(reason.slice(0, 500)).run();
  } catch {
    /* never let health-reporting break the caller */
  }
}

async function clearNotifyFailure(): Promise<void> {
  try {
    await env.DB.prepare(`DELETE FROM settings WHERE key = 'last_notify_error'`).run();
  } catch {
    /* ignore */
  }
}

async function sendStatusChange(input: {
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
  /** The owner's own words when cancelling. Shown wherever the customer looks. */
  cancelNote?: string | null;
}): Promise<void> {
  /*
   * A cancellation usually has a reason, and the standing wording cannot know
   * it - "your order has been cancelled" and nothing else invites a reply
   * asking why. It goes into all three places the customer might look, so they
   * cannot disagree with each other.
   *
   * This was declared inside confirmedEmail, which is a different function that
   * never used it and is not even given one. Every status message therefore
   * threw ReferenceError on the way out, and the throw was swallowed by the
   * caller's .catch - so nobody was told their payment had arrived, their books
   * had been posted, or that their order was cancelled.
   */
  const note = (input.cancelNote ?? '').trim();

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
      subject: copy.subject,
      html: shell(
        copy.subject,
        `Reference ${input.ref}`,
        `<p style="margin:0 0 16px;font-size:15px">السلام عليكم ${escapeHtml(input.name)},</p>
         <p style="margin:0;font-size:15px;line-height:1.6">${escapeHtml(copy.line)}</p>
         ${
           note
             ? `<p style="margin:16px 0 0;font-size:15px;line-height:1.6;white-space:pre-line">${escapeHtml(note)}</p>`
             : ''
         }
         ${copy.trackingLink ? button(copy.trackingLink, 'Track this parcel') : ''}
         ${button(link, 'View your order')}
         ${noReply(link)}`,
      ),
      text:
        `${copy.subject}\n\nالسلام عليكم ${input.name},\n\n${copy.line}\n\n` +
        (note ? `${note}\n\n` : '') +
        (copy.trackingLink ? `Track it here: ${copy.trackingLink}\n\n` : '') +
        `${link}\n` +
        noReplyText(link),
    }),
    input.telegramChatId && botConfigured()
      ? sendMessage(
          input.telegramChatId,
          `*${esc(copy.subject)}*\n\n${esc(copy.line)}` +
            (note ? `\n\n${esc(note)}` : '') +
            (copy.trackingLink ? `\n\n${mdLink('Track it here', copy.trackingLink)}` : ''),
        )
      : Promise.resolve(false),
  ]);
}

/**
 * Tells the customer their order moved, and records it if that fails.
 *
 * The recording is the point. This threw on every call for two days and the
 * only trace was a console line in a Worker log; the portal went on reporting
 * that email was healthy, because a send that never happened cannot fail.
 */
export async function notifyStatusChange(
  input: Parameters<typeof sendStatusChange>[0],
): Promise<void> {
  try {
    await sendStatusChange(input);
    await clearNotifyFailure();
  } catch (err) {
    const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    await recordNotifyFailure(`${input.status} for ${input.ref} - ${reason}`);
    throw err;
  }
}


// ---------------------------------------------------------------------------
// 3. Somebody said something
// ---------------------------------------------------------------------------

/** Enough to judge whether it needs answering now, not enough to answer from. */
function preview(body: string | null, hasImage: boolean): string {
  const text = (body ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return hasImage ? 'Sent a photo.' : 'Sent a message.';
  return text.length > 140 ? `${text.slice(0, 139)}…` : text;
}

/**
 * Do not tell the same customer twice in half an hour.
 *
 * A full test run is already about 38 emails, which is most of a day's free
 * Resend allowance; five replies in a row must not be five emails. The rule is
 * deliberately per-order state on the order rather than a global marker, so one
 * chatty conversation cannot silence a different customer's first notification.
 *
 * The debounce lifts as soon as the customer opens the thread - `markRead`
 * clears `unread_for_customer`, and an unread count of zero means the last
 * notification did its job and the next one is worth sending.
 */
const NOTIFY_EVERY = 30 * 60;

export async function notifyNewMessage(input: {
  orderId: number;
  ref: string;
  /** Who spoke. The notification goes to the other one. */
  sender: 'customer' | 'owner';
  name: string;
  email: string;
  telegramChatId?: string | null;
  body: string | null;
  hasImage: boolean;
  origin: string;
}): Promise<void> {
  try {
    if (input.sender === 'customer') await tellOwner(input);
    else await tellCustomer(input);
    await clearNotifyFailure();
  } catch (err) {
    const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    await recordNotifyFailure(`message on ${input.ref} - ${reason}`);
    /*
     * Swallowed, unlike a status change. The message is already saved and both
     * sides can see it on their own page; a Telegram outage must not turn into
     * a 500 that loses what the customer typed.
     */
  }
}

/**
 * The owner hears about a customer message on Telegram, immediately.
 *
 * They are bound to the bot, so there is a channel that reaches their phone -
 * which is why the portal does not poll for this at all. No debounce here: the
 * owner asked to be told, and a customer sending three messages is three things
 * they may need to act on.
 */
async function tellOwner(input: {
  orderId: number;
  ref: string;
  name: string;
  body: string | null;
  hasImage: boolean;
  origin: string;
}): Promise<void> {
  const ownerChatId = (await getSetting('owner_telegram_chat_id')).trim();

  const line = preview(input.body, input.hasImage);

  /*
   * Telegram, then email if it did not go.
   *
   * These used to run side by side with email switched off whenever a chat was
   * bound - so a Telegram outage meant the owner simply never heard that a
   * customer had written, because `sendMessage` reports an API failure by
   * returning false rather than by throwing.
   */
  const viaTelegram =
    ownerChatId && botConfigured()
      ? await (async () => {
          const sent = await sendMessageId(
            ownerChatId,
            [
              `*${esc(`Message on ${input.ref}`)}*`,
              '',
              esc(`${input.name}: ${line}`),
              '',
              esc('Reply to this message to answer them.'),
              '',
              mdLink('Or open the thread', `${input.origin}/admin/orders/${input.ref}`),
            ].join('\n'),
          );

          /*
           * Remembered so the owner can simply reply to it.
           *
           * Telegram puts `reply_to_message.message_id` on the reply, so this
           * row is what turns "they answered something" into "they answered
           * this order" - exactly, rather than by guessing at the most recent
           * one and risking the shop's words landing in a stranger's thread.
           */
          if (sent !== null) {
            await env.DB.prepare(
              'INSERT OR REPLACE INTO owner_notices (message_id, order_id) VALUES (?, ?)',
            )
              .bind(sent, input.orderId)
              .run()
              .catch(() => {
                /* the notification went; being unable to remember it only
                   costs the reply-to shortcut, not the message */
              });
          }
          return sent !== null;
        })()
      : false;

  const results = await Promise.allSettled([
    // The owner's own inbox, whenever the bot could not be used or would not
    // take it. An owner who does not hear is the failure that matters here.
    viaTelegram
      ? Promise.resolve(true)
      : deliver({
          to: ownerAddress(),
          subject: `Message on ${input.ref} - ${input.name}`,
          html: shell(
            `Message on ${input.ref}`,
            input.name,
            `<p style="margin:0;font-size:15px;line-height:1.6">${escapeHtml(line)}</p>` +
              button(`${input.origin}/admin/orders/${input.ref}`, 'Open the thread'),
          ),
          text: `${input.name} on ${input.ref}: ${line}\n\n${input.origin}/admin/orders/${input.ref}`,
        }),
  ]);
  const reached =
    viaTelegram || results.some((r) => r.status === 'fulfilled' && r.value === true);
  for (const r of results) {
    if (r.status === 'rejected') console.error('[notify] message-to-owner failed', r.reason);
  }
  // Surfaced rather than swallowed: `notifyNewMessage` records it against
  // `settings.last_notify_error`, which is what the dashboard reads.
  if (!reached) throw new Error(`no channel reached the owner about ${input.ref}`);
}

/**
 * The customer hears about an owner reply - Telegram if they connected,
 * email otherwise.
 *
 * The email is a doorbell, not the message: sender, one line, and a link back
 * to the thread. Enough to judge urgency, not enough to answer by replying to
 * an address nobody reads.
 */
async function tellCustomer(input: {
  orderId: number;
  ref: string;
  name: string;
  email: string;
  telegramChatId?: string | null;
  body: string | null;
  hasImage: boolean;
  origin: string;
}): Promise<void> {
  const due = await notificationDue(input.orderId);
  if (!due) return;

  const line = preview(input.body, input.hasImage);
  const link = `${input.origin}/order?ref=${input.ref}&t=${await tokenFor(input.orderId)}`;

  /*
   * Telegram first if they connected, email if they did not - and email anyway
   * if Telegram would not take it.
   *
   * `sendMessage` returns false for an API failure rather than throwing, and
   * that false used to be discarded: the customer heard nothing, the debounce
   * marker was stamped anyway so nothing would try again for half an hour, and
   * the health line on the dashboard was cleared as though all was well.
   */
  let delivered = false;

  if (input.telegramChatId && botConfigured()) {
    delivered = await sendMessage(
      input.telegramChatId,
      [
        `*${esc(`A reply about ${input.ref}`)}*`,
        '',
        esc(line),
        '',
        mdLink('Open your order', link),
      ].join('\n'),
    );
  }

  if (!delivered) {
    // Either they are not on Telegram, or Telegram would not take it. Both end
    // up here, because an undelivered message is worse than a duplicate one.
    delivered = await deliver({
      to: input.email,
      subject: `A reply about your order ${input.ref}`,
      html: shell(
        'The shop has replied',
        `About order ${input.ref}`,
        `<p style="margin:0 0 4px;font-size:13px;color:#8b93a1">${escapeHtml(SITE.name)} said</p>` +
          `<p style="margin:0;font-size:15px;line-height:1.6">${escapeHtml(line)}</p>` +
          button(link, 'Read it and reply') +
          noReply(link),
      ),
      text: `${SITE.name} said: ${line}\n\nRead it and reply: ${link}` + noReplyText(link),
    });
  }

  /*
   * Only once something actually went. Stamping this on a failed send is what
   * turned one dropped notification into thirty minutes of silence.
   */
  if (!delivered) throw new Error(`no channel accepted the message notice for ${input.ref}`);

  await env.DB.prepare('UPDATE orders SET message_notified_at = unixepoch() WHERE id = ?')
    .bind(input.orderId)
    .run();
}

/**
 * Whether this customer is due a nudge.
 *
 * Due when they have read everything so far - an unread count of zero means the
 * last notification was acted on - or when half an hour has gone by regardless.
 */
async function notificationDue(orderId: number): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(unread_for_customer, 0) AS unread, message_notified_at
       FROM orders WHERE id = ?`,
  )
    .bind(orderId)
    .first<{ unread: number; message_notified_at: number | null }>();
  if (!row) return false;

  // The message just written is itself unread, so "they have read everything
  // else" is a count of one, not zero.
  if (row.unread <= 1) return true;
  if (!row.message_notified_at) return true;
  return Math.floor(Date.now() / 1000) - row.message_notified_at >= NOTIFY_EVERY;
}

/** The customer's own link, which only the server may assemble. */
async function tokenFor(orderId: number): Promise<string> {
  const row = await env.DB.prepare('SELECT access_token FROM orders WHERE id = ?')
    .bind(orderId)
    .first<{ access_token: string }>();
  return row?.access_token ?? '';
}

// ---------------------------------------------------------------------------
// 4. A book somebody was waiting for has come back
// ---------------------------------------------------------------------------

/**
 * Tells everybody waiting on a title that it is back, once.
 *
 * Called after stock has settled rather than as it rises: a delivery raises
 * stock and *then* hands copies to the people who reserved them, so checking
 * mid-way would announce copies that are already spoken for.
 *
 * `claimWaiting` deletes the rows as it reads them, so two admin actions at the
 * same moment cannot send the same person the same message twice - and the
 * address is not kept once it has been used, which is why there is nothing to
 * unsubscribe from.
 */
export async function notifyBackInStock(bookId: number, origin: string): Promise<number> {
  const waiting = await claimWaiting(bookId);
  if (!waiting.length) return 0;

  const results = await Promise.allSettled(
    waiting.map((w) => {
      const link = `${origin}/book/${w.slug}`;
      return deliver({
        to: w.email,
        subject: BACK_IN_STOCK.subject(w.title),
        html: shell(
          BACK_IN_STOCK.heading,
          w.title,
          `<p style="margin:0;font-size:15px;line-height:1.6">You asked us to tell you when
             <strong>${escapeHtml(w.title)}</strong> came back. It is on the shelf now.</p>` +
            button(link, 'See it in the shop') +
            `<p style="margin:20px 0 0;font-size:13.5px;color:#8b93a1;line-height:1.6">
               Stock is limited and we have not held a copy for you - it is first come.
               This is the only message you will get about it; we do not keep your address
               once it has been used.</p>`,
        ),
        text:
          `${w.title} is back in stock.\n\n${link}\n\n` +
          'We have not held a copy - it is first come. This is the only message you will ' +
          'get about it, and we do not keep your address once it has been used.\n',
      });
    }),
  );

  for (const r of results) {
    if (r.status === 'rejected') console.error('[notify] back-in-stock failed', r.reason);
  }
  return waiting.length;
}
