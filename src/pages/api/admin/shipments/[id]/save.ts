import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const prerender = false;

/**
 * The owner's corrections to a pasted shipment.
 *
 * Every row arrives at once, keyed by book id, and only rows that belong to
 * this shipment are touched - a forged `row_<id>` for somebody else's listing
 * reaches nothing, because the WHERE names the shipment as well as the row.
 *
 * A row the owner emptied the title of is deleted rather than saved blank: on
 * a pasted list, clearing a line is how you say the parser invented it.
 */
export const POST: APIRoute = async ({ params, request }) => {
  const shipmentId = Number.parseInt(params.id ?? '', 10);
  if (!Number.isInteger(shipmentId)) return new Response('Bad request', { status: 400 });

  const form = await request.formData();
  const ids = form.getAll('row').map((v) => Number(v)).filter(Number.isInteger);

  const statements = [];
  for (const id of ids) {
    const title = String(form.get(`title_${id}`) ?? '').trim().slice(0, 200);
    const price = Math.max(0, Math.round(Number(form.get(`price_${id}`)) * 100 || 0));
    const copies = Math.max(0, Math.min(999, Math.round(Number(form.get(`incoming_${id}`)) || 0)));
    const volumesRaw = Math.round(Number(form.get(`volumes_${id}`)) || 0);
    const volumes = volumesRaw > 1 ? Math.min(200, volumesRaw) : null;
    const script = String(form.get(`script_${id}`) ?? 'arabic');

    if (!title) {
      statements.push(
        env.DB.prepare('DELETE FROM books WHERE id = ? AND shipment_id = ?').bind(id, shipmentId),
      );
      continue;
    }

    /*
     * `incoming` is floored at what customers have already claimed, the same
     * way stock is floored at `reserved`. Lowering it below that would strand
     * people holding a promise the shop has quietly withdrawn.
     */
    statements.push(
      env.DB.prepare(
        `UPDATE books
            SET title = ?,
                title_ar = CASE WHEN ? = 'arabic' THEN ? ELSE NULL END,
                title_ur = CASE WHEN ? = 'urdu'   THEN ? ELSE NULL END,
                price_pence = ?, volumes = ?,
                incoming = MAX(?, reserved_incoming),
                updated_at = unixepoch()
          WHERE id = ? AND shipment_id = ?`,
      ).bind(title, script, title, script, title, price, volumes, copies, id, shipmentId),
    );
  }

  if (statements.length) await env.DB.batch(statements);

  return new Response(null, {
    status: 302,
    headers: { Location: `/admin/shipments/${shipmentId}?saved=1` },
  });
};
