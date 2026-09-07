import type { APIRoute } from 'astro';
import { getOrder } from '../../../lib/orders';
import { notifyNewMessage } from '../../../lib/notify';
import { overHourlyCap, postMessage, threadOpen } from '../../../lib/messages';
import { readForm } from '../../../lib/request-body';

export const prerender = false;

/**
 * The two answers a customer owes once their reserved books arrive.
 *
 * When a shipment lands the order sits in `requested` with seven days on it,
 * and the only thing the page could offer was "write us a message" - which
 * means composing a sentence to say one of the two things everybody says. So
 * the two are buttons, and each posts the sentence on the customer's behalf.
 *
 * Both are *messages*, deliberately. "I need longer" cannot extend the
 * deadline by itself: `pay_by` is the shop's promise about its own shelf, and
 * moving it is the owner's to do from the portal. What this does is ask, and
 * ask in a way the owner sees in the same thread as everything else.
 *
 * Authority is the token that already reaches this customer's order page, the
 * same as every other action here, and it is a plain form post so the whole
 * thing works with JavaScript off.
 */
const SAYS: Record<string, string> = {
  confirm:
    'Yes please - I still want the books I reserved. Send me the total and how to pay when you can.',
  longer:
    'Could I have a little longer to reply? I still want the books I reserved - please do not put them back on the shelf yet.',
};

export const POST: APIRoute = async ({ request }) => {
  const form = await readForm(request);
  if (!form) return new Response('Bad request', { status: 400 });
  const ref = String(form.get('ref') ?? '').trim();
  const token = String(form.get('t') ?? '');
  const action = String(form.get('action') ?? '');

  const back = (query: string) =>
    new Response(null, {
      status: 302,
      headers: {
        Location: `/order?ref=${encodeURIComponent(ref)}&t=${encodeURIComponent(token)}${query}#thread`,
      },
    });

  const body = SAYS[action];
  if (!body) return new Response('Bad request', { status: 400 });

  const order = await getOrder(ref, token);
  if (!order) return new Response('Not found', { status: 404 });
  if (!threadOpen(order.status)) return back(`&e=closed`);

  /*
   * Only while the seven days are actually running.
   *
   * Before the books land there is nothing to confirm and no clock to extend,
   * and once the order has been quoted or paid the conversation has moved on -
   * in both cases the ordinary message box is the right way to write.
   */
  if (!order.pay_by || !['requested', 'awaiting_payment'].includes(order.status)) {
    return back('&e=closed');
  }

  if (await overHourlyCap(order.id)) return back('&e=rate');

  const id = await postMessage({ orderId: order.id, sender: 'customer', via: 'web', body });
  if (id === null) return back('&e=empty');

  await notifyNewMessage({
    orderId: order.id,
    ref: order.ref,
    sender: 'customer',
    name: order.customer_name,
    email: order.email,
    telegramChatId: order.telegram_chat_id,
    body,
    hasImage: false,
    origin: new URL(request.url).origin,
  });

  return back(`&replied=${action}`);
};
