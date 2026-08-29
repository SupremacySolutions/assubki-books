import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { isPostageProvider } from '../../../../../lib/order-status';

export const prerender = false;

/**
 * Correct a tracking number after the parcel has gone.
 *
 * The fields that capture this live inside the "mark as posted" action, which
 * disappears once the order is dispatched - so a typo, or a number the carrier
 * only issued afterwards, used to be permanent.
 *
 * Deliberately **not** a status transition: correcting a number is not a new
 * event in the order's life, and the customer should not be emailed "your books
 * are on the way" a second time because a digit was wrong. Their order page
 * shows the corrected number the next time they open it.
 */
export const POST: APIRoute = async ({ params, request }) => {
  const ref = params.ref!;
  const form = await request.formData();

  const tracking = String(form.get('tracking') ?? '').trim().slice(0, 80) || null;
  const submitted = String(form.get('postage_provider') ?? '').trim();
  const provider = isPostageProvider(submitted) ? submitted : null;
  const service = String(form.get('postage_service') ?? '').trim().slice(0, 60) || null;

  const result = await env.DB.prepare(
    `UPDATE orders
        SET tracking_number = ?, postage_provider = ?, postage_service = ?,
            updated_at = unixepoch()
      WHERE ref = ? AND fulfilment <> 'collection'`,
  )
    .bind(tracking, provider, service, ref)
    .run();

  if (result.meta.changes !== 1) {
    return new Response(null, { status: 302, headers: { Location: `/admin/orders/${ref}?e=state` } });
  }

  return new Response(null, { status: 302, headers: { Location: `/admin/orders/${ref}?saved=tracking` } });
};
