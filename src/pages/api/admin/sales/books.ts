import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { forgetSale } from '../../../../lib/sales';

export const prerender = false;

/**
 * Which books are in a sale, and by how much.
 *
 * The whole visible page is submitted at once, so a book the owner cleared has
 * no field coming back and would be indistinguishable from one on another page
 * of results. `present_<id>` marks every row that was actually on screen, and
 * only those are reconsidered - so editing page two cannot empty page one.
 *
 * A blank or zero percentage means "not in the sale", and deletes the row
 * rather than storing a zero that every reader would then have to filter out.
 */
export const POST: APIRoute = async ({ request }) => {
  const form = await request.formData();
  const saleId = Number.parseInt(String(form.get('sale_id') ?? ''), 10);
  if (!Number.isInteger(saleId)) return new Response('Bad request', { status: 400 });

  const statements = [];
  for (const key of [...form.keys()]) {
    const match = key.match(/^present_(\d+)$/);
    if (!match) continue;
    const bookId = Number(match[1]);

    const raw = String(form.get(`percent_${bookId}`) ?? '').trim();
    const percent = Math.round(Number(raw));

    if (!raw || !Number.isFinite(percent) || percent <= 0) {
      statements.push(
        env.DB.prepare('DELETE FROM sale_items WHERE sale_id = ? AND book_id = ?')
          .bind(saleId, bookId),
      );
      continue;
    }

    // Capped at 90: a hundred percent off is a giveaway, not a sale, and is
    // far more likely to be a typo.
    const safe = Math.min(90, percent);
    statements.push(
      env.DB.prepare(
        `INSERT INTO sale_items (sale_id, book_id, percent_off) VALUES (?, ?, ?)
         ON CONFLICT(sale_id, book_id) DO UPDATE SET percent_off = excluded.percent_off`,
      ).bind(saleId, bookId, safe),
    );
  }

  if (statements.length) await env.DB.batch(statements);
  forgetSale();

  const back = String(form.get('back') ?? `/admin/sales/${saleId}`);
  return new Response(null, {
    status: 302,
    headers: { Location: back.startsWith('/admin/sales') ? `${back}${back.includes('?') ? '&' : '?'}saved=1` : `/admin/sales/${saleId}?saved=1` },
  });
};
