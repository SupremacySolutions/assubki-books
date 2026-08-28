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
  await env.DB.prepare(`DELETE FROM settings WHERE key = 'owner_telegram_chat_id'`).run();
  return new Response(null, { status: 302, headers: { Location: '/admin/settings?saved=1' } });
};
