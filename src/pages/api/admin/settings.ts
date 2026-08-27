import type { APIRoute } from 'astro';
import { setSetting } from '../../../lib/settings';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const form = await request.formData();

  const instructions = String(form.get('payment_instructions') ?? '').trim();
  if (instructions) await setSetting('payment_instructions', instructions.slice(0, 4000));

  const postage = Number(form.get('default_postage'));
  if (Number.isFinite(postage) && postage >= 0) {
    await setSetting('default_postage_pence', String(Math.round(postage * 100)));
  }

  return new Response(null, { status: 302, headers: { Location: '/admin/settings?saved=1' } });
};
