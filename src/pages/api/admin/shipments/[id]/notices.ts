import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { noticeQueue } from '../../../../../lib/shipment-notify';

export const prerender = false;

/**
 * How far the arrival queue has drained.
 *
 * The shipment page told the owner that some customers had still to be
 * told and then said "check back in a quarter of an hour" - an instruction to
 * reload, which is the shop asking a person to do a machine's job. The queue
 * drains on the fifteen-minute sweep, so this is polled slowly; it exists so
 * the number can fall on its own and the panel can take itself away.
 *
 * One read, and only the two numbers the panel shows.
 */
export const GET: APIRoute = async ({ params }) => {
  const id = Number.parseInt(params.id ?? '', 10);
  if (!Number.isSafeInteger(id)) return new Response('Bad request', { status: 400 });
  return Response.json(await noticeQueue(env.DB, id), {
    headers: { 'Cache-Control': 'no-store' },
  });
};
