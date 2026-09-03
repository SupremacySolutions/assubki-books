import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { forgetDashboard } from '../../../../lib/dashboard';

export const prerender = false;

/**
 * Clears out orders that came to nothing.
 *
 * Only `cancelled` and `expired` - both terminal states where the stock has
 * already been released and no money was ever involved. Anything from
 * `awaiting_payment` onwards is a business record: someone was quoted a price,
 * or paid, and those do not get swept away by a tidy-up button.
 *
 * `stock_ledger.order_id` is ON DELETE SET NULL, so the movement history
 * survives even though the order rows do not.
 */
const CLEARABLE = ['cancelled', 'expired'];

export const POST: APIRoute = async ({ request }) => {
  const form = await request.formData();
  const scopeRaw = String(form.get('scope') ?? 'both');
  const statuses = CLEARABLE.includes(scopeRaw) ? [scopeRaw] : CLEARABLE;

  const placeholders = statuses.map(() => '?').join(',');

  const countRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM orders WHERE status IN (${placeholders})`,
  )
    .bind(...statuses)
    .first<{ n: number }>();

  const n = countRow?.n ?? 0;
  if (n > 0) {
    /*
     * The screenshots these orders were holding, read before they go.
     *
     * `messages` cascades with the order, and those rows are the only record of
     * which objects in the bucket belong to it - the retention sweep walks
     * them. Clearing in bulk therefore used to strand every payment screenshot
     * those orders held, permanently and several at a time, which is the one
     * thing this feature is meant not to do with somebody's bank details.
     */
    const { results: proofs } = await env.DB.prepare(
      `SELECT m.image_key FROM messages m
         JOIN orders o ON o.id = m.order_id
        WHERE m.image_key IS NOT NULL AND o.status IN (${placeholders})`,
    )
      .bind(...statuses)
      .all<{ image_key: string }>();

    // order_items cascade from orders; the ledger keeps its rows with a null
    // order_id so stock movements remain auditable.
    await env.DB.prepare(`DELETE FROM orders WHERE status IN (${placeholders})`)
      .bind(...statuses)
      .run();
    forgetDashboard();

    // After the rows, so a failure here leaves a collectable object rather than
    // a message pointing at one that is already gone.
    const bucket = (env as unknown as { UPLOADS?: R2Bucket }).UPLOADS;
    for (const proof of proofs) {
      await bucket?.delete(proof.image_key).catch(() => {});
    }
  }

  const referer = request.headers.get('Referer');
  const back = referer && referer.includes('/admin/orders') ? referer.split('?')[0] : '/admin/orders';
  return new Response(null, { status: 302, headers: { Location: `${back}?cleared=${n}` } });
};
