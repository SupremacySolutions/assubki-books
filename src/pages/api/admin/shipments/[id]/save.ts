import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { readForm } from '../../../../../lib/request-body';
import { REMOVABLE_ROW, shipmentReturn } from '../../../../../lib/shipments';

export const prerender = false;

/**
 * The editor's save: every open row's fields, and the rows ticked to remove.
 *
 * A row is removed when its Remove box is ticked, or - the older gesture, kept
 * because it is what the bar used to say - when its title is cleared. Either
 * way it goes through `REMOVABLE_ROW`, the same guard as the Remove button, so
 * a title somebody has reserved is kept and the owner is told how many were.
 */
export const POST: APIRoute = async ({ params, request }) => {
  const shipmentId = Number(params.id);
  if (!Number.isSafeInteger(shipmentId)) return new Response('Bad request', { status: 400 });
  const form = await readForm(request);
  if (!form) return new Response('Bad request', { status: 400 });
  const back = (extra: Record<string, string | number | null>) =>
    shipmentReturn(shipmentId, form, extra);

  const ticked = new Set(
    form
      .getAll('remove')
      .map((v) => Number(v))
      .filter(Number.isSafeInteger),
  );
  const rows = [
    ...new Set(
      form
        .getAll('row')
        .map((v) => Number(v))
        .filter(Number.isSafeInteger),
    ),
  ].map((id) => {
    const title = String(form.get(`title_${id}`) ?? '')
      .trim()
      .slice(0, 200);
    return {
      id,
      title,
      remove: ticked.has(id) || !title,
      price: Math.max(0, Math.round(Number(form.get(`price_${id}`)) * 100 || 0)),
      incoming: Math.max(0, Math.min(999, Math.round(Number(form.get(`incoming_${id}`)) || 0))),
      volumes: Math.max(0, Math.min(200, Math.round(Number(form.get(`volumes_${id}`)) || 0))),
      script: String(form.get(`script_${id}`) ?? 'arabic'),
    };
  });
  const keep = rows.filter((r) => !r.remove);
  const drop = rows.filter((r) => r.remove).map((r) => r.id);

  const current = await env.DB.prepare('SELECT status FROM shipments WHERE id=?')
    .bind(shipmentId)
    .first<{ status: string }>();
  if (!current || !['draft', 'open'].includes(current.status))
    return back({ e: 'This shipment is no longer editable' });
  /* Customers can reserve from an open shipment, so every title left on it
     has to be one they could pay for. A draft may keep holes to fill later. */
  if (current.status === 'open' && keep.some((r) => r.price <= 0))
    return back({ e: 'A title on an open shipment needs a price above nothing', edit: form.get('edit') as string | null });
  /* The row guard stops a single removal emptying an open shipment, but it
     is judged row by row against the list as it was, so a page ticked in full
     is caught here instead. */
  if (current.status === 'open' && drop.length) {
    const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM books WHERE shipment_id = ?')
      .bind(shipmentId)
      .first<{ n: number }>();
    if ((left?.n ?? 0) - drop.length < 1)
      return back({
        e: 'An open shipment needs at least one title. Add the right one first, then remove these',
        edit: form.get('edit') as string | null,
      });
  }
  if (keep.some((r) => !['arabic', 'urdu', 'english'].includes(r.script)))
    return back({ e: 'Invalid language', edit: form.get('edit') as string | null });

  const [removed] = await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM books WHERE shipment_id=?1
        AND id IN (SELECT value FROM json_each(?2))
        AND ${REMOVABLE_ROW}
      RETURNING id`,
    ).bind(shipmentId, JSON.stringify(drop)),
    env.DB.prepare(
      `UPDATE books SET
      title=json_extract(j.value,'$.title'),
      title_ar=CASE WHEN json_extract(j.value,'$.script')='arabic' THEN json_extract(j.value,'$.title') ELSE NULL END,
      title_ur=CASE WHEN json_extract(j.value,'$.script')='urdu' THEN json_extract(j.value,'$.title') ELSE NULL END,
      price_pence=json_extract(j.value,'$.price'),
      volumes=CASE WHEN json_extract(j.value,'$.volumes')>1 THEN json_extract(j.value,'$.volumes') ELSE NULL END,
      incoming=MAX(json_extract(j.value,'$.incoming'),reserved_incoming),updated_at=unixepoch()
      FROM json_each(?2) j WHERE books.id=json_extract(j.value,'$.id') AND books.shipment_id=?1
        AND EXISTS (SELECT 1 FROM shipments WHERE id=?1 AND
          (status='draft' OR (status='open' AND json_extract(j.value,'$.price')>0)))`,
    ).bind(shipmentId, JSON.stringify(keep)),
  ]);

  const gone = removed.results.length;
  /* One row edited is one row to land back on, not the top of the page. */
  const one = Number(form.get('edit'));
  const landOn = Number.isSafeInteger(one) && keep.some((r) => r.id === one) ? `row-${one}` : undefined;
  return shipmentReturn(
    shipmentId,
    form,
    {
      saved: 1,
      removed_n: gone || null,
      /* Asked to go and still here: reserved, or on somebody's order. */
      kept_n: drop.length - gone || null,
    },
    landOn,
  );
};
