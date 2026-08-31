import { defineMiddleware } from 'astro:middleware';
import { slugForLegacy } from './lib/db';
import { authenticate, adminLocked, passwordFallbackActive } from './lib/admin-auth';
import { maintenanceNotice } from './lib/maintenance';

/**
 * Old WooCommerce URLs keep working.
 *
 * The Telegram channel has been posting /product/<slug>/ links for months and
 * those messages are permanent, so those links must land on the new page
 * rather than a 404. Slugs were percent-encoded Arabic, which is why each book
 * kept its `legacy_slug`.
 */
export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url;

  /*
   * A fresh nonce per request, minted before anything renders so the pages can
   * stamp it on their inline scripts and the header can name it afterwards.
   *
   * This is what lets the policy drop `'unsafe-inline'`. With it, the CSP did
   * not stop injected inline script at all - the header looked like protection
   * without being any. Script that arrives through an injection has no way to
   * know this number, so it does not run.
   */
  context.locals.cspNonce = crypto.randomUUID().replace(/-/g, '');

  /*
   * One canonical address, and only one front door.
   *
   * Several hostnames reach this Worker - the apex, `www`, and the
   * `workers.dev` address it was first deployed to. Left alone, the whole shop
   * exists at each of them, each naming itself canonical, **and so does the
   * portal**. That last part is the reason this is not merely an SEO tidy-up:
   * anything bound to the custom domain - a firewall rule, a rate limit, and
   * Cloudflare Access when it is switched on - is bound to a hostname, and the
   * `workers.dev` address would go on serving `/admin` around all of it.
   *
   * Development hosts are left alone so `localhost` still works.
   */
  const host = context.url.hostname;
  const canonical = 'assubkibooks.co.uk';
  const isDev = host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local');

  if (!isDev && host !== canonical) {
    return context.redirect(`https://${canonical}${pathname}${context.url.search}`, 301);
  }

  // ---------------------------------------------------------------------
  // The portal. Guarded here rather than per-page so a new admin route
  // cannot be added without protection by simply forgetting to add it.
  // ---------------------------------------------------------------------
  if (pathname === '/admin' || pathname.startsWith('/admin/') || pathname.startsWith('/api/admin/')) {
    const isLoginRoute = pathname === '/admin/login' || pathname === '/api/admin/login';

    if (adminLocked()) {
      return new Response(
        'The portal is not configured yet. Set up Cloudflare Access, or set an ADMIN_PASSWORD secret.',
        { status: 503, headers: { 'Content-Type': 'text/plain' } },
      );
    }

    if (!isLoginRoute) {
      const identity = await authenticate(context.request);
      if (!identity) {
        // Access shows its own login screen, so an unauthenticated request can
        // only really reach here on the interim password path.
        if (passwordFallbackActive()) {
          return context.redirect(`/admin/login?next=${encodeURIComponent(pathname)}`, 302);
        }
        return new Response('Not authorised.', { status: 403 });
      }
      context.locals.admin = identity;
    }
  }

  /*
   * The shop can be closed without the portal closing with it.
   *
   * `/order` stays open on purpose: somebody waiting on books they have
   * already paid for should not hit a wall because the shop is being worked
   * on, and the link in their email and their Telegram must keep working. So
   * does `/img`, or the order page would lose its covers.
   *
   * 503 with Retry-After rather than 200, so a crawler treats it as temporary
   * and does not start dropping the shop from its index.
   */
  const stillOpen =
    /*
     * The portal by path, not by whether the request is already signed in.
     * Keying it on `locals.admin` locked the sign-in page itself behind the
     * closed sign - so closing the shop and then signing out left no way back
     * in to open it again.
     */
    pathname === '/admin' ||
    pathname.startsWith('/admin/') ||
    pathname.startsWith('/api/admin/') ||
    pathname.startsWith('/order') ||
    pathname.startsWith('/api/orders') ||
    pathname.startsWith('/img/') ||
    pathname.startsWith('/_astro/') ||
    pathname === '/favicon.svg' ||
    pathname === '/robots.txt';

  if (!stillOpen) {
    const notice = await maintenanceNotice();
    if (notice) {
      return new Response(closedPage(notice), {
        status: 503,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Retry-After': '3600',
          'Cache-Control': 'no-store',
        },
      });
    }
  }

  const product = /^\/product\/([^/]+)\/?$/.exec(pathname);
  if (product) {
    // The stored legacy slug is percent-encoded exactly as WooCommerce had it,
    // so try the raw form first and the decoded form as a fallback.
    const raw = product[1];
    let slug = await slugForLegacy(raw);
    if (!slug) {
      try {
        slug = await slugForLegacy(decodeURIComponent(raw));
      } catch {
        /* malformed escape sequence - fall through to the catalogue */
      }
    }
    return context.redirect(slug ? `/book/${slug}` : '/catalogue', 301);
  }

  const category = /^\/product-category\/(.+?)\/?$/.exec(pathname);
  if (category) return context.redirect(`/catalogue/${category[1]}`, 301);

  // The old WooCommerce pages. Note /checkout is deliberately absent: this
  // site has its own /checkout, and redirecting it would swallow the route.
  if (/^\/(shop|my-account)\/?$/.test(pathname)) return context.redirect('/catalogue', 301);
  if (/^\/cart\/?$/.test(pathname)) return context.redirect('/basket', 301);

  const response = await next();
  return withSecurityHeaders(response, context.url.protocol === 'https:', context.locals.cspNonce);
});

/**
 * Headers every response carries. There were none at all.
 *
 * **Inline scripts run on a nonce, not on trust.** Every `is:inline` block in
 * this codebase carries the per-request nonce minted above; a script that
 * arrives through an injection cannot know that number, so the browser refuses
 * it. That is the protection `'unsafe-inline'` was quietly giving up.
 *
 * `style-src` keeps `'unsafe-inline'`, which is a far smaller thing: inline
 * *style attributes* cannot take a nonce at all, and the worst an injected one
 * does is make the page ugly.
 *
 * The rest:
 *
 * - `frame-ancestors 'none'` - the site cannot be framed, so it cannot be
 *   clickjacked. This is what replaces X-Frame-Options.
 * - `form-action 'self'` - an injected form cannot post the owner's session
 *   or a customer's address to somebody else's server.
 * - `base-uri 'self'` - a `<base>` tag cannot be used to re-point every
 *   relative URL on the page.
 * - `object-src 'none'` - no plugins, ever.
 * - `default-src`/`connect-src 'self'` - nothing loads or calls out to another
 *   origin, which is true today: the site fetches nothing external.
 *
 */
function withSecurityHeaders(response: Response, secure: boolean, nonce: string): Response {
  // Astro returns immutable responses for some routes; cloning the headers is
  // the only way to add to them without throwing.
  const headers = new Headers(response.headers);

  headers.set(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      // Our own `is:inline` blocks carry the nonce. Astro's bundles are
      // separate files (see assetsInlineLimit in astro.config), so 'self'
      // covers them - which is why nothing here needs 'unsafe-inline'.
      `script-src 'self' 'nonce-${nonce}'`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; '),
  );
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');

  // Only over HTTPS - sent on a plain connection it is ignored, and in
  // development it would pin localhost to a scheme it does not serve.
  if (secure) {
    headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * What a customer sees while the shop is closed.
 *
 * Written out here rather than as a page, because a page would go through the
 * same rendering that may itself be what is being worked on - and a
 * maintenance screen that cannot render is not much of a maintenance screen.
 */
function closedPage(message: string): string {
  const safe = message
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Back shortly - As-Subkī Books</title>
<style>
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:2rem;
         background:#f5f4f0; color:#1a1a18;
         font-family:ui-serif, Georgia, serif; }
  main { max-width:34rem; text-align:center; }
  h1 { font-size:1.7rem; font-weight:600; margin:0 0 .75rem; }
  p { font-size:1.05rem; line-height:1.65; color:#4a4a45; margin:0 0 1rem;
      font-family:ui-sans-serif, system-ui, sans-serif; white-space:pre-line; }
  a { color:#184485; }
</style>
</head><body><main>
<h1>مكتبة السبكي · As-Subkī Books</h1>
<p>${safe}</p>
<p style="font-size:.95rem">If you have an order with us, the link in your email still works.</p>
</main></body></html>`;
}
