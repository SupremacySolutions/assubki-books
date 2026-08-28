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

  // One canonical address. Both hostnames reach the Worker, so without this
  // every page would exist at two URLs and each would name itself canonical.
  if (context.url.hostname === 'www.assubkibooks.co.uk') {
    return context.redirect(
      `https://assubkibooks.co.uk${pathname}${context.url.search}`,
      301,
    );
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

  return next();
});
