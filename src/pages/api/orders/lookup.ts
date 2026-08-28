import type { APIRoute } from 'astro';
import { findOrder } from '../../../lib/orders';

export const prerender = false;

/**
 * Finds an order from its reference and email, for a customer who no longer
 * has the link from their confirmation.
 *
 * A miss is always reported the same way. Saying "that reference exists but
 * the email is wrong" would confirm to a stranger that somebody ordered.
 */
export const POST: APIRoute = async ({ request }) => {
  const form = await request.formData();
  const ref = String(form.get('ref') ?? '').trim();
  const email = String(form.get('email') ?? '').trim();

  const found = ref && email ? await findOrder(ref, email) : null;

  return new Response(null, {
    status: 302,
    headers: {
      Location: found ? `/order/${found.ref}?t=${found.token}` : '/order?e=1',
    },
  });
};
