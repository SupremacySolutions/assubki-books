import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { readForm } from '../../../../../lib/request-body';

export const prerender = false;

/**
 * The shipment's own details, after it has been created.
 *
 * The paste screen asks for these once and then never again, which is the
 * wrong shape for the one field most likely to change: a boat is late, and
 * "expected mid-September" has to become "late October" without the owner
 * rebuilding the shipment. The name and the note move for the same reason -
 * a typo in a heading customers read should not be permanent.
 *
 * Allowed in every status, including after arrival. The date is history by
 * then rather than a promise, but a wrong name is still worth fixing, and
 * nothing downstream reads these except the text on a page.
 */
export const POST: APIRoute = async ({ params, request }) => {
  const id = Number.parseInt(params.id ?? '', 10);
  if (!Number.isInteger(id)) return new Response('Bad request', { status: 400 });

  const form = await readForm(request);
  if (!form) return new Response('Bad request', { status: 400 });
  const title = String(form.get('title') ?? '').trim().slice(0, 160);
  const note = String(form.get('note') ?? '').trim().slice(0, 1000) || null;
  const vague = String(form.get('incoming_vague') ?? '').trim() || null;
  const month = String(form.get('incoming_month') ?? '').trim() || null;

  const back = (query: string) =>
    new Response(null, { status: 302, headers: { Location: `/admin/shipments/${id}${query}` } });

  /*
   * A shipment with no name is a row customers cannot be told apart, and the
   * heading on their page would be blank. Refused rather than saved.
   */
  if (!title) return back('?e=' + encodeURIComponent('a shipment needs a name'));

  /*
   * A month with no vague part, or the other way round, reads badly - "in
   * 2026-09" or a stray "mid-". They travel together or not at all.
   */
  /*
   * The books carry the date too, and have to move with it - in the same
   * transaction, not merely afterwards.
   *
   * Everything that tells a customer when their reservation is due reads the
   * book, not the shipment - see the note in `importLines`. These were two
   * separate writes, and the comment here described exactly what the second
   * one failing would cause: the shipment page saying January while the
   * confirmation email a customer already has still said November. `batch` is
   * a transaction, so now either both dates move or neither does.
   */
  const [changed] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE shipments
          SET title = ?, note = ?,
              incoming_vague = ?, incoming_month = ?,
              updated_at = unixepoch()
        WHERE id = ?`,
    ).bind(title, note, month ? vague : null, month, id),
    env.DB.prepare(
      `UPDATE books
          SET incoming_vague = ?, incoming_month = ?, updated_at = unixepoch()
        WHERE shipment_id = ?`,
    ).bind(month ? vague : null, month, id),
  ]);

  /* A shipment that does not exist has no books pointing at it either, so the
     second statement was a no-op too and there is nothing to undo. */
  if (!changed.meta.changes) return back('?e=' + encodeURIComponent('no such shipment'));

  return back('?details=1');
};
