import { defineMiddleware } from 'astro:middleware';
import { slugForLegacy } from './lib/db';

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
        /* malformed escape sequence — fall through to the catalogue */
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
