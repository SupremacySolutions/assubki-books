import type { Category } from './db';

/**
 * The trail from the front of the shop to where the reader is standing.
 *
 * Search engines render this in place of a raw URL - "As-Subkī Books ›
 * Syllabus › Dars Nizami" instead of "assubkibooks.co.uk/catalogue/syllabus/..."
 * - and it is how they learn that a shelf sits inside another one rather than
 * being a page that happens to share a word.
 *
 * Built from the path rather than by walking `parent_id`, because the path
 * already encodes the hierarchy and is what the URLs are made of. A segment
 * with no matching shelf is skipped rather than guessed at: a trail that
 * invents a rung is worse than a short one.
 */

export interface Crumb {
  name: string;
  /** Path relative to the catalogue, or null for the page the reader is on. */
  path: string | null;
}

export function shelfTrail(path: string | null, all: Category[]): Crumb[] {
  if (!path) return [];
  const byPath = new Map(all.map((c) => [c.path, c]));
  const parts = path.split('/').filter(Boolean);
  const trail: Crumb[] = [];
  for (let i = 1; i <= parts.length; i++) {
    const found = byPath.get(parts.slice(0, i).join('/'));
    if (found) trail.push({ name: found.name, path: found.path });
  }
  return trail;
}

/**
 * `BreadcrumbList`, as Google reads it.
 *
 * The last rung deliberately carries no `item`. Schema.org allows it and
 * Google's guidance is explicit: the final entry is the current page, and
 * giving it a URL invites the crawler to treat the page as a link to itself.
 */
export function breadcrumbJsonLd(origin: string, crumbs: Crumb[]) {
  if (crumbs.length === 0) return null;

  const rungs: Crumb[] = [{ name: 'Catalogue', path: '' }, ...crumbs];

  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: rungs.map((crumb, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: crumb.name,
      ...(i === rungs.length - 1 || crumb.path === null
        ? {}
        : { item: new URL(`/catalogue${crumb.path ? `/${crumb.path}` : ''}`, origin).toString() }),
    })),
  };
}
