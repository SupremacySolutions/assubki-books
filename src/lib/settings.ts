import { env } from 'cloudflare:workers';

/**
 * Small key/value store for things the owner changes without a deploy -
 * bank details, collection address, who to message. These are content, not
 * configuration, so they live in the database rather than in secrets.
 */

/**
 * The parts a confirmation message is built from.
 *
 * Not whole messages keyed by journey, which is what these were: the three
 * "delivery" boxes turned out to be **bank accounts** and the two "collection"
 * boxes **collection addresses**, and either kind of order might be paid by
 * transfer or in cash. So a collection paid by transfer needs an address *and*
 * an account, while a posted order paid in cash needs neither - a shape no
 * single list can hold without a box for every combination.
 *
 * Two groups, then, plus one line for cash. The message is assembled from
 * whichever apply and stays editable on the order.
 */
export const PAYMENT_ACCOUNTS = [
  { slot: 'account_1', label: 'Main account' },
  { slot: 'account_2', label: 'Second account' },
  { slot: 'account_3', label: 'Third account' },
  { slot: 'account_4', label: 'Fourth account' },
  { slot: 'account_5', label: 'Fifth account' },
] as const;

export const COLLECTION_PLACES = [
  { slot: 'place_1', label: 'Main address' },
  { slot: 'place_2', label: 'Second address' },
] as const;

/**
 * One wording for cash, shared by both journeys - not one per journey. Where
 * the money changes hands differs, and that phrase comes from
 * `cashMoment()` in lib/order-status rather than from a second box here.
 */
export const CASH_SLOT = 'cash' as const;

export type AccountSlot = (typeof PAYMENT_ACCOUNTS)[number]['slot'];
export type PlaceSlot = (typeof COLLECTION_PLACES)[number]['slot'];
export type PartSlot = AccountSlot | PlaceSlot | typeof CASH_SLOT;

export const partBodyKey = (slot: PartSlot) => `payment_part_${slot}` as const;
export const partLabelKey = (slot: PartSlot) => `payment_part_${slot}_label` as const;

export type SettingKey =
  // Derived from the lists above rather than typed out beside them, so the
  // lists and the union cannot drift apart.
  | `payment_part_${PartSlot}`
  | `payment_part_${PartSlot}_label`
  // Bound by the owner tapping the deep link on the settings page - the bot
  // cannot start a conversation, so this is the only way to obtain it.
  | 'owner_telegram_chat_id'
  // Who that chat belongs to, captured at bind time. A numeric chat id tells
  // nobody anything, so the settings page said only "Connected" and a binding
  // to the wrong person was invisible.
  | 'owner_telegram_label'
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

export interface MessagePart {
  slot: PartSlot;
  /** The owner's own name for it, shown on the picker. */
  label: string;
  body: string;
}

const parts = async (
  defs: readonly { slot: PartSlot; label: string }[],
): Promise<MessagePart[]> => {
  const all = await getSettings();
  return defs
    .map((d) => ({
      slot: d.slot,
      label: (all[partLabelKey(d.slot)] ?? '').trim() || d.label,
      body: (all[partBodyKey(d.slot)] ?? '').trim(),
    }))
    .filter((d) => d.body !== '');
};

/**
 * How the customer pays: the accounts, and cash.
 *
 * Cash is offered last and on every journey, because whether it applies is the
 * owner's decision on the order rather than a property of how the books travel.
 * Empty boxes are left out - an unwritten draft is not a choice.
 */
export async function paymentOptions(): Promise<MessagePart[]> {
  const [accounts, cash] = await Promise.all([
    parts(PAYMENT_ACCOUNTS),
    parts([{ slot: CASH_SLOT, label: 'Cash' }]),
  ]);
  return [...accounts, ...cash];
}

/** Where they collect. Only ever offered on a collection. */
export async function collectionPlaces(): Promise<MessagePart[]> {
  return parts(COLLECTION_PLACES);
}

/**
 * The address a collecting customer is told to come to.
 *
 * There used to be a separate `collection_address` setting for this, written
 * in its own box, while the message the owner actually sends was built from
 * the collection place drafts - two places saying where to collect, which
 * could disagree and did not have to be kept in step. The box is gone and this
 * reads the first written draft, so there is one source of it.
 */
export async function collectionAddress(): Promise<string> {
  const places = await collectionPlaces();
  return places[0]?.body ?? '';
}

/**
 * The message, built from the parts that apply.
 *
 * Where before how to pay, because that is the order the customer needs them
 * in: they want to know where they are going before what to bring.
 */
export function composeMessage(chosen: { place?: string | null; payment?: string | null }): string {
  return [chosen.place, chosen.payment]
    .map((part) => (part ?? '').trim())
    .filter(Boolean)
    .join('\n\n');
}

/** What the box opens on before the owner touches it. */
export async function defaultMessage(fulfilment: string, cashPayment = false): Promise<string> {
  const [options, places] = await Promise.all([
    paymentOptions(),
    fulfilment === 'collection' ? collectionPlaces() : Promise.resolve([]),
  ]);

  // A cash order must never open with bank details in the box - that is the
  // contradiction this whole feature exists to prevent.
  const payment = cashPayment
    ? options.find((o) => o.slot === CASH_SLOT)
    : options.find((o) => o.slot !== CASH_SLOT);

  return composeMessage({ place: places[0]?.body, payment: payment?.body });
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
