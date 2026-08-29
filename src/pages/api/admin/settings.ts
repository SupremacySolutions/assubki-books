import type { APIRoute } from 'astro';
import {
  setSetting,
  forgetContactTelegram,
  PAYMENT_DRAFTS,
  draftBodyKey,
  draftLabelKey,
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

  // Looped rather than written out twelve times, so adding a slot to the list
  // in lib/settings is the whole change.
  for (const draft of PAYMENT_DRAFTS) {
    await text(form, draftBodyKey(draft.slot), draftBodyKey(draft.slot), 4000);
    await text(form, draftLabelKey(draft.slot), draftLabelKey(draft.slot), 40);
  }

  await text(form, 'collection_address', 'collection_address', 300);
  await text(form, 'contact_telegram', 'contact_telegram', 80);

  // The handle is cached for a minute so the footer is not a query per page
  // view. The owner who just changed it should not have to wait that minute to
  // see whether it took.
  forgetContactTelegram();

  return new Response(null, { status: 302, headers: { Location: '/admin/settings?saved=1' } });
};
