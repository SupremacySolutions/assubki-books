import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

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
    // order_items cascade from orders; the ledger keeps its rows with a null
    // order_id so stock movements remain auditable.
    await env.DB.prepare(`DELETE FROM orders WHERE status IN (${placeholders})`)
      .bind(...statuses)
      .run();
  }

  const referer = request.headers.get('Referer');
  const back = referer && referer.includes('/admin/orders') ? referer.split('?')[0] : '/admin/orders';
  return new Response(null, { status: 302, headers: { Location: `${back}?cleared=${n}` } });
};
