import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const prerender = false;
export const POST: APIRoute = async ({ params, request }) => {
  const shipmentId = Number(params.id);
  if (!Number.isSafeInteger(shipmentId)) return new Response('Bad request', { status: 400 });
  const form = await request.formData();
  const rows = form
    .getAll('row')
    .map((v) => Number(v))
    .filter(Number.isSafeInteger)
    .map((id) => ({
      id,
      title: String(form.get(`title_${id}`) ?? '')
        .trim()
        .slice(0, 200),
      price: Math.max(0, Math.round(Number(form.get(`price_${id}`)) * 100 || 0)),
      incoming: Math.max(0, Math.min(999, Math.round(Number(form.get(`incoming_${id}`)) || 0))),
      volumes: Math.max(0, Math.min(200, Math.round(Number(form.get(`volumes_${id}`)) || 0))),
      script: String(form.get(`script_${id}`) ?? 'arabic'),
    }));
  const current = await env.DB.prepare('SELECT status FROM shipments WHERE id=?')
    .bind(shipmentId)
    .first<{ status: string }>();
  const back = (query: string) =>
    new Response(null, {
      status: 302,
      headers: { Location: `/admin/shipments/${shipmentId}${query}` },
    });
  if (!current || !['draft', 'open'].includes(current.status))
    return back('?e=This+shipment+is+no+longer+editable');
  if (current.status === 'open' && rows.some((r) => !r.title || r.price <= 0))
    return back('?e=Open+shipment+titles+must+keep+a+title+and+positive+price');
  if (
    rows.some(
      (r) => !Number.isSafeInteger(r.price) || !['arabic', 'urdu', 'english'].includes(r.script),
    )
  )
    return back('?e=Invalid+price+or+language');
  const data = JSON.stringify(rows);
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM books WHERE shipment_id=?1
      AND id IN (SELECT json_extract(value,'$.id') FROM json_each(?2) WHERE json_extract(value,'$.title')='')
      AND EXISTS (SELECT 1 FROM shipments WHERE id=?1 AND status='draft')
      AND NOT EXISTS (SELECT 1 FROM order_items WHERE book_id=books.id)`,
    ).bind(shipmentId, data),
    env.DB.prepare(
      `UPDATE books SET
      title=json_extract(j.value,'$.title'),
      title_ar=CASE WHEN json_extract(j.value,'$.script')='arabic' THEN json_extract(j.value,'$.title') ELSE NULL END,
      title_ur=CASE WHEN json_extract(j.value,'$.script')='urdu' THEN json_extract(j.value,'$.title') ELSE NULL END,
      price_pence=json_extract(j.value,'$.price'),
      volumes=CASE WHEN json_extract(j.value,'$.volumes')>1 THEN json_extract(j.value,'$.volumes') ELSE NULL END,
      incoming=MAX(json_extract(j.value,'$.incoming'),reserved_incoming),updated_at=unixepoch()
      FROM json_each(?2) j WHERE books.id=json_extract(j.value,'$.id') AND books.shipment_id=?1
        AND json_extract(j.value,'$.title')!=''
        AND EXISTS (SELECT 1 FROM shipments WHERE id=?1 AND
          (status='draft' OR (status='open' AND json_extract(j.value,'$.price')>0)))`,
    ).bind(shipmentId, data),
  ]);
  return back('?saved=1');
};
