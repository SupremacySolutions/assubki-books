import type { APIRoute } from 'astro';
import { askForTitle } from '../../../lib/book-requests';
import { readForm } from '../../../lib/request-body';
import { takePublicAction } from '../../../lib/public-throttle';

export const prerender = false;

/**
 * "Ask us to find it."
 *
 * Built like `books/alert.ts` next door: a plain form post, because everything
 * a customer does here has to work with JavaScript off, and the answer comes
 * back as a query flag on the page they were already on rather than as JSON, so
 * there is one path and one set of words.
 *
 * Two things differ from that file, both because this form takes free text.
 * It is throttled per address, and the page it returns to has to be worked out
 * rather than rebuilt from a slug - which is where the hazard is.
 */
export const POST: APIRoute = async ({ request }) => {
  const form = await readForm(request);
  if (!form) return new Response('Bad request', { status: 400 });

  const url = new URL(request.url);

  /*
   * Where to send them back to, and why this is not just `form.get('back')`.
   *
   * `alert.ts` has a slug and rebuilds its own URL from it, so it cannot be
   * pointed anywhere. There is no slug here - the customer is on a catalogue
   * search that matched nothing - so the return path comes from the form, and a
   * free-text redirect target on a public unauthenticated POST is the classic
   * phishing hop: post the form, land on somebody else's login page.
   *
   * So it is parsed against this origin and then checked twice: same origin,
   * and somewhere under /catalogue. Anything else falls back to the catalogue
   * root rather than being refused - the request itself was fine, and losing it
   * to punish a malformed field would be the wrong trade.
   *
   * `searchParams.set` rather than string concatenation, because `back` already
   * carries the `?q=` that produced the empty result.
   */
  let target: URL;
  try {
    target = new URL(String(form.get('back') ?? ''), url.origin);
  } catch {
    target = new URL('/catalogue', url.origin);
  }
  const safe =
    target.origin === url.origin && target.pathname.startsWith('/catalogue')
      ? target
      : new URL('/catalogue', url.origin);

  const answer = (result: string) => {
    safe.searchParams.set('want', result);
    return new Response(null, {
      status: 302,
      headers: { Location: `${safe.pathname}${safe.search}#want` },
    });
  };

  // Throttled before anything is written, so a flood costs a row read rather
  // than a row.
  const limit = await takePublicAction('request', request);
  if (limit.blocked) return answer('busy');

  const result = await askForTitle(
    String(form.get('terms') ?? ''),
    String(form.get('email') ?? ''),
    String(form.get('note') ?? ''),
  );
  return answer(result);
};
