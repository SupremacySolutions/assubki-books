import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const prerender = false;

/**
 * A shipment's leftovers, handed over to the ordinary listing screen.
 *
 * This used to ask for an English title here and publish the book on the spot,
 * which left the job split across two screens: half of it - the title - typed
 * on the shipment, and the other half, the photos and the description without
 * which the listing is not fit to show anybody, only reachable by going to
 * Listings afterwards and finding the row again.
 *
 * So it does the one thing that has to happen here and nothing else: the book
 * leaves the shipment, keeping the copies nobody claimed, and stays a draft.
 * The owner lands on its listing page and finishes it there - English title,
 * cover, description - and publishes when it is actually ready.
 *
 * `shipment_id` is what kept the row out of Listings and off `/book`, so
 * clearing it is what lets the listing exist at all; it is also what stops the
 * arrival logic touching the row again. It stays `draft`, so nothing is
 * publicly reachable in the meantime - and the slug it was imported with is
 * replaced when a real title is saved, in `books/save.ts`.
 *
 * It takes a selection rather than a single book, because a box of three
 * hundred titles leaves spare copies on dozens of them and a button per row
 * meant a page of dozens of buttons. One book still lands on its listing page,
 * which is the point of the whole route; several cannot, so they are detached
 * together and the owner is told once where they went.
 */
export const POST: APIRoute = async ({ params, request }) => {
  const shipmentId = Number.parseInt(params.id ?? '', 10);
  const form = await request.formData();
  const ids = [
    ...new Set(
      form
        .getAll('book')
        .map((v) => Number.parseInt(String(v), 10))
        .filter((n) => Number.isSafeInteger(n) && n > 0),
    ),
  ].slice(0, 200);

  if (!Number.isInteger(shipmentId) || !ids.length) {
    return new Response('Bad request', { status: 400 });
  }

  const back = (query: string) =>
    new Response(null, {
      status: 302,
      headers: { Location: `/admin/shipments/${shipmentId}${query}` },
    });

  /*
   * One book keeps its own refusals, because there is a person looking at one
   * row and a specific reason it cannot move. A selection cannot say six
   * different things at once, so it reports what moved and what did not.
   */
  if (ids.length === 1) {
    const book = await env.DB.prepare(
      'SELECT id, stock, reserved, incoming FROM books WHERE id = ? AND shipment_id = ?',
    )
      .bind(ids[0], shipmentId)
      .first<{ id: number; stock: number; reserved: number; incoming: number }>();
    if (!book) return new Response('No such book on this shipment', { status: 404 });
    if (book.incoming > 0)
      return back(
        '?e=' +
          encodeURIComponent('Receive the remaining copies before moving this title to listings.'),
      );
    if (book.stock - book.reserved <= 0)
      return back(
        '?e=' + encodeURIComponent('every copy of that is spoken for, so there is nothing to list'),
      );
  }

  const updated = await env.DB.prepare(
    `UPDATE books SET shipment_id = NULL, updated_at = unixepoch()
      WHERE id IN (SELECT value FROM json_each(?1))
        AND shipment_id = ?2 AND incoming = 0 AND stock > reserved
        AND EXISTS (SELECT 1 FROM shipments
                     WHERE id = books.shipment_id AND status IN ('arrived','closed'))`,
  )
    .bind(JSON.stringify(ids), shipmentId)
    .run();

  const moved = updated.meta.changes ?? 0;
  if (!moved)
    return back('?e=' + encodeURIComponent('This shipment changed. Reload and try again.'));

  /*
   * Straight to the listing, with a note saying what it still needs and a way
   * back to the shipment - the owner is usually working down a list of them.
   */
  if (ids.length === 1) {
    return new Response(null, {
      status: 302,
      headers: { Location: `/admin/books/${ids[0]}?from_shipment=${shipmentId}` },
    });
  }
  return back(`?promoted=${moved}&asked=${ids.length}`);
};
