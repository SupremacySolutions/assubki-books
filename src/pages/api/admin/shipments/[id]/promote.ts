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
 */
export const POST: APIRoute = async ({ params, request }) => {
  const shipmentId = Number.parseInt(params.id ?? '', 10);
  const form = await request.formData();
  const bookId = Number.parseInt(String(form.get('book') ?? ''), 10);

  if (!Number.isInteger(shipmentId) || !Number.isInteger(bookId)) {
    return new Response('Bad request', { status: 400 });
  }

  const back = (query: string) =>
    new Response(null, {
      status: 302,
      headers: { Location: `/admin/shipments/${shipmentId}${query}` },
    });

  const book = await env.DB.prepare(
    'SELECT id, stock, reserved FROM books WHERE id = ? AND shipment_id = ?',
  )
    .bind(bookId, shipmentId)
    .first<{ id: number; stock: number; reserved: number }>();
  if (!book) return new Response('No such book on this shipment', { status: 404 });

  if (book.stock - book.reserved <= 0) {
    return back('?e=' + encodeURIComponent('every copy of that is spoken for, so there is nothing to list'));
  }

  await env.DB.prepare(
    `UPDATE books SET shipment_id = NULL, updated_at = unixepoch()
      WHERE id = ? AND shipment_id = ?`,
  )
    .bind(bookId, shipmentId)
    .run();

  /*
   * Straight to the listing, with a note saying what it still needs and a way
   * back to the shipment - the owner is usually working down a list of them.
   */
  return new Response(null, {
    status: 302,
    headers: { Location: `/admin/books/${bookId}?from_shipment=${shipmentId}` },
  });
};
