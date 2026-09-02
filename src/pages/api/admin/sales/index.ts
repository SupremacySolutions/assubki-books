import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { forgetSale } from '../../../../lib/sales';

export const prerender = false;

/**
 * Creating, renaming, putting live and ending a sale.
 *
 * One route because they are all the same object changing state, and the state
 * machine is small enough to read in one place: draft → live → ended, with
 * putting one live ending whichever was running.
 */
export const POST: APIRoute = async ({ request }) => {
  const form = await request.formData();
  const action = String(form.get('action') ?? '');
  const id = Number.parseInt(String(form.get('id') ?? ''), 10);
  const back = (to: string) => new Response(null, { status: 302, headers: { Location: to } });

  if (action === 'create') {
    const name = String(form.get('name') ?? '').trim().slice(0, 120);
    const blurb = String(form.get('blurb') ?? '').trim().slice(0, 300) || null;
    if (!name) return back('/admin/sales?e=name');

    const made = await env.DB.prepare(
      'INSERT INTO sales (name, blurb) VALUES (?, ?) RETURNING id',
    )
      .bind(name, blurb)
      .first<{ id: number }>();
    return back(`/admin/sales/${made!.id}`);
  }

  if (!Number.isInteger(id)) return new Response('Bad request', { status: 400 });

  if (action === 'rename') {
    await env.DB.prepare('UPDATE sales SET name = ?, blurb = ? WHERE id = ?')
      .bind(
        String(form.get('name') ?? '').trim().slice(0, 120) || 'Sale',
        String(form.get('blurb') ?? '').trim().slice(0, 300) || null,
        id,
      )
      .run();
    forgetSale();
    return back(`/admin/sales/${id}?saved=1`);
  }

  if (action === 'live') {
    /*
     * Only one runs at a time, and the unique index enforces it - so the one
     * that is running has to be ended in the same batch, not afterwards. A
     * sale with no books would show an empty row on the home page, so it is
     * refused rather than published.
     */
    const members = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM sale_items WHERE sale_id = ?',
    )
      .bind(id)
      .first<{ n: number }>();
    if (!members?.n) return back(`/admin/sales/${id}?e=empty`);

    await env.DB.batch([
      env.DB.prepare(
        `UPDATE sales SET status = 'ended', ended_at = unixepoch() WHERE status = 'live'`,
      ),
      env.DB.prepare(
        `UPDATE sales SET status = 'live', started_at = unixepoch(), ended_at = NULL WHERE id = ?`,
      ).bind(id),
    ]);
    forgetSale();
    return back('/admin/sales?live=1');
  }

  if (action === 'end') {
    await env.DB.prepare(
      `UPDATE sales SET status = 'ended', ended_at = unixepoch() WHERE id = ? AND status = 'live'`,
    )
      .bind(id)
      .run();
    forgetSale();
    return back('/admin/sales?ended=1');
  }

  if (action === 'copy') {
    // Running last year's sale again is a copy, not a resurrection: the old one
    // keeps its dates and what it gave away.
    const source = await env.DB.prepare('SELECT name, blurb FROM sales WHERE id = ?')
      .bind(id)
      .first<{ name: string; blurb: string | null }>();
    if (!source) return back('/admin/sales');

    const made = await env.DB.prepare(
      'INSERT INTO sales (name, blurb) VALUES (?, ?) RETURNING id',
    )
      .bind(`${source.name} (copy)`.slice(0, 120), source.blurb)
      .first<{ id: number }>();

    await env.DB.prepare(
      `INSERT INTO sale_items (sale_id, book_id, percent_off)
       SELECT ?, book_id, percent_off FROM sale_items WHERE sale_id = ?`,
    )
      .bind(made!.id, id)
      .run();
    return back(`/admin/sales/${made!.id}`);
  }

  return new Response('Unknown action', { status: 400 });
};
