import type { APIRoute } from 'astro';
import { askToBeTold } from '../../../lib/stock-alerts';

export const prerender = false;

/**
 * "Tell me when it is back."
 *
 * A plain form post, because everything a customer does on this site has to
 * work with JavaScript off. There is no session and so nothing to forge from;
 * Astro's `checkOrigin` already refuses a cross-site post.
 *
 * The answer comes back on the book page as a query flag rather than as JSON,
 * so there is one path and one set of words rather than two.
 */
export const POST: APIRoute = async ({ request }) => {
  const form = await request.formData();
  const bookId = Number.parseInt(String(form.get('bookId') ?? ''), 10);
  const slug = String(form.get('slug') ?? '').trim();
  const email = String(form.get('email') ?? '');

  if (!Number.isInteger(bookId) || !slug) return new Response('Bad request', { status: 400 });

  const result = await askToBeTold(bookId, email);
  return new Response(null, {
    status: 302,
    headers: { Location: `/book/${encodeURIComponent(slug)}?tell=${result}#tell` },
  });
};
