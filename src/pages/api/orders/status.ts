import type { APIRoute } from 'astro';
import { getOrder } from '../../../lib/orders';

export const prerender = false;

/**
 * Current status of an order.
 *
 * Used by the order page to detect when the owner has marked the order as
 * completed (e.g. collection picked up, or delivery confirmed) and refresh
 * to show the new status without requiring a manual reload.
 */
export const GET: APIRoute = async ({ url }) => {
  const ref = url.searchParams.get('ref')?.trim() ?? '';
  const token = url.searchParams.get('t') ?? '';
  const order = ref && token ? await getOrder(ref, token) : null;

  if (!order) {
    return Response.json({ status: null }, { headers: { 'Cache-Control': 'no-store' } });
  }

  return Response.json(
    {
      status: order.status,
      completed_at: order.completed_at ?? null,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
};
