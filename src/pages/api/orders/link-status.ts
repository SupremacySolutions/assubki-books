import type { APIRoute } from 'astro';
import { getOrder } from '../../../lib/orders';

export const prerender = false;

/**
 * Whether this order has a Telegram chat attached yet.
 *
 * The order page is server-rendered, so a customer who taps Connect, presses
 * Start in Telegram and switches back is looking at HTML from before they
 * linked - still being asked to do the thing they just did. The page asks this
 * when it regains focus.
 *
 * Token-checked like every other order lookup, and answers with a single
 * boolean: nothing here should be able to leak a customer's details.
 */
export const GET: APIRoute = async ({ url }) => {
  const ref = url.searchParams.get('ref')?.trim() ?? '';
  const token = url.searchParams.get('t') ?? '';
  const order = ref && token ? await getOrder(ref, token) : null;

  return Response.json(
    { linked: Boolean(order?.telegram_chat_id) },
    { headers: { 'Cache-Control': 'no-store' } },
  );
};
