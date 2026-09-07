import type { APIRoute } from 'astro';
import { forgetHomeRows } from '../../../../../lib/db';
import { forgetDashboard } from '../../../../../lib/dashboard';
import { tellWaiting } from '../../../../../lib/stock-alerts';
import { fillClaims, ReceiptConflict } from '../../../../../lib/arrival';
import { readForm } from '../../../../../lib/request-body';

export const prerender = false;
export const POST: APIRoute = async ({ params, request }) => {
  const bookId = Number(params.id);
  const form = await readForm(request);
  if (!form) return new Response('Bad request', { status: 400 });
  const arrived = Number(form.get('arrived'));
  const key = String(form.get('receipt_key') ?? '');
  const version = Number(form.get('delivery_version'));
  if (!Number.isSafeInteger(bookId) || !Number.isSafeInteger(arrived) || arrived<1 || arrived>999 ||
      !/^[\w-]{16,80}$/.test(key) || !form.has('delivery_version') || !Number.isSafeInteger(version)) {
    return new Response('Reload the listing and enter the number received.', {status:400});
  }
  try {
    await fillClaims(bookId,arrived,key,version);
  } catch (err) {
    if (!(err instanceof ReceiptConflict)) throw err;
    return new Response(err.message,{status:409});
  }
  forgetHomeRows();
  forgetDashboard();
  await tellWaiting(bookId,new URL(request.url).origin);
  return new Response(null,{status:302,headers:{Location:`/admin/books/${bookId}?arrived=1`}});
};
