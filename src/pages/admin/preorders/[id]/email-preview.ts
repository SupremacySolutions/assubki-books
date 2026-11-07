import type { APIRoute } from 'astro';
import { getPreorder, interestFor } from '../../../../lib/preorders';
import { defaultMail, preorderEmail, shopLink } from '../../../../lib/preorder-mail';

export const prerender = false;

/**
 * The email exactly as the first person on the list will get it.
 *
 * Opened from the pre-order page's Preview button with whatever is in the form,
 * so the owner reads the real thing - letterhead, greeting, their book card -
 * before it goes to anybody. Built by the same function the send uses, so the
 * two cannot drift apart. Under /admin, so the portal's sign-in guards it.
 */
export const GET: APIRoute = async ({ params, url }) => {
  const id = Number.parseInt(params.id ?? '', 10);
  if (!Number.isInteger(id)) return new Response('Bad request', { status: 400 });
  const p = await getPreorder(id);
  if (!p) return new Response('Not found', { status: 404 });

  const q = url.searchParams;
  const fallback = defaultMail(p);
  const link = shopLink(q.get('link') ?? '', url.origin);
  const first = (await interestFor(id))[0];
  const email = preorderEmail(p, first ?? { name: 'Aisha', copies: 1 }, {
    subject: (q.get('subject') ?? '').trim() || fallback.subject,
    message: (q.get('message') ?? '').trim() || fallback.message,
    link: link.ok ? link.href : null,
  });

  return new Response(email.html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
    },
  });
};
