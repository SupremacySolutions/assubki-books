import type { APIRoute } from 'astro';
import { listBooks } from '../lib/db';
import { salePrice } from '../lib/sales';
import { imageUrl, stripTags, truncate } from '../lib/format';

export const prerender = false;

/**
 * The product feed Google Merchant Center reads.
 *
 * Generated from the database on request, like the sitemap beside it, and
 * pointed at by a scheduled fetch so it can never drift from the shop.
 *
 * **Everything here comes from the same values the book page renders.** A feed
 * that computes its own price or its own availability is the most common way a
 * Merchant Center account is suspended: the crawler compares the two, and a
 * penny of difference is a mismatch. So the price goes through `salePrice`,
 * the same function the card and the page use, and availability is read off
 * the same `available` the page prints.
 *
 * This shop accepts requests and quotes postage before a sale is agreed.
 * Google permits invoicing, but explicitly excludes quote-only websites:
 * https://support.google.com/merchants/answer/10249082
 * Completing this feed does not establish Merchant Center eligibility.
 */
const ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};
const xml = (value: string) => value.replace(/[&<>"']/g, (c) => ESCAPE[c]);

export const GET: APIRoute = async ({ site, url }) => {
  const origin = (site ?? new URL(url.origin)).origin;

  // Every live book. `perPage` is the whole catalogue rather than a page: a
  // feed that stops at 24 tells Google the shop sells 24 books.
  const { books } = await listBooks({ perPage: 1000, withTotal: false, withDetails: true });

  const item = (b: (typeof books)[number]) => {
    // Merchant Center limits IDs to 50 characters. Keep existing short IDs so
    // already imported products retain their history; use the immutable book
    // row ID for longer slugs rather than truncating into possible collisions.
    const merchantId = b.slug.length <= 50 ? b.slug : `asb-${b.id}`;
    const pence = salePrice(b.price_pence, b.sale_percent);
    const description = truncate(stripTags(b.description_html ?? '') || b.title, 4000);
    const imagePath = imageUrl(b.image_key, 'detail');
    const image = imagePath ? new URL(imagePath, origin).toString() : null;

    return [
      '    <item>',
      `      <g:id>${xml(merchantId)}</g:id>`,
      `      <g:title>${xml(truncate(b.title, 150))}</g:title>`,
      `      <g:description>${xml(description)}</g:description>`,
      `      <g:link>${origin}/book/${xml(b.slug)}</g:link>`,
      image ? `      <g:image_link>${xml(image)}</g:image_link>` : '',
      `      <g:availability>${b.available > 0 ? 'in_stock' : 'out_of_stock'}</g:availability>`,
      `      <g:price>${(pence / 100).toFixed(2)} GBP</g:price>`,
      `      <g:condition>new</g:condition>`,
      b.publisher ? `      <g:brand>${xml(b.publisher)}</g:brand>` : '',
      /*
       * Only when it is known. `identifier_exists: no` means "this product has
       * no identifier assigned", which for a published book is untrue and
       * earns a warning - so an unknown ISBN is simply left out.
       */
      b.isbn ? `      <g:gtin>${xml(b.isbn)}</g:gtin>` : '',
      '    </item>',
    ]
      .filter(Boolean)
      .join('\n');
  };

  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">',
    '  <channel>',
    '    <title>As-Subkī Books</title>',
    `    <link>${origin}</link>`,
    '    <description>Classical Arabic texts, Dars Nizami and Maktab syllabus sets.</description>',
    ...books.map(item),
    '  </channel>',
    '</rss>',
  ].join('\n');

  return new Response(body, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      // An hour, matching the sitemap. Merchant Center fetches daily; this is
      // only to stop a crawler pulling the whole catalogue repeatedly.
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
