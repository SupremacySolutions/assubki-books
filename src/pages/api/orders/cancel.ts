import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getOrder } from '../../../lib/orders';
import { releaseHold } from '../../../lib/stock-release';
import { cancelRight, REASON_MAX } from '../../../lib/cancellation';
import { notifyCancelRequest } from '../../../lib/notify';
import { forgetDashboard } from '../../../lib/dashboard';

export const prerender = false;

/**
 * A customer cancelling, or asking to.
 *
 * Authority is the token that already reaches this customer's own order page -
 * `getOrder` compares it in constant time and returns nothing for a miss, so a
 * wrong token is indistinguishable from a wrong reference. There is no session
 * and no cookie, which is also why there is no CSRF token to check: nothing
 * here can be forged by a page that does not already know the token.
 *
 * A plain form post, because the whole flow has to work with JavaScript off.
 */
export const POST: APIRoute = async ({ request }) => {
  const form = await request.formData();
  const ref = String(form.get('ref') ?? '').trim();
  const token = String(form.get('t') ?? '');
  const reason = String(form.get('reason') ?? '').trim().slice(0, REASON_MAX) || null;

  const order = await getOrder(ref, token);
  const back = (query: string) =>
    new Response(null, {
      status: 302,
      headers: { Location: `/order?ref=${encodeURIComponent(ref)}&t=${encodeURIComponent(token)}${query}` },
    });

  if (!order) return new Response('Not found', { status: 404 });

  const right = cancelRight(order.status, Boolean(order.cancel_requested_at));
  if (right === 'none') return back('&e=cancel');

  if (right === 'ask') {
    /*
     * Nothing about the order changes. It is still live, still holding its
     * copies, still due whatever it was due - the only new fact is that the
     * customer would like out, and the owner has to answer that themselves.
     */
    await env.DB.prepare(
      `UPDATE orders SET cancel_requested_at = unixepoch(), customer_cancel_note = ?,
                         updated_at = unixepoch()
        WHERE id = ? AND cancel_requested_at IS NULL`,
    )
      .bind(reason, order.id)
      .run();

    forgetDashboard();
    await notifyCancelRequest({
      ref: order.ref,
      name: order.customer_name,
      email: order.email,
      reason,
      origin: new URL(request.url).origin,
    }).catch(() => {
      /* the request is recorded either way; the owner sees it in the portal */
    });

    return back('&asked=1');
  }

  /*
   * Cancelled outright. The guard on `status` is what makes a double submit
   * safe: the second one changes no rows, so the release below cannot run
   * against an order that already gave its copies back.
   */
  const changed = await env.DB.prepare(
    `UPDATE orders SET status = 'cancelled', customer_cancel_note = ?, updated_at = unixepoch()
      WHERE id = ? AND status = 'requested'`,
  )
    .bind(reason, order.id)
    .run();

  if (!changed.meta.changes) return back('&e=cancel');

  await env.DB.batch(releaseHold(order.id, 'customer cancelled'));
  forgetDashboard();
  return back('&cancelled=1');
};
