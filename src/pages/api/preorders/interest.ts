import type { APIRoute } from 'astro';
import { registerInterest } from '../../../lib/preorders';
import { readForm } from '../../../lib/request-body';
import { takePublicAction } from '../../../lib/public-throttle';

export const prerender = false;

/**
 * "I would take this many."
 *
 * A plain form post that answers with a redirect, like `books/request.ts`, so
 * it works with scripting off and the words live in one place - the page.
 *
 * The return path is built here from the pre-order's id and never read from
 * the form, so there is nothing to point somewhere else.
 */
export const POST: APIRoute = async ({ request }) => {
  const form = await readForm(request);
  if (!form) return new Response('Bad request', { status: 400 });

  const id = Number.parseInt(String(form.get('preorderId') ?? ''), 10);
  const answer = (result: string) => {
    const where = new URLSearchParams({ r: result });
    if (Number.isInteger(id) && id > 0) where.set('p', String(id));
    const anchor = Number.isInteger(id) && id > 0 ? `#p${id}` : '';
    return new Response(null, {
      status: 302,
      headers: { Location: `/preorders?${where}${anchor}` },
    });
  };
  if (!Number.isInteger(id) || id <= 0) return answer('bad');

  // Throttled before anything is written, so a flood costs a row read rather
  // than a row.
  const limit = await takePublicAction('preorder', request);
  if (limit.blocked) return answer('busy');

  const result = await registerInterest(
    id,
    String(form.get('name') ?? ''),
    String(form.get('email') ?? ''),
    String(form.get('copies') ?? ''),
  );
  return answer(result);
};
