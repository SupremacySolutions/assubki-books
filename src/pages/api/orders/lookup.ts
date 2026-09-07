import type { APIRoute } from 'astro';
import { findOrder } from '../../../lib/orders';
import { takePublicAction } from '../../../lib/public-throttle';
import { readForm } from '../../../lib/request-body';

export const prerender = false;

/**
 * Finds an order from its reference and email, for a customer who no longer
 * has the link from their confirmation.
 *
 * A miss is always reported the same way. Saying "that reference exists but
 * the email is wrong" would confirm to a stranger that somebody ordered.
 *
 * Throttled, because what it hands back on a hit is the order's access token
 * itself. Knowing somebody's email address should not leave a stranger free to
 * work through references until one answers. `e=slow` is deliberately its own
 * answer rather than another miss: a customer who has genuinely mistyped twice
 * needs to be told to wait rather than told, wrongly, that their order does not
 * exist.
 */
export const POST: APIRoute = async ({ request }) => {
  const form = await readForm(request);
  if (!form) return new Response(null, { status: 302, headers: { Location: '/order?e=1' } });

  const verdict = await takePublicAction('lookup', request);
  if (verdict.blocked) {
    return new Response(null, {
      status: 302,
      headers: {
        Location: '/order?e=slow',
        'Retry-After': String(verdict.retryAfter),
      },
    });
  }

  const ref = String(form.get('ref') ?? '').trim();
  const email = String(form.get('email') ?? '').trim();

  const found = ref && email ? await findOrder(ref, email) : null;

  return new Response(null, {
    status: 302,
    headers: {
      Location: found ? `/order?ref=${found.ref}&t=${found.token}` : '/order?e=1',
    },
  });
};
