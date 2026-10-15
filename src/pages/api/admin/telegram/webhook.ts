import type { APIRoute } from 'astro';
import { repointWebhook } from '../../../../lib/telegram';

export const prerender = false;

/**
 * Points the bot back at this shop, from the Health page.
 *
 * The repair for the failure `webhookHealth` reports. Behind the portal login
 * like everything under `/api/admin/`, and it can only ever register this
 * shop's own address with this shop's own secret - there is no URL to supply.
 */
export const POST: APIRoute = async ({ site, url, redirect }) => {
  const origin = (site ?? new URL(url.origin)).origin;
  const failure = await repointWebhook(origin);
  return redirect(
    failure
      ? `/admin/health?telegram=failed&why=${encodeURIComponent(failure.slice(0, 200))}`
      : '/admin/health?telegram=fixed',
    303,
  );
};
