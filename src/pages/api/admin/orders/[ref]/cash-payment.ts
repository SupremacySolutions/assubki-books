import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const prerender = false;

/**
 * Toggle the cash_payment flag on an order.
 *
 * Admin-only, guarded in src/middleware.ts along with the rest of /api/admin.
 *
 * The flag is per order rather than a setting, because the shop takes both:
 * some orders are paid in advance, some in cash when the books change hands,
 * and the customer's page has to say which one this is. It applies to a posted
 * order as much as a collection - "cash" there means one handed over in person.
 */
export const POST: APIRoute = async ({ request, params }) => {
  const ref = params.ref?.trim();
  if (!ref) {
    return Response.json({ ok: false, error: 'Missing order reference' }, { status: 400 });
  }

  const formData = await request.formData();
  const cashPayment = formData.get('cash_payment') === '1' ? 1 : 0;

  try {
    // Any order, either journey. The changes check still earns its keep: it is
    // what makes an unknown reference a 404 rather than a no-op reported as
    // success, which would leave the checkbox showing a state no order has.
    const result = await env.DB.prepare(
      `UPDATE orders SET cash_payment = ?, updated_at = unixepoch() WHERE ref = ?`,
    )
      .bind(cashPayment, ref)
      .run();

    if (result.meta.changes !== 1) {
      return Response.json({ ok: false, error: 'No order with that reference' }, { status: 404 });
    }

    return Response.json({ ok: true, cash_payment: cashPayment });
  } catch (err) {
    console.error('cash-payment update failed', ref, err);
    return Response.json({ ok: false, error: 'Server error' }, { status: 500 });
  }
};
