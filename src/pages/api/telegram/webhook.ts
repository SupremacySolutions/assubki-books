import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import {
  sendMessage,
  esc,
  isOwnerLinkPayload,
  webhookSecret,
  copyToOwner,
} from '../../../lib/telegram';
import { getSetting, setSetting } from '../../../lib/settings';
import { price } from '../../../lib/format';

export const prerender = false;

/**
 * Receives updates from Telegram.
 *
 * Two jobs.
 *
 * The first is the `/start <ref>_<token>` deep link. A bot cannot open a
 * conversation, so this is the moment permission is granted: the customer taps
 * the link, Telegram sends us their chat id, and we bind it to their order. The
 * payload carries an order token precisely so that tapping a link cannot bind
 * someone to an order that is not theirs.
 *
 * The second is payment screenshots. One of the shop's accounts cannot be
 * checked directly, so proof of payment arrives as a photo - which the bot used
 * to ignore entirely, replying with a canned brush-off while the owner never
 * saw it.
 *
 * Everything else gets one reply pointing at a human. The bot is not a
 * conversation, and an unbound chat can do nothing here at all: that allowlist
 * is what makes accepting photos safe, since otherwise anyone who found the bot
 * could pipe images into the owner's Telegram.
 */

/** Enough screenshots to cover a genuine mistake, not enough to flood. */
const MAX_SCREENSHOTS = 5;

interface BoundOrder {
  id: number;
  ref: string;
  customer_name: string;
  status: string;
  total_pence: number | null;
  subtotal_pence: number;
  payment_proofs: number;
}

/** How the bot tells someone it cannot help them. */
async function pointAtAHuman(chatId: string): Promise<void> {
  const contact = (await getSetting('contact_telegram')).trim();
  await sendMessage(
    chatId,
    contact
      ? esc(`This bot only handles orders. For anything else, message ${contact}.`)
      : esc('This bot only handles orders. The shop will be in touch about yours.'),
  );
}

export const POST: APIRoute = async ({ request }) => {
  // Telegram echoes the secret set with setWebhook. Without checking it, anyone
  // who learns the URL could bind their own chat to another person's order.
  const secret = webhookSecret();
  if (secret && request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== secret) {
    return new Response('Forbidden', { status: 403 });
  }

  let update: {
    message?: {
      message_id?: number;
      chat?: { id: number };
      text?: string;
      caption?: string;
      photo?: unknown[];
      document?: { mime_type?: string };
    };
  };
  try {
    update = await request.json();
  } catch {
    return new Response('ok'); // never make Telegram retry a malformed update
  }

  const message = update.message;
  const chatId = message?.chat?.id;
  if (!chatId) return new Response('ok');

  const chat = String(chatId);
  const text = (message?.text ?? '').trim();
  const start = /^\/start(?:\s+(.+))?$/.exec(text);
  const payload = start?.[1]?.trim();

  // ---------------------------------------------------------------------
  // Binding
  // ---------------------------------------------------------------------

  if (start && payload && (await isOwnerLinkPayload(payload))) {
    await setSetting('owner_telegram_chat_id', chat);
    await sendMessage(
      chat,
      esc('Connected. New orders and payment screenshots will be sent here.'),
    );
    return new Response('ok');
  }

  if (start && payload) {
    // "ASB-4F7K_0123456789abcdef"
    const match = /^(ASB-[A-Z0-9]{4})_([a-f0-9]{8,32})$/i.exec(payload);
    if (!match) {
      await sendMessage(chat, esc('That link was not recognised.'));
      return new Response('ok');
    }

    const [, ref, tokenPrefix] = match;
    const order = await env.DB.prepare(
      'SELECT id, ref, access_token, customer_name FROM orders WHERE ref = ?',
    )
      .bind(ref.toUpperCase())
      .first<{ id: number; ref: string; access_token: string; customer_name: string }>();

    // The prefix must match the real token - a guessed reference alone is not
    // enough to attach a chat to an order.
    if (!order || !order.access_token.startsWith(tokenPrefix.toLowerCase())) {
      await sendMessage(chat, esc('That order could not be found.'));
      return new Response('ok');
    }

    await env.DB.prepare(
      'UPDATE orders SET telegram_chat_id = ?, telegram_linked_at = unixepoch() WHERE id = ?',
    )
      .bind(chat, order.id)
      .run();

    const name = order.customer_name.split(' ')[0];
    await sendMessage(
      chat,
      [
        esc(`Assalamu alaikum ${name}.`),
        '',
        esc(`This chat is now connected to order ${order.ref}.`),
        esc('We will send your total and how to pay here as soon as the shop confirms it.'),
        esc('Once you have paid you can send a screenshot here and it will reach the shop.'),
      ].join('\n'),
    );
    return new Response('ok');
  }

  if (start) {
    await sendMessage(
      chat,
      esc(
        'Assalamu alaikum. Open the link in your order confirmation and I will connect this chat to your order.',
      ),
    );
    return new Response('ok');
  }

  // ---------------------------------------------------------------------
  // Everything after this needs a chat the shop already knows
  // ---------------------------------------------------------------------

  const bound = await env.DB.prepare(
    `SELECT id, ref, customer_name, status, total_pence, subtotal_pence,
            COALESCE(payment_proofs, 0) AS payment_proofs
       FROM orders
      WHERE telegram_chat_id = ?
        AND status IN ('requested', 'awaiting_payment', 'paid', 'dispatched')
      ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(chat)
    .first<BoundOrder>();

  const ownerChat = (await getSetting('owner_telegram_chat_id')).trim();
  const isOwner = ownerChat !== '' && ownerChat === chat;

  const hasImage =
    Array.isArray(message?.photo) && message.photo.length > 0
      ? true
      : Boolean(message?.document?.mime_type?.startsWith('image/'));

  if (hasImage && bound && message?.message_id) {
    if (!ownerChat) {
      await sendMessage(
        chat,
        esc('Thank you. Please send this to the shop directly - we cannot pass it on just yet.'),
      );
      return new Response('ok');
    }

    if (bound.payment_proofs >= MAX_SCREENSHOTS) {
      await sendMessage(
        chat,
        esc('We already have your screenshots for this order. The shop will be in touch.'),
      );
      return new Response('ok');
    }

    const due = bound.total_pence ?? bound.subtotal_pence;
    const note = (message.caption ?? '').trim().slice(0, 200);

    const passed = await copyToOwner(
      ownerChat,
      chat,
      message.message_id,
      [
        `*${esc(`Payment screenshot - ${bound.ref}`)}*`,
        esc(`${bound.customer_name}, ${price(due)} due`),
        note ? esc(`They said: ${note}`) : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );

    if (passed) {
      await env.DB.prepare(
        'UPDATE orders SET payment_proofs = COALESCE(payment_proofs, 0) + 1 WHERE id = ?',
      )
        .bind(bound.id)
        .run();
      await sendMessage(
        chat,
        esc(`Thank you. That has reached the shop and will be checked against ${bound.ref}.`),
      );
    } else {
      await sendMessage(
        chat,
        esc('Sorry, that did not get through. Please try sending it again shortly.'),
      );
    }
    return new Response('ok');
  }

  // A photo from someone with no live order, or any other message at all.
  if (isOwner) return new Response('ok'); // the owner talking to their own bot
  await pointAtAHuman(chat);
  return new Response('ok');
};

/** Convenience for setting the webhook up; harmless to leave in place. */
export const GET: APIRoute = async () =>
  Response.json({
    ok: true,
    hint: 'Register with: https://api.telegram.org/bot<TOKEN>/setWebhook?url=<origin>/api/telegram/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>',
  });
