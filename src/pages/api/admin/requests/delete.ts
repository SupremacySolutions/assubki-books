import type { APIRoute } from 'astro';
import { readForm } from '../../../../lib/request-body';
import { deleteRequest } from '../../../../lib/book-requests';

export const prerender = false;

/**
 * "Done with this."
 *
 * A delete rather than a `handled_at`, and that is the feature rather than a
 * shortcut. Nothing is ever sent automatically from a book request, so the shop
 * cannot make `stock_alerts`' promise that the address dies with the message it
 * was collected for. What the privacy page promises instead is that the address
 * goes when the owner is done with it - and the only way to keep that promise is
 * for being done with it to be this.
 */
export const POST: APIRoute = async ({ request }) => {
  const form = await readForm(request);
  if (!form) return new Response('Bad request', { status: 400 });

  const id = Number.parseInt(String(form.get('id') ?? ''), 10);
  if (!Number.isInteger(id)) return new Response('Bad request', { status: 400 });

  const terms = String(form.get('terms') ?? '').trim();
  await deleteRequest(id);

  const url = new URL(request.url);
  const back = new URL('/admin/requests', url.origin);
  if (terms) back.searchParams.set('done', terms);
  return new Response(null, { status: 302, headers: { Location: back.pathname + back.search } });
};
