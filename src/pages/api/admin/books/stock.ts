import type { APIRoute } from 'astro';
import { setStock } from '../../../../lib/admin-db';

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

  const referer = request.headers.get('Referer');
  const back = referer && referer.includes('/admin/books') ? referer : '/admin/books';
  return new Response(null, { status: 302, headers: { Location: back } });
};
