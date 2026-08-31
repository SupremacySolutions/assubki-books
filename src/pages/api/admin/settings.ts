import type { APIRoute } from 'astro';
import { forgetMaintenance } from '../../../lib/maintenance';
import {
  setSetting,
  getSetting,
  forgetContactTelegram,
  PAYMENT_ACCOUNTS,
  COLLECTION_PLACES,
  CASH_SLOT,
  partBodyKey,
  partLabelKey,
} from '../../../lib/settings';

export const prerender = false;

/**
 * Text fields are written even when blank, so clearing one actually clears it.
 * Guarding on truthiness meant emptying the payment instructions silently kept
 * the previous bank details.
 */
const text = async (
  form: FormData,
  field: string,
  key: Parameters<typeof setSetting>[0],
  max: number,
) => {
  const raw = form.get(field);
  if (raw === null) return; // field absent from this form, leave the setting alone
  await setSetting(key, String(raw).trim().slice(0, max));
};

export const POST: APIRoute = async ({ request }) => {
  const form = await request.formData();

  // Looped rather than written out a dozen times, so adding a slot to the lists
  // in lib/settings is the whole change.
  const slots = [
    ...PAYMENT_ACCOUNTS.map((a) => a.slot),
    ...COLLECTION_PLACES.map((p) => p.slot),
    CASH_SLOT,
  ];
  for (const slot of slots) {
    await text(form, partBodyKey(slot), partBodyKey(slot), 4000);
    await text(form, partLabelKey(slot), partLabelKey(slot), 40);
  }


  // Empty closes nothing; anything else is what customers are told.
  await text(form, 'maintenance', 'maintenance', 400);
  forgetMaintenance();

  const dropped = await retargetAlerts(form);
  await text(form, 'contact_telegram', 'contact_telegram', 80);

  // The handle is cached for a minute so the footer is not a query per page
  // view. The owner who just changed it should not have to wait that minute to
  // see whether it took.
  forgetContactTelegram();

  return new Response(null, {
    status: 302,
    headers: { Location: `/admin/settings?saved=1${dropped ? '&unbound=1' : ''}` },
  });
};

/**
 * A new contact handle means alerts are pointed at the wrong person.
 *
 * Owner alerts go to a chat id, not to a handle - the bot cannot message a
 * `@username` at all, only a chat that has messaged it first. So changing the
 * handle here does nothing to where alerts land, and they would go on reaching
 * whoever bound their chat: customer names, addresses and phone numbers, sent
 * to somebody who is no longer the owner.
 *
 * Rather than let that sit unnoticed, the binding is dropped and the settings
 * page shows "Connect this chat" again.
 *
 * Only when we can actually tell. A Telegram account need not have a username,
 * in which case the label is a display name and proves nothing - cutting the
 * alerts off on a guess would be worse than the ambiguity, so the binding
 * stays and the page says it could not be checked.
 */
async function retargetAlerts(form: FormData): Promise<boolean> {
  const raw = form.get('contact_telegram');
  if (raw === null) return false;

  const [next, current, bound] = await Promise.all([
    Promise.resolve(String(raw).trim()),
    getSetting('contact_telegram'),
    getSetting('owner_telegram_label'),
  ]);

  const handle = (v: string) => v.trim().replace(/^@/, '').toLowerCase();
  if (handle(next) === handle(current)) return false; // a typo fix, not a new person
  if (!bound.startsWith('@')) return false; // a display name; nothing to compare
  if (handle(bound) === handle(next)) return false; // still the same person

  await Promise.all([
    setSetting('owner_telegram_chat_id', ''),
    setSetting('owner_telegram_label', ''),
  ]);
  return true;
}
