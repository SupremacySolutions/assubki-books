import type { APIRoute } from 'astro';
import { setStock } from '../../../../lib/admin-db';
import { forgetHomeRows } from '../../../../lib/db';
import { tellWaiting } from '../../../../lib/stock-alerts';

export const prerender = false;

/** The inline stock field on the listings page. */
export const POST: APIRoute = async ({ request }) => {
  const form = await request.formData();
  const id = Number.parseInt(String(form.get('id') ?? ''), 10);
  const stock = Number.parseInt(String(form.get('stock') ?? ''), 10);

  if (!Number.isInteger(id) || !Number.isInteger(stock) || stock < 0) {
    return new Response('Bad request', { status: 400 });
  }

  await setStock(id, stock, 'quick edit in portal');
  forgetHomeRows();

  /*
   * Anybody who asked to be told is told now, at the end, when availability
   * has settled - a delivery raises stock and then hands copies to the people
   * who reserved them, so a check half way through would announce copies that
   * were already spoken for.
   */
  await tellWaiting(id, new URL(request.url).origin);

  const referer = request.headers.get('Referer');
  const back = referer && referer.includes('/admin/books') ? referer : '/admin/books';
  return new Response(null, { status: 302, headers: { Location: back } });
};
