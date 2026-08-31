import { defineMiddleware } from 'astro:middleware';
import { slugForLegacy } from './lib/db';
import { authenticate, adminLocked, passwordFallbackActive } from './lib/admin-auth';

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
  return withSecurityHeaders(response, context.url.protocol === 'https:');
});

/**
 * Headers every response carries. There were none at all.
 *
 * **What `script-src 'unsafe-inline'` costs, said plainly.** Eight pages ship
 * inline scripts - the upload dialog, the order actions, the shelf tree, the
 * structured data - so a policy without it would break the portal, and a
 * broken policy gets removed rather than fixed. That means this CSP does *not*
 * stop injected inline script, which is the thing a CSP is best known for.
 *
 * It is still worth having for the parts that do bite:
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
 * Moving to nonces would let `unsafe-inline` go, and is the obvious next step
 * if this is ever tightened.
 */
function withSecurityHeaders(response: Response, secure: boolean): Response {
  // Astro returns immutable responses for some routes; cloning the headers is
  // the only way to add to them without throwing.
  const headers = new Headers(response.headers);

  headers.set(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
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
