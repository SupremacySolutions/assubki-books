/**
 * Shared transform layer for the WooCommerce import.
 *
 * Both the SQL seed generator and the image fetcher use this, so that the
 * slugs they derive — and therefore the R2 keys they agree on — cannot drift
 * apart. Change slug generation here and both stay consistent.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RAW = join(ROOT, 'data', 'raw');

/** Arabic, Arabic Supplement, Extended-A, and the presentation forms blocks. */
const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘',
  rdquo: '”', ldquo: '“', middot: '·', times: '×',
};

export function decodeEntities(str) {
  if (!str) return '';
  return str
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

/**
 * WooCommerce stores both scripts in one `name` field, e.g.
 * "al Nahw al Wadih النحو الواضح". Split them so each can be rendered with the
 * right font and `dir` — the old WordPress theme ran them together.
 */
export function splitTitle(name) {
  const clean = decodeEntities(name).replace(/\s+/g, ' ').trim();
  const latin = [];
  const arabic = [];

  for (const token of clean.split(' ')) {
    (ARABIC.test(token) ? arabic : latin).push(token);
  }

  const title = latin.join(' ').replace(/\s*[-–—:,]\s*$/, '').trim();
  const titleAr = arabic.join(' ').trim();

  // A handful of books are titled only in Arabic. `books.title` is NOT NULL and
  // is what the UI leads with, so fall back to the Arabic rather than emitting
  // an empty string.
  return { title: title || titleAr, titleAr: titleAr || null };
}

/** Latin slug: strip diacritics (ḥ → h), collapse to hyphens, cap the length. */
export function slugify(str) {
  const base = decodeEntities(str)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')      // combining marks
    .replace(/[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70)
    .replace(/-+$/, '');
  return base;
}

/**
 * Keep a small, safe subset of HTML. Everything not on the allowlist is
 * unwrapped rather than dropped, which is what rescues the six descriptions
 * that arrived wrapped in pasted ChatGPT `<div>`/`<section>` scaffolding — the
 * prose inside them is real copy worth keeping.
 */
const ALLOWED = new Set(['p', 'br', 'strong', 'b', 'em', 'i', 'ul', 'ol', 'li', 'h3', 'h4', 'blockquote', 'a']);

export function sanitizeHtml(html) {
  if (!html) return null;

  let out = html
    // Drop these outright, contents included.
    .replace(/<(script|style|iframe|noscript)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  out = out.replace(/<\/?([a-z0-9]+)([^>]*)>/gi, (match, tagRaw, attrs) => {
    const tag = tagRaw.toLowerCase();
    if (!ALLOWED.has(tag)) return ' ';           // unwrap: keep the text, lose the tag
    if (match.startsWith('</')) return `</${tag}>`;
    if (tag === 'br') return '<br>';
    if (tag === 'a') {
      const href = /href\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
      // Only http(s) — no javascript: or data: URLs.
      if (!href || !/^https?:\/\//i.test(href)) return '';
      return `<a href="${href.replace(/"/g, '&quot;')}" rel="noopener nofollow">`;
    }
    return `<${tag}>`;                            // strip all other attributes
  });

  out = out
    .replace(/(&nbsp;| )/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/(<p>\s*<\/p>)+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // If unwrapping left bare prose with no block tag, give it one.
  if (out && !/^<(p|ul|ol|h3|h4|blockquote)/i.test(out)) out = `<p>${out}</p>`;

  return out || null;
}

export function loadRaw() {
  const products = [];
  for (const page of ['p1', 'p2', 'p3']) {
    products.push(...JSON.parse(readFileSync(join(RAW, `${page}.json`), 'utf8')));
  }
  const categories = JSON.parse(readFileSync(join(RAW, 'categories.json'), 'utf8'));
  return { products, categories };
}

/** Categories with a resolved parent chain, so /catalogue/<path> is one lookup. */
export function buildCategories(raw) {
  const byId = new Map(raw.map((c) => [c.id, c]));

  const pathOf = (cat, seen = new Set()) => {
    if (seen.has(cat.id)) return cat.slug;       // guard against a cyclic parent
    seen.add(cat.id);
    const parent = cat.parent ? byId.get(cat.parent) : null;
    return parent ? `${pathOf(parent, seen)}/${cat.slug}` : cat.slug;
  };

  return raw
    .map((c) => ({
      id: c.id,
      slug: c.slug,
      name: decodeEntities(c.name),
      parentId: c.parent || null,
      path: pathOf(c),
      count: c.count,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function buildBooks(products) {
  const usedSlugs = new Set();

  return products.map((p) => {
    const { title, titleAr } = splitTitle(p.name);

    let slug = slugify(title);
    if (!slug) slug = `book-${p.id}`;            // Arabic-only titles
    if (usedSlugs.has(slug)) {
      let n = 2;
      while (usedSlugs.has(`${slug}-${n}`)) n++;
      slug = `${slug}-${n}`;
    }
    usedSlugs.add(slug);

    // Woo publishes price in minor units already ("600" = £6.00).
    const pricePence = Number.parseInt(p.prices?.price ?? '0', 10) || 0;

    // Woo mostly hides quantities, but 18 products leak a real count through
    // stock_availability.text ("60 in stock") — worth recovering rather than
    // flattening everything to a boolean.
    //
    // Where the count is genuinely unknown we seed DEFAULT_STOCK rather than 1.
    // Seeding 1 would render "Only 1 left" across the whole shop, which claims
    // scarcity the source never asserted; "in stock" is exactly what Woo said.
    // The owner replaces these with real numbers in the admin panel.
    const DEFAULT_STOCK = 3;
    const explicit = /^(\d+)\s+in stock$/i.exec((p.stock_availability?.text ?? '').trim());
    const stock = p.is_in_stock ? (explicit ? Number(explicit[1]) : DEFAULT_STOCK) : 0;

    // A directory per book, not "<slug>-<n>.webp". Flat numbering collides:
    // the second image of "usul-al-shashi" and the first image of the book
    // deduped to slug "usul-al-shashi-2" both want "usul-al-shashi-2.webp".
    // Slugs are unique, so a slug-named directory cannot collide.
    const images = (p.images ?? []).map((img, i) => ({
      src: img.src,
      key: `books/${slug}/${i + 1}.webp`,
      alt: decodeEntities(img.alt || '') || title,
      sort: i,
    }));

    return {
      wcId: p.id,
      slug,
      legacySlug: p.slug,
      title,
      titleAr,
      descriptionHtml: sanitizeHtml(p.description),
      pricePence,
      stock,
      categoryIds: (p.categories ?? []).map((c) => c.id),
      images,
    };
  });
}

/** SQL string literal with single quotes doubled; NULL for null/undefined. */
export function sql(value) {
  if (value === null || value === undefined || value === '') return 'NULL';
  if (typeof value === 'number') return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}
