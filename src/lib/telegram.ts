/**
 * Telegram: the channel where new listings are announced, and the only free
 * way to reach a customer with payment details.
 *
 * The constraint that shapes this file: **a bot cannot open a conversation.**
 * Telegram only lets a bot message someone who has messaged it first. So the
 * customer taps a `t.me/<bot>?start=<payload>` deep link, the webhook records
 * their chat id against the order, and only then can we DM them. Email is the
 * fallback for anyone who never taps it.
 */

import { env } from 'cloudflare:workers';

interface TelegramEnv {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_BOT_USERNAME?: string;
  TELEGRAM_CHANNEL_ID?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  /** Set to "1" in .dev.vars - see dryRun() below. */
  TELEGRAM_DRY_RUN?: string;
}

const cfg = () => env as unknown as TelegramEnv;

export function botConfigured(): boolean {
  return Boolean(cfg().TELEGRAM_BOT_TOKEN);
}

export function botUsername(): string | null {
  return cfg().TELEGRAM_BOT_USERNAME ?? null;
}

/** The deep link a customer taps to let the bot message them about an order. */
export function optInLink(ref: string, token: string): string | null {
  const user = cfg().TELEGRAM_BOT_USERNAME;
  if (!user) return null;
  // Telegram's start payload allows only A-Z a-z 0-9 _ and -, max 64 chars.
  // The ref already fits; the token is trimmed to keep well inside the limit
  // while staying long enough that it cannot be guessed.
  return `https://t.me/${user}?start=${ref}_${token.slice(0, 16)}`;
}

/**
 * Local development shares the production bot token and channel id, because
 * that is the only way to exercise the real flow. That means an ordinary local
 * test can post to the shop's live channel - which has happened. Setting
 * TELEGRAM_DRY_RUN=1 in .dev.vars makes every write a log line instead.
 */
function dryRun(): boolean {
  return cfg().TELEGRAM_DRY_RUN === '1';
}

async function call<T = unknown>(
  method: string,
  body: unknown,
  onError?: (description: string) => void,
): Promise<T | null> {
  const token = cfg().TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log(`[telegram] ${method} skipped - no bot token`);
    return null;
  }

  if (dryRun()) {
    console.log(`[telegram] DRY RUN - would have called ${method}:`, JSON.stringify(body).slice(0, 300));
    // Deliberately not 0: callers test the returned id for truthiness, so a
    // zero would read as a failed post and the success path would never run.
    return { message_id: 999_999 } as T;
  }

  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!data.ok) {
    const description = data.description ?? 'Unknown Telegram error';
    onError?.(description);
    console.error(`[telegram] ${method} failed:`, description);
    return null;
  }
  return data.result ?? null;
}

/** Telegram's MarkdownV2 escaping. Missing one of these rejects the message. */
export function esc(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => `\\${c}`);
}

export async function sendMessage(chatId: string, text: string): Promise<boolean> {
  const result = await call('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'MarkdownV2',
    disable_web_page_preview: true,
  });
  return result !== null;
}

export interface ListingPost {
  title: string;
  titleAr?: string | null;
  pricePence: number;
  blurb?: string | null;
  available: number;
  url: string;
  imageUrl?: string | null;
}

/** The caption shown under a listing in the channel. */
export function listingCaption(post: ListingPost): string {
  const price = `£${(post.pricePence / 100).toFixed(2)}`;
  const lines = [`*${esc(post.title)}*`];
  if (post.titleAr) lines.push(esc(post.titleAr));
  lines.push('');
  if (post.blurb) lines.push(esc(post.blurb), '');
  lines.push(`*${esc(price)}*`);
  lines.push(post.available > 0 ? esc(`${post.available} available`) : esc('out of stock'));
  lines.push('', esc('Order here:'), esc(post.url));
  return lines.join('\n');
}

/**
 * Announces a listing in the channel, returning the message id so a later edit
 * updates this post rather than announcing the same book twice.
 */
export async function postListing(post: ListingPost): Promise<number | null> {
  const channel = cfg().TELEGRAM_CHANNEL_ID;
  if (!channel) {
    console.log('[telegram] channel post skipped - no channel id');
    return null;
  }

  const caption = listingCaption(post);

  if (post.imageUrl) {
    const result = await call<{ message_id: number }>('sendPhoto', {
      chat_id: channel,
      photo: post.imageUrl,
      caption,
      parse_mode: 'MarkdownV2',
    });
    if (result) return result.message_id;
    // A photo Telegram cannot fetch should not cost the announcement.
    console.warn('[telegram] sendPhoto failed, falling back to a text post');
  }

  const result = await call<{ message_id: number }>('sendMessage', {
    chat_id: channel,
    text: caption,
    parse_mode: 'MarkdownV2',
    disable_web_page_preview: false,
  });
  return result?.message_id ?? null;
}

/** Updates an existing channel post after the owner edits a listing. */
export async function editListing(messageId: number, post: ListingPost): Promise<boolean> {
  const channel = cfg().TELEGRAM_CHANNEL_ID;
  if (!channel) return false;

  const caption = listingCaption(post);
  let notModified = false;
  const recordError = (description: string) => {
    if (description.includes('message is not modified')) notModified = true;
  };

  // A post made with a photo has a caption; a text post has text. Editing the
  // wrong one is an error, so try the caption first and fall back.
  const asCaption = await call('editMessageCaption', {
    chat_id: channel,
    message_id: messageId,
    caption,
    parse_mode: 'MarkdownV2',
  }, recordError);
  if (asCaption !== null) return true;

  const asText = await call('editMessageText', {
    chat_id: channel,
    message_id: messageId,
    text: caption,
    parse_mode: 'MarkdownV2',
  }, recordError);
  return asText !== null || notModified;
}

/**
 * Removes a channel post. Used when a listing is deleted - otherwise the
 * channel keeps advertising a book, and the link goes to a dead page.
 *
 * Telegram only allows a bot to delete its own messages, and only within 48
 * hours of posting. An older post has to be removed by hand, so this reports
 * whether it succeeded rather than pretending.
 */
export async function deleteChannelMessage(messageId: number): Promise<boolean> {
  const channel = cfg().TELEGRAM_CHANNEL_ID;
  if (!channel) return false;
  const result = await call('deleteMessage', { chat_id: channel, message_id: messageId });
  return result !== null;
}

export function webhookSecret(): string | null {
  return cfg().TELEGRAM_WEBHOOK_SECRET ?? null;
}
