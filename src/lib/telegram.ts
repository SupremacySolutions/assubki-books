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
import { contactTelegram } from './settings';
import { SITE } from './format';

interface TelegramEnv {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_BOT_USERNAME?: string;
  ADMIN_SESSION_SECRET?: string;
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

/**
 * Who a customer messages, as a handle and as a link.
 *
 * Three different Telegram identities exist here and they are easily confused:
 * the *bot* (TELEGRAM_BOT_USERNAME, which only talks about orders), the
 * *channel* (SITE.telegram, where listings are announced), and this - a person
 * who answers. The site used to link the channel from every "message us"
 * prompt, so anyone with a question was sent to a feed they cannot reply to.
 *
 * Falls back to the channel when the setting is blank, because a link that goes
 * somewhere beats a missing one.
 */
export async function contactHandle(): Promise<string> {
  const set = await contactTelegram();
  const raw = set || SITE.telegram;
  const name = raw
    .replace(/^https?:\/\/t\.me\//i, '')
    .replace(/^@/, '')
    .trim();
  return name ? `@${name}` : '';
}

/** The t.me link for {@link contactHandle}, or null if there is nothing to link. */
export async function contactLink(): Promise<string | null> {
  const handle = await contactHandle();
  return handle ? `https://t.me/${handle.slice(1)}` : null;
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
 * The deep link the owner taps once to get order alerts by Telegram.
 *
 * A bot cannot open a conversation, so the owner has to start it - the same
 * constraint customers hit. The payload is derived from ADMIN_SESSION_SECRET
 * rather than being a fixed word, so knowing the bot's name is not enough to
 * bind your own chat and start receiving customers' names and addresses.
 */
const HOUR = 3_600_000;

async function payloadForBucket(bucket: number): Promise<string | null> {
  const secret = cfg().ADMIN_SESSION_SECRET;
  if (!secret) return null;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`owner-telegram-link:${bucket}`),
  );
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `owner_${hex.slice(0, 24)}`;
}

export async function ownerLinkPayload(): Promise<string | null> {
  return payloadForBucket(Math.floor(Date.now() / HOUR));
}

export async function ownerOptInLink(): Promise<string | null> {
  const user = cfg().TELEGRAM_BOT_USERNAME;
  const payload = await ownerLinkPayload();
  return user && payload ? `https://t.me/${user}?start=${payload}` : null;
}

/**
 * Whether this payload is a currently-valid owner link.
 *
 * The payload is bucketed by the hour, so a link is good for an hour or two and
 * then stops working. It used to be derived from a fixed word, which made it
 * permanent: anyone who saw the settings page over a shoulder, or in a
 * screenshot, could bind their own chat at any point afterwards and start
 * receiving customers' names and addresses. The previous bucket is accepted so
 * a link tapped a minute after the hour turns over still works.
 */
export async function isOwnerLinkPayload(payload: string): Promise<boolean> {
  const now = Math.floor(Date.now() / HOUR);
  for (const bucket of [now, now - 1]) {
    const expected = await payloadForBucket(bucket);
    if (expected && payload === expected) return true;
  }
  return false;
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
    /*
     * Shaped like the real answer, because the caller reads it.
     *
     * A media group comes back as one message per photo, and code that has to
     * remember every id would take a single object here as a failed album and
     * quietly fall back to posting one photo - so the dry run would exercise a
     * path the real thing never takes.
     */
    if (method === 'sendMediaGroup') {
      const media = (body as { media?: unknown[] })?.media ?? [];
      return media.map((_, i) => ({ message_id: 999_900 + i })) as T;
    }
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

/**
 * A short clickable word, instead of a raw URL taking over the message.
 *
 * A link used to be sent as plain escaped text, so the message *was* the URL -
 * "Order here:" followed by a line wider than the phone showing it. The label
 * is escaped exactly like any other text; the address inside the parentheses
 * has a much smaller rule of its own - only `\` and `)` need escaping there,
 * and escaping it like text would mangle it.
 */
export function mdLink(label: string, url: string): string {
  const safeUrl = url.replace(/\\/g, '\\\\').replace(/\)/g, '\\)');
  return `[${esc(label)}](${safeUrl})`;
}

/**
 * Sends a message, falling back to plain text if the formatting is rejected.
 *
 * MarkdownV2 reserves a dozen punctuation characters, and one unescaped
 * character rejects the entire message rather than degrading. That is an
 * acceptable way to lose a nicety and a terrible way to lose payment details,
 * so a parse failure re-sends the same content unformatted instead of the
 * customer receiving nothing at all.
 */
export async function sendMessage(chatId: string, text: string): Promise<boolean> {
  return (await sendMessageId(chatId, text)) !== null;
}

/**
 * The same send, handing back the id Telegram gave the message.
 *
 * Worth having because a reply carries `reply_to_message.message_id`: knowing
 * which message the shop sent is what lets the owner answer a customer by
 * replying to the notification, without anybody guessing which order they
 * meant. `sendMessage` keeps its boolean, since almost every caller only wants
 * to know whether it went.
 */
export async function sendMessageId(chatId: string, text: string): Promise<number | null> {
  let parseFailed = false;
  const result = await call<{ message_id?: number }>(
    'sendMessage',
    { chat_id: chatId, text, parse_mode: 'MarkdownV2', disable_web_page_preview: true },
    (description) => {
      if (description.toLowerCase().includes("can't parse entities")) parseFailed = true;
    },
  );
  if (result !== null) return result.message_id ?? null;
  if (!parseFailed) return null;

  console.warn('[telegram] MarkdownV2 rejected, resending as plain text');
  const plain = text.replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, '$1').replace(/\*/g, '');
  const retry = await call<{ message_id?: number }>('sendMessage', {
    chat_id: chatId,
    text: plain,
    disable_web_page_preview: true,
  });
  return retry === null ? null : (retry.message_id ?? null);
}

export interface ListingPost {
  title: string;
  titleAr?: string | null;
  pricePence: number;
  blurb?: string | null;
  available: number;
  url: string;
  imageUrl?: string | null;
  /** Only when it is a set, so the channel says the same as the card. */
  volumes?: number | null;
  /**
   * The post as the owner wrote it, replacing everything below.
   *
   * Sent exactly as typed, with no parse mode. MarkdownV2 would mean hand
   * escaping every full stop, hyphen and bracket - `£3.75` is a syntax error
   * without it - which is not a thing to ask of somebody writing a sentence
   * about a book. Plain text is what he sees and what the channel gets, and
   * Telegram makes a link of a bare URL by itself.
   */
  caption?: string | null;
  /** Every photo on the listing. The first carries the caption. */
  imageUrls?: string[];
}

/**
 * The same post as plain text, which is what the owner edits.
 *
 * Not a rendering of the markdown one - the markdown is what it is so that
 * Telegram will draw a bold title and a worded link, and neither survives
 * being handed to somebody to edit: MarkdownV2 escapes every full stop, so
 * `£3.75` reaches the owner as `£3\.75` and comes back broken. This is the
 * same facts written the way a person would type them, with the URL bare
 * because Telegram links that by itself.
 */
export function plainCaption(post: ListingPost): string {
  const lines = [post.title];
  if (post.titleAr) lines.push(post.titleAr);
  if (post.volumes && post.volumes > 1) lines.push(`${post.volumes} volume set`);
  lines.push('');
  if (post.blurb) lines.push(post.blurb, '');
  lines.push(`£${(post.pricePence / 100).toFixed(2)}`);
  lines.push(post.available > 0 ? `${post.available} available` : 'out of stock');
  lines.push('', post.url);
  return lines.join('\n');
}

/** The caption shown under a listing in the channel. */
export function listingCaption(post: ListingPost): string {
  const price = `£${(post.pricePence / 100).toFixed(2)}`;
  const lines = [`*${esc(post.title)}*`];
  if (post.titleAr) lines.push(esc(post.titleAr));
  if (post.volumes && post.volumes > 1) lines.push(esc(`${post.volumes} volume set`));
  lines.push('');
  if (post.blurb) lines.push(esc(post.blurb), '');
  lines.push(`*${esc(price)}*`);
  lines.push(post.available > 0 ? esc(`${post.available} available`) : esc('out of stock'));
  lines.push('', mdLink('Order here', post.url));
  return lines.join('\n');
}

/**
 * Announces a listing in the channel, returning the message id so a later edit
 * updates this post rather than announcing the same book twice.
 */
/**
 * The most photos Telegram will put in one album.
 *
 * A listing with more than this posts the first ten. Refusing to post at all
 * because a book has eleven photographs would be a worse answer than posting
 * ten of them.
 */
const ALBUM_MAX = 10;

export interface PostedListing {
  /** The message carrying the caption - what an edit has to target. */
  messageId: number;
  /** Every message the post occupies, which is what a delete has to remove. */
  albumIds: number[];
}

/**
 * What to send, and whether Telegram should read markup in it.
 *
 * A caption the owner wrote goes as he wrote it. Only the generated one is
 * MarkdownV2, because only the generated one is escaped for it - handing
 * somebody's typing to a markup parser is how a stray bracket in a book title
 * silently fails the whole post.
 */
function captionFor(post: ListingPost): { text: string; parse?: 'MarkdownV2' } {
  const own = post.caption?.trim();
  return own ? { text: own } : { text: listingCaption(post), parse: 'MarkdownV2' };
}

export async function postListing(post: ListingPost): Promise<PostedListing | null> {
  const channel = cfg().TELEGRAM_CHANNEL_ID;
  if (!channel) {
    console.log('[telegram] channel post skipped - no channel id');
    return null;
  }

  const { text: caption, parse } = captionFor(post);
  const photos = (post.imageUrls?.length ? post.imageUrls : [post.imageUrl])
    .filter((url): url is string => Boolean(url))
    .slice(0, ALBUM_MAX);

  /*
   * Every photo on the listing, as one album.
   *
   * Telegram wants at least two items for a media group and gives back one
   * message per photo. The caption goes on the first only - repeating it on
   * each would show it once per photo when the album is opened.
   */
  if (photos.length > 1) {
    const media = photos.map((url, i) => ({
      type: 'photo',
      media: url,
      ...(i === 0 ? { caption, ...(parse ? { parse_mode: parse } : {}) } : {}),
    }));
    const group = await call<{ message_id: number }[]>('sendMediaGroup', {
      chat_id: channel,
      media,
    });
    if (Array.isArray(group) && group.length) {
      return { messageId: group[0].message_id, albumIds: group.map((m) => m.message_id) };
    }
    // One unfetchable photo fails the whole group, so the cover alone is a
    // better answer than no announcement.
    console.warn('[telegram] sendMediaGroup failed, falling back to a single photo');
  }

  if (photos.length) {
    const result = await call<{ message_id: number }>('sendPhoto', {
      chat_id: channel,
      photo: photos[0],
      caption,
      ...(parse ? { parse_mode: parse } : {}),
    });
    if (result) return { messageId: result.message_id, albumIds: [result.message_id] };
    // A photo Telegram cannot fetch should not cost the announcement.
    console.warn('[telegram] sendPhoto failed, falling back to a text post');
  }

  const result = await call<{ message_id: number }>('sendMessage', {
    chat_id: channel,
    text: caption,
    ...(parse ? { parse_mode: parse } : {}),
    disable_web_page_preview: false,
  });
  return result?.message_id ? { messageId: result.message_id, albumIds: [result.message_id] } : null;
}

/** Updates an existing channel post after the owner edits a listing. */
export async function editListing(messageId: number, post: ListingPost): Promise<boolean> {
  const channel = cfg().TELEGRAM_CHANNEL_ID;
  if (!channel) return false;

  const { text: caption, parse } = captionFor(post);
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
    ...(parse ? { parse_mode: parse } : {}),
  }, recordError);
  if (asCaption !== null) return true;

  const asText = await call('editMessageText', {
    chat_id: channel,
    message_id: messageId,
    text: caption,
    ...(parse ? { parse_mode: parse } : {}),
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
/**
 * Removes every message a listing occupies in the channel.
 *
 * An album is one message per photo, and Telegram deletes them one at a time.
 * Clearing only the first would leave the rest of the photographs in the
 * channel with no caption and nothing to click - which is worse than leaving
 * the whole post up, because it does not even say what it is.
 *
 * All of them are attempted before reporting, so one message too old to delete
 * does not strand the others behind it.
 */
export async function deleteChannelPost(messageIds: number[]): Promise<boolean> {
  const results = await Promise.all(messageIds.map((id) => deleteChannelMessage(id)));
  return results.every(Boolean);
}

export async function deleteChannelMessage(messageId: number): Promise<boolean> {
  const channel = cfg().TELEGRAM_CHANNEL_ID;
  if (!channel) return false;

  // A post that is already gone counts as gone. Telegram answers "message to
  // delete not found" for one deleted by hand in the channel, and treating
  // that as a failure made the portal warn about an orphaned announcement that
  // does not exist - which is worse than saying nothing, because it sends the
  // owner looking for something they already dealt with.
  let missing = false;
  const result = await call('deleteMessage', { chat_id: channel, message_id: messageId }, (why) => {
    if (/not found/i.test(why)) missing = true;
  });
  return result !== null || missing;
}

/**
 * Passes a customer's message on to the owner.
 *
 * Used for payment screenshots: one of the shop's accounts cannot be checked
 * directly, so proof of payment arrives as a photo. `copyMessage` rather than
 * `forwardMessage` because it lets us replace the caption with the order
 * reference and amount - a screenshot with no idea which order it belongs to
 * is barely better than none.
 */
export async function copyToOwner(
  ownerChatId: string,
  fromChatId: string,
  messageId: number,
  caption: string,
): Promise<boolean> {
  const result = await call('copyMessage', {
    chat_id: ownerChatId,
    from_chat_id: fromChatId,
    message_id: messageId,
    caption,
    parse_mode: 'MarkdownV2',
  });
  return result !== null;
}

/**
 * Downloads a file a customer sent the bot.
 *
 * Two steps, because Telegram does not hand over bytes with the update: the
 * update carries a `file_id`, `getFile` turns that into a path, and the path is
 * fetched from a different host to the API.
 *
 * Used so a payment screenshot sent on Telegram lands in the order's thread
 * like one sent from the site, rather than existing only as a relayed message
 * in the owner's chat and a number in a column.
 *
 * Returns null rather than throwing on every failure: a screenshot that could
 * not be fetched must not cost the customer their message, and the relay to the
 * owner has already happened either way.
 */
export async function fetchFile(
  fileId: string,
  maxBytes: number,
): Promise<{ bytes: ArrayBuffer; contentType: string } | null> {
  const token = cfg().TELEGRAM_BOT_TOKEN;
  if (!token || dryRun()) return null;

  const file = await call<{ file_path?: string; file_size?: number }>('getFile', {
    file_id: fileId,
  });
  if (!file?.file_path) return null;
  if ((file.file_size ?? 0) > maxBytes) return null;

  try {
    const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
    if (!res.ok) return null;

    // `getFile` reports a size, but a lying or absent one must not let an
    // unbounded body through - so the actual bytes are checked too.
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength > maxBytes) return null;

    const contentType = res.headers.get('content-type') ?? '';
    return { bytes, contentType };
  } catch {
    return null;
  }
}

export function webhookSecret(): string | null {
  return cfg().TELEGRAM_WEBHOOK_SECRET ?? null;
}
