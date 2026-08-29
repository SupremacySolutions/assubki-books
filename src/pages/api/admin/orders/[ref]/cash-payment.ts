import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const prerender = false;

/**
 * Toggle the cash_payment flag for a collection order.
 *
 * Admin-only, guarded in src/middleware.ts along with the rest of /api/admin.
 *
 * The flag is per order rather than a setting, because the shop takes both:
 * some collections are paid in advance, some in cash at the door, and the
 * customer's order page has to say which one this is.
 */
export const POST: APIRoute = async ({ request, params }) => {
  const ref = params.ref?.trim();
  if (!ref) {
    return Response.json({ ok: false, error: 'Missing order reference' }, { status: 400 });
  }

  const formData = await request.formData();
  const cashPayment = formData.get('cash_payment') === '1' ? 1 : 0;

  try {
    // Restricted to collection orders: there is no such thing as cash on
    // collection for something being posted, and a no-op UPDATE reported as
    // success would leave the checkbox showing a state the order does not have.
    const result = await env.DB.prepare(
      `UPDATE orders SET cash_payment = ?, updated_at = unixepoch()
        WHERE ref = ? AND fulfilment = 'collection'`,
    )
      .bind(cashPayment, ref)
      .run();

    if (result.meta.changes !== 1) {
      return Response.json(
        { ok: false, error: 'No collection order with that reference' },
        { status: 404 },
      );
    }

    return Response.json({ ok: true, cash_payment: cashPayment });
  } catch (err) {
    console.error('cash-payment update failed', ref, err);
    return Response.json({ ok: false, error: 'Server error' }, { status: 500 });
  }
};
