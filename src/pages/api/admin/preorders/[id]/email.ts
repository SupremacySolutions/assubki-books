import type { APIRoute } from 'astro';
import { readForm } from '../../../../../lib/request-body';
import { getPreorder } from '../../../../../lib/preorders';
import {
  MAX_MESSAGE,
  MAX_SUBJECT,
  drainPreorderMail,
  queueMailing,
  shopLink,
} from '../../../../../lib/preorder-mail';
import { env } from 'cloudflare:workers';

export const prerender = false;

/**
 * "Email everyone on this list."
 *
 * One email per person from the shop's own address, queued and then sent - the
 * first batch here, so for an ordinary list the owner sees it go before the
 * page reloads, and anything left or refused by the sweep. See
 * `lib/preorder-mail.ts`.
 *
 * POST only, like the channel post: it writes to customers, so it must not be
 * reachable by following a link.
 */
export const POST: APIRoute = async ({ params, request, url }) => {
  const id = Number.parseInt(params.id ?? '', 10);
  if (!Number.isInteger(id)) return new Response('Bad request', { status: 400 });

  const back = (query: Record<string, string>) =>
    new Response(null, {
      status: 302,
      headers: { Location: `/admin/preorders/${id}?${new URLSearchParams(query)}#email` },
    });

  const form = await readForm(request);
  if (!form) return new Response('Bad request', { status: 400 });
  const p = await getPreorder(id);
  if (!p) return new Response('Not found', { status: 404 });

  const subject = String(form.get('subject') ?? '').replace(/\s+/g, ' ').trim();
  const message = String(form.get('message') ?? '').replace(/\r\n/g, '\n').trim();
  if (!subject || subject.length > MAX_SUBJECT) return back({ mail: 'subject' });
  if (!message || message.length > MAX_MESSAGE) return back({ mail: 'message' });
  const link = shopLink(String(form.get('link') ?? ''), url.origin);
  if (!link.ok) return back({ mail: 'link' });

  const queued = await queueMailing(id, { subject, message, link: link.href });
  if (!queued.ok) return back({ mail: queued.why });

  const result = await drainPreorderMail(env.DB, undefined, queued.mailingId).catch((err) => {
    console.error('[preorder-mail] first pass failed; the sweep will retry', err);
    return { sent: 0, failed: 0 };
  });
  return back({
    mail: result.sent >= queued.recipients ? 'sent' : 'queued',
    n: String(queued.recipients),
    sent: String(result.sent),
  });
};
