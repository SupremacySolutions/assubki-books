import { env } from 'cloudflare:workers';

/**
 * Small key/value store for things the owner changes without a deploy -
 * bank details, collection address, who to message. These are content, not
 * configuration, so they live in the database rather than in secrets.
 */

/**
 * The payment drafts the owner can keep ready, and the order they appear in.
 *
 * One draft per journey was not enough: a large order goes to a different
 * account, a regular customer has a different arrangement, and the owner was
 * rewriting the box by hand every time. Several, each with a label they choose,
 * picked at the moment of confirming.
 *
 * This array is the only place the set is written down - the setting keys, the
 * type union, the Settings form and the picker on the order all derive from it,
 * so a fourth slot is a line here and a line of migration.
 *
 * There is deliberately no special draft for cash on collection. One used to
 * be applied automatically, which meant a slot the owner had to maintain for a
 * case the picker already covers - ticking "paying in cash" now asks them which
 * of their own wordings to send.
 */
export const PAYMENT_DRAFTS = [
  { slot: 'delivery_1', fulfilment: 'delivery', label: 'Bank transfer' },
  { slot: 'delivery_2', fulfilment: 'delivery', label: 'Second account' },
  { slot: 'delivery_3', fulfilment: 'delivery', label: 'Other' },
  { slot: 'collection_1', fulfilment: 'collection', label: 'Paying in advance' },
  { slot: 'collection_2', fulfilment: 'collection', label: 'Paying on the day' },
] as const;

export type DraftSlot = (typeof PAYMENT_DRAFTS)[number]['slot'];

export const draftBodyKey = (slot: DraftSlot) => `payment_draft_${slot}` as const;
export const draftLabelKey = (slot: DraftSlot) => `payment_draft_${slot}_label` as const;

export type SettingKey =
  // Derived from the array above rather than typed out beside it, so the list
  // and the union cannot drift apart.
  | `payment_draft_${DraftSlot}`
  | `payment_draft_${DraftSlot}_label`
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

export interface PaymentDraft {
  slot: DraftSlot;
  /** The owner's own name for it, shown on the picker. */
  label: string;
  body: string;
}

/**
 * The drafts on offer for this kind of order.
 *
 * Slots with nothing written in them are left out: an empty draft is not a
 * choice, it is a slot the owner has not got round to using.
 */
export async function paymentDrafts(fulfilment: string): Promise<PaymentDraft[]> {
  const wanted = fulfilment === 'collection' ? 'collection' : 'delivery';
  const all = await getSettings();

  return PAYMENT_DRAFTS.filter((d) => d.fulfilment === wanted)
    .map((d) => ({
      slot: d.slot,
      label: (all[draftLabelKey(d.slot)] ?? '').trim() || d.label,
      body: (all[draftBodyKey(d.slot)] ?? '').trim(),
    }))
    .filter((d) => d.body !== '');
}

/** The one the box opens on: the first the owner has filled in. */
export async function defaultDraft(fulfilment: string): Promise<string> {
  const drafts = await paymentDrafts(fulfilment);
  return drafts[0]?.body ?? '';
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
