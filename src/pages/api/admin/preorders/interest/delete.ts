import type { APIRoute } from 'astro';
import { readForm } from '../../../../../lib/request-body';
import { deleteInterest } from '../../../../../lib/preorders';

export const prerender = false;

/**
 * Takes one person off a pre-order's list - because they asked, or because it
 * was a test. A delete, not a flag, so the address is gone when it says so.
 */
export const POST: APIRoute = async ({ request }) => {
  const form = await readForm(request);
  if (!form) return new Response('Bad request', { status: 400 });

  const id = Number.parseInt(String(form.get('id') ?? ''), 10);
  if (!Number.isInteger(id)) return new Response('Bad request', { status: 400 });

  const preorderId = await deleteInterest(id);
  const location = preorderId ? `/admin/preorders/${preorderId}?removed=1#interest` : '/admin/preorders';
  return new Response(null, { status: 302, headers: { Location: location } });
};
