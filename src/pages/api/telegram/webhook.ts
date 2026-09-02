import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import {
  sendMessage,
  esc,
  isOwnerLinkPayload,
  webhookSecret,
  copyToOwner,
  fetchFile,
  mdLink,
} from '../../../lib/telegram';
import { getSetting, setSetting } from '../../../lib/settings';
import { price } from '../../../lib/format';
import { notifyNewMessage } from '../../../lib/notify';
import {
  IMAGES_PER_ORDER,
  PROOF_PREFIX,
  imageCount,
  normaliseBody,
  overHourlyCap,
  postMessage,
  threadOpen,
} from '../../../lib/messages';

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
 * The third is the conversation. A message from a bound chat with a live order
 * is now posted into that order's thread rather than thrown away - which is the
 * piece that makes the whole feature cohere. A connected customer types in
 * Telegram, an unconnected one types on the site, both land in one thread, and
 * the owner answers both from one box.
 *
 * **Owner replies from Telegram are deliberately not handled.** Doing it
 * properly needs a map from relayed message ids back to orders, and a half
 * version that guessed at the most recent order would put the shop's words in
 * the wrong customer's thread.
 *
 * Everything else still gets one reply pointing at a human. An unbound chat can
 * do nothing here at all: that allowlist is what makes accepting photos safe,
 * since otherwise anyone who found the bot could pipe images into the owner's
 * Telegram.
 */

/** The same 8 MB the site's own upload accepts. */
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

const EXTENSIONS = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
]);

interface TelegramUpdate {
  message?: {
    message_id?: number;
    chat?: { id: number; username?: string; first_name?: string; last_name?: string };
    text?: string;
    caption?: string;
    photo?: { file_id?: string }[];
    document?: { mime_type?: string; file_id?: string };
  };
}

interface BoundOrder {
  id: number;
  ref: string;
  customer_name: string;
  email: string;
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

  let update: TelegramUpdate;
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

    // Recorded so the settings page can say *whose* chat this is. A username
    // is optional on Telegram, so fall back to the name and accept that the
    // page will then be unable to check it against the contact handle.
    const who = message?.chat?.username
      ? `@${message.chat.username}`
      : [message?.chat?.first_name, message?.chat?.last_name].filter(Boolean).join(' ');
    await setSetting('owner_telegram_label', who.slice(0, 80));

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

    /*
     * No mention of sending a screenshot here. It used to be in this message,
     * which arrives before there is a total, an account, or anything to pay -
     * so it asked for proof of a payment that could not have happened yet. It
     * now travels with the payment details, where it means something.
     *
     * Someone who has ordered before does not need the connection explained
     * again - they set it up months ago. `bound` is any *other* order already
     * on this chat.
     *
     * No full stop after the name. The greeting runs right to left and the
     * name ends it, so a stop lands at the left-hand edge, reading as though
     * it belongs to whatever follows rather than to the greeting.
     */
    const returning = await env.DB.prepare(
      'SELECT 1 FROM orders WHERE telegram_chat_id = ? AND id != ? LIMIT 1',
    )
      .bind(chat, order.id)
      .first();

    await sendMessage(
      chat,
      [
        esc(`السلام عليكم ${name}`),
        '',
        ...(returning
          ? [
              esc(`Welcome back. Order ${order.ref} is connected to this chat.`),
              esc('We will send your total and how to pay here once the shop confirms it.'),
            ]
          : [
              esc(`This chat is now connected to order ${order.ref}.`),
              esc('We will send your total and how to pay here as soon as the shop confirms it.'),
            ]),
      ].join('\n'),
    );
    return new Response('ok');
  }

  if (start) {
    // The greeting gets its own line for the same reason the stop went: it
    // reads right to left, and English on the same line collides with it.
    await sendMessage(
      chat,
      [
        esc('السلام عليكم'),
        '',
        esc('Open the link in your order confirmation and I will connect this chat to your order.'),
      ].join('\n'),
    );
    return new Response('ok');
  }

  // ---------------------------------------------------------------------
  // Everything after this needs a chat the shop already knows
  // ---------------------------------------------------------------------

  /*
   * The most recent live order on this chat, and the id is what settles it.
   *
   * `created_at` is whole seconds, so two orders from one chat placed in the
   * same second left this ordering undefined and SQLite could return either.
   * Which one it returns decides where a payment screenshot is filed, so
   * "undefined" here means somebody's proof of payment landing against the
   * wrong order. Ids are monotonic, which is what "the newest" actually needs.
   */
  const bound = await env.DB.prepare(
    `SELECT id, ref, customer_name, email, status, total_pence, subtotal_pence,
            COALESCE(payment_proofs, 0) AS payment_proofs
       FROM orders
      WHERE telegram_chat_id = ?
        AND status IN ('requested', 'awaiting_payment', 'paid', 'dispatched')
      ORDER BY created_at DESC, id DESC LIMIT 1`,
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

    /*
     * One limit for the order, whichever door the photo came through.
     *
     * This used to count `payment_proofs`, which only this route ever bumps -
     * so a customer who had already sent five from their order page could send
     * five more here, and the two routes disagreed about what "five per order"
     * meant. The thread's own count is the honest one, because both routes
     * write to it.
     */
    if ((await imageCount(bound.id)) >= IMAGES_PER_ORDER) {
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

      /*
       * And into the thread, so the screenshot is part of the conversation
       * rather than only a relayed message in the owner's chat and a number in
       * a column. The customer can then see what they sent on their own order
       * page, and the owner has it beside the books.
       *
       * The relay above has already happened and is what the owner acts on, so
       * every failure here is swallowed: a photo the shop could not re-host
       * must not turn into "sorry, that did not get through" for a message
       * that did.
       */
      await storeTelegramPhoto(bound, message, note).catch(() => {});

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

  /*
   * Words, from someone the shop knows, about an order that is still live.
   *
   * This used to be the brush-off - "This bot only handles orders" - thrown at
   * every text message the bot ever received, including customers answering
   * the shop's own payment instructions. It now goes into that order's thread,
   * marked as having come from Telegram.
   */
  if (text && bound && !isOwner && threadOpen(bound.status)) {
    const body = normaliseBody(text);
    if (!body) {
      await pointAtAHuman(chat);
      return new Response('ok');
    }

    if (await overHourlyCap(bound.id)) {
      await sendMessage(
        chat,
        esc('That is a lot of messages at once. Please give the shop a moment to catch up.'),
      );
      return new Response('ok');
    }

    await postMessage({ orderId: bound.id, sender: 'customer', via: 'telegram', body });
    await notifyNewMessage({
      orderId: bound.id,
      ref: bound.ref,
      sender: 'customer',
      name: bound.customer_name,
      email: bound.email,
      telegramChatId: chat,
      body,
      hasImage: false,
      origin: new URL(request.url).origin,
    });

    /*
     * No "thank you, received" reply. The customer is looking at their own
     * message in a chat window; a bot answering every line with an
     * acknowledgement is noise, and the shop's real answer is what they are
     * waiting for.
     */
    return new Response('ok');
  }

  /*
   * The owner typing back into their own bot chat.
   *
   * They are told here when a customer writes, so replying in the same window
   * is the obvious move - and it does not work: routing a reply back to the
   * right order needs a map from relayed message ids to orders, which is not
   * built, and guessing at "their most recent order" would put the shop's
   * words in the wrong customer's thread.
   *
   * What is *not* acceptable is swallowing it. This used to return silently,
   * so a reply typed here vanished with no reply, no warning and no record,
   * and the customer went on waiting. Saying so costs one message.
   */
  if (isOwner) {
    if (!text) return new Response('ok'); // a photo or a sticker needs no lecture

    const origin = new URL(request.url).origin;

    // A link to the order most recently written to, if there is one - a
    // convenience, not a guess about who this message was meant for.
    const waiting = await env.DB.prepare(
      `SELECT ref FROM orders
        WHERE unread_for_owner > 0 ORDER BY last_message_at DESC, id DESC LIMIT 1`,
    ).first<{ ref: string }>();

    await sendMessage(
      chat,
      [
        esc('That was not sent - replies do not go through this chat.'),
        '',
        esc('Answer from the portal and it reaches them wherever they are.'),
        '',
        waiting
          ? mdLink(`Open ${waiting.ref}`, `${origin}/admin/orders/${waiting.ref}`)
          : mdLink('Open your orders', `${origin}/admin/orders`),
      ].join('\n'),
    );
    return new Response('ok');
  }

  // A photo from someone with no live order, or any other message at all.
  await pointAtAHuman(chat);
  return new Response('ok');
};

/**
 * Re-hosts a Telegram photo under `proofs/` and puts it in the thread.
 *
 * Telegram keeps the file, but only behind a URL built from the bot token -
 * which cannot be handed to a browser, and which the shop should not be relying
 * on for its own record anyway. Stored in R2 like a photo sent from the site,
 * so one sweep removes both and one route reads both.
 */
async function storeTelegramPhoto(
  bound: BoundOrder,
  message: NonNullable<TelegramUpdate['message']>,
  note: string,
): Promise<void> {
  if ((await imageCount(bound.id)) >= IMAGES_PER_ORDER) return;

  // Telegram sends a photo as a ladder of sizes, smallest first; the last is
  // the largest it kept, which is the one a payment reference is legible in.
  const sizes = (message.photo ?? []) as { file_id?: string }[];
  const fileId =
    sizes.length > 0 ? sizes[sizes.length - 1]?.file_id : message.document?.file_id;
  if (!fileId) return;

  const file = await fetchFile(fileId, MAX_PHOTO_BYTES);
  if (!file) return;

  const ext = EXTENSIONS.get(file.contentType.split(';')[0].trim());
  if (!ext) return;

  const bucket = (env as unknown as { UPLOADS?: R2Bucket }).UPLOADS;
  if (!bucket) return;

  const key = `${PROOF_PREFIX}${bound.id}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
  await bucket.put(key, file.bytes, {
    httpMetadata: { contentType: file.contentType, cacheControl: 'private, no-store' },
  });

  // Same rule as the web route: an object with no row pointing at it is one the
  // sweep will never find, so it does not get to stay.
  try {
    await postMessage({
      orderId: bound.id,
      sender: 'customer',
      via: 'telegram',
      body: normaliseBody(note),
      imageKey: key,
    });
  } catch (err) {
    await bucket.delete(key).catch(() => {});
    throw err;
  }
}

/** Convenience for setting the webhook up; harmless to leave in place. */
export const GET: APIRoute = async () =>
  Response.json({
    ok: true,
    hint: 'Register with: https://api.telegram.org/bot<TOKEN>/setWebhook?url=<origin>/api/telegram/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>',
  });
