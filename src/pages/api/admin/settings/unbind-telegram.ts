import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const prerender = false;

/**
 * Releases the chat that receives owner alerts.
 *
 * The binding is a single slot filled by whoever last tapped the link, so a
 * mis-bind used to be unrecoverable without direct database access - and it
 * would have kept sending that chat customers' names and addresses.
 */
export const POST: APIRoute = async () => {
  // The label goes with it, or the page would go on naming a chat that is no
  // longer bound to anything.
  await env.DB.prepare(
    `DELETE FROM settings WHERE key IN ('owner_telegram_chat_id', 'owner_telegram_label')`,
  ).run();
  return new Response(null, { status: 302, headers: { Location: '/admin/settings?saved=1' } });
};
