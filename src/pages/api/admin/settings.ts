import type { APIRoute } from 'astro';
import { setSetting } from '../../../lib/settings';

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

  await text(form, 'payment_instructions', 'payment_instructions', 4000);
  await text(form, 'collection_address', 'collection_address', 300);
  await text(form, 'contact_telegram', 'contact_telegram', 80);

  // An empty box is not a request to charge nothing: Number('') is 0, so the
  // old check quietly set postage to zero whenever the field was cleared.
  const raw = String(form.get('default_postage') ?? '').trim();
  if (raw) {
    const postage = Number(raw);
    if (Number.isFinite(postage) && postage >= 0) {
      await setSetting('default_postage_pence', String(Math.round(postage * 100)));
    }
  }

  return new Response(null, { status: 302, headers: { Location: '/admin/settings?saved=1' } });
};
