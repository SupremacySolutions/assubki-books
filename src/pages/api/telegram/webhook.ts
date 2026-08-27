import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { sendMessage, esc, webhookSecret } from '../../../lib/telegram';

export const prerender = false;

/**
 * Receives updates from Telegram.
 *
 * Its one real job is the `/start <ref>_<token>` deep link. A bot cannot open a
 * conversation with a customer, so this is the moment permission is granted:
 * the customer taps the link, Telegram sends us their chat id, and we bind it
 * to their order. From then on payment details can go by DM.
 *
 * The payload carries an order token precisely so that tapping a link cannot
 * bind someone to an order that is not theirs.
 */
export const POST: APIRoute = async ({ request }) => {
  // Telegram echoes the secret set with setWebhook. Without checking it, anyone
  // who learns the URL could bind their own chat to another person's order.
  const secret = webhookSecret();
  if (secret && request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== secret) {
    return new Response('Forbidden', { status: 403 });
  }

  let update: {
    message?: { chat?: { id: number }; text?: string; from?: { first_name?: string } };
  };
  try {
    update = await request.json();
  } catch {
    return new Response('ok'); // never make Telegram retry a malformed update
  }

  const chatId = update.message?.chat?.id;
  const text = update.message?.text?.trim() ?? '';
  if (!chatId) return new Response('ok');

  const start = /^\/start(?:\s+(.+))?$/.exec(text);
  if (!start) {
    await sendMessage(
      String(chatId),
      esc('Send the link from your order confirmation and I can send you your payment details here.'),
    );
    return new Response('ok');
  }

  const payload = start[1]?.trim();
  if (!payload) {
    await sendMessage(
      String(chatId),
      `${esc('Assalamu alaikum. Open the link in your order confirmation and I will connect this chat to your order.')}`,
    );
    return new Response('ok');
  }

  // "ASB-4F7K_0123456789abcdef"
  const match = /^(ASB-[A-Z0-9]{4})_([a-f0-9]{8,32})$/i.exec(payload);
  if (!match) {
    await sendMessage(String(chatId), esc('That link was not recognised.'));
    return new Response('ok');
  }

  const [, ref, tokenPrefix] = match;

  const order = await env.DB.prepare(
    'SELECT id, ref, access_token, customer_name, status FROM orders WHERE ref = ?',
  )
    .bind(ref.toUpperCase())
    .first<{ id: number; ref: string; access_token: string; customer_name: string; status: string }>();

  // The prefix must match the real token — a guessed reference alone is not
  // enough to attach a chat to an order.
  if (!order || !order.access_token.startsWith(tokenPrefix.toLowerCase())) {
    await sendMessage(String(chatId), esc('That order could not be found.'));
    return new Response('ok');
  }

  await env.DB.prepare(
    'UPDATE orders SET telegram_chat_id = ?, telegram_linked_at = unixepoch() WHERE id = ?',
  )
    .bind(String(chatId), order.id)
    .run();

  const name = order.customer_name.split(' ')[0];
  await sendMessage(
    String(chatId),
    [
      `${esc(`Assalamu alaikum ${name}.`)}`,
      '',
      esc(`This chat is now connected to order ${order.ref}.`),
      esc('We will send your total and how to pay here as soon as the shop confirms it.'),
    ].join('\n'),
  );

  return new Response('ok');
};

/** Convenience for setting the webhook up; harmless to leave in place. */
export const GET: APIRoute = async () =>
  Response.json({
    ok: true,
    hint: 'Register with: https://api.telegram.org/bot<TOKEN>/setWebhook?url=<origin>/api/telegram/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>',
  });
