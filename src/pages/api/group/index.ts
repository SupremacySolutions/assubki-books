import type { APIRoute } from 'astro';
import { createGroup, getGroup, cleanName } from '../../../lib/group';

export const prerender = false;

/**
 * Create a group basket, or read one.
 *
 * The read is what the basket page polls, so it must never be cached: a group
 * basket that does not show what someone else just added is the one thing this
 * feature exists to do.
 */
export const POST: APIRoute = async ({ request }) => {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const organiser = cleanName(body.name);
  if (organiser.length < 2) {
    return Response.json({ ok: false, error: 'Add your name so the others know whose list it is.' }, { status: 400 });
  }

  const { code, token } = await createGroup(organiser);
  return Response.json({ ok: true, code, token });
};

export const GET: APIRoute = async ({ url }) => {
  const code = url.searchParams.get('g')?.trim() ?? '';
  const token = url.searchParams.get('k')?.trim() ?? '';
  const group = code && token ? await getGroup(code, token) : null;

  if (!group) {
    return Response.json(
      { ok: false, error: 'That group basket has expired or the link is incomplete.' },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  return Response.json({ ok: true, group }, { headers: { 'Cache-Control': 'no-store' } });
};
