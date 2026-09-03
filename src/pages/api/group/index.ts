import type { APIRoute } from 'astro';
import { createGroup, getGroup, cleanName } from '../../../lib/group';
import { notifyGroupStarted } from '../../../lib/notify';
import { takePublicAction } from '../../../lib/public-throttle';

export const prerender = false;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Create a group basket, or read one.
 *
 * The read is what the basket page polls, so it must never be cached: a group
 * basket that does not show what someone else just added is the one thing this
 * feature exists to do.
 *
 * Two keys come back from a create. The share link carries the one that adds;
 * the organiser keeps the one that sends, and it is emailed to them so losing
 * the page is no worse than losing an order confirmation.
 */
export const POST: APIRoute = async ({ request, url, locals }) => {
  /*
   * Six new group baskets an hour from one address.
   *
   * Starting one is unauthenticated and sends the organiser an email, so
   * without a limit the form is a way to post mail at somebody. Counted apart
   * from orders so a busy afternoon of ordering cannot stop a teacher starting
   * a class list.
   */
  const allowance = await takePublicAction('group', request);
  if (allowance.blocked) {
    return Response.json(
      { ok: false, error: 'That is a lot of group baskets at once. Please try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(allowance.retryAfter) } },
    );
  }

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const organiser = cleanName(body.name);
  const email = String(body.email ?? '').trim();

  if (organiser.length < 2) {
    return Response.json(
      { ok: false, error: 'Add your name so the others know whose list it is.' },
      { status: 400 },
    );
  }
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return Response.json(
      { ok: false, error: 'Add your email - it is how you get back to this basket if you lose the page.' },
      { status: 400 },
    );
  }

  const { code, token, ownerToken } = await createGroup(organiser, email);

  const link = (key: string) =>
    `${url.origin}/basket?g=${encodeURIComponent(code)}&k=${encodeURIComponent(key)}`;

  // The basket exists either way: an email that will not send is not a reason
  // to refuse someone their group, only a reason they must keep the page.
  const sent = await notifyGroupStarted({
    name: organiser,
    email,
    code,
    organiserLink: link(ownerToken),
    shareLink: link(token),
  }).catch((err) => {
    console.error('group basket email failed', code, err);
    return false;
  });

  return Response.json({ ok: true, code, token, ownerToken, emailed: sent });
};

export const GET: APIRoute = async ({ url }) => {
  const code = url.searchParams.get('g')?.trim() ?? '';
  const key = url.searchParams.get('k')?.trim() ?? '';
  const group = code && key ? await getGroup(code, key) : null;

  if (!group) {
    return Response.json(
      { ok: false, error: 'That group basket has expired or the link is incomplete.' },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  return Response.json({ ok: true, group }, { headers: { 'Cache-Control': 'no-store' } });
};
