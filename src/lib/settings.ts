import { env } from 'cloudflare:workers';

/**
 * Small key/value store for things the owner changes without a deploy -
 * bank details, collection address, who to message. These are content, not
 * configuration, so they live in the database rather than in secrets.
 */

export type SettingKey =
  // Two drafts, not one: a posted order needs bank details and a collection
  // needs a place and a time, and the owner was rewriting the same box by hand
  // for whichever this order happened to be.
  | 'payment_draft_delivery'
  | 'payment_draft_collection'
  | 'collection_address'
  // Bound by the owner tapping the deep link on the settings page - the bot
  // cannot start a conversation, so this is the only way to obtain it.
  | 'owner_telegram_chat_id'
  // Who the shop is reached at: the handle the bot points people to, and the
  // one behind every "Message us on Telegram" link on the site.
  | 'contact_telegram';

export async function getSetting(key: SettingKey, fallback = ''): Promise<string> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? fallback;
}

export async function getSettings(): Promise<Record<string, string>> {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all<{
    key: string;
    value: string;
  }>();
  return Object.fromEntries(results.map((r) => [r.key, r.value]));
}

export async function setSetting(key: SettingKey, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()`,
  )
    .bind(key, value)
    .run();
}

/**
 * What a cash collection is told instead of a payment draft.
 *
 * Not a setting: there are no details to give - no account, no reference to
 * quote - so there would be nothing for the owner to maintain. They can still
 * edit it on the order before it goes.
 */
export const CASH_COLLECTION_DRAFT =
  'No payment is needed now. Your books are set aside - message us to agree a time, and you can pay in cash when you collect.';

/** The starting text for confirming this order, before the owner edits it. */
export async function paymentDraft(fulfilment: string, cashPayment = false): Promise<string> {
  const collecting = fulfilment === 'collection';
  if (collecting && cashPayment) return CASH_COLLECTION_DRAFT;
  return getSetting(collecting ? 'payment_draft_collection' : 'payment_draft_delivery');
}

/**
 * The contact handle, cached for a minute.
 *
 * The footer carries this link, so it renders on every page of the site. A
 * settings lookup per page view is a D1 query per page view; the handle changes
 * about once a year.
 */
let contactCache: { at: number; value: string } | null = null;

export async function contactTelegram(): Promise<string> {
  const now = Date.now();
  if (contactCache && now - contactCache.at < 60_000) return contactCache.value;
  const value = (await getSetting('contact_telegram')).trim();
  contactCache = { at: now, value };
  return value;
}

/** Called after a save, so the owner sees their own change immediately. */
export function forgetContactTelegram(): void {
  contactCache = null;
}
