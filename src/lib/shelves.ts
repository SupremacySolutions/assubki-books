/**
 * Shelf (category) management.
 *
 * `categories.path` is denormalised - "syllabus/dars-nizami" - so the public
 * catalogue can resolve a URL in one lookup instead of walking parents on every
 * request. The cost is that renaming or moving a shelf invalidates the path of
 * every shelf beneath it, so any write that touches a slug or a parent has to
 * rebuild that subtree. Doing it in a single batch keeps the tree from being
 * half-updated if something fails partway.
 */

import { env } from 'cloudflare:workers';

export interface ShelfRow {
  id: number;
  slug: string;
  name: string;
  parent_id: number | null;
  path: string;
  sort: number;
  direct_books: number;
  total_books: number;
  child_count: number;
}

export function slugifyShelf(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '');
}

export async function listShelves(): Promise<ShelfRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.slug, c.name, c.parent_id, c.path, c.sort,
            (SELECT COUNT(*) FROM book_categories WHERE category_id = c.id) AS direct_books,
            (SELECT COUNT(DISTINCT bc.book_id)
               FROM categories d
               JOIN book_categories bc ON bc.category_id = d.id
              WHERE d.path = c.path OR d.path LIKE c.path || '/%') AS total_books,
            (SELECT COUNT(*) FROM categories WHERE parent_id = c.id) AS child_count
       FROM categories c
      ORDER BY c.path`,
  ).all<ShelfRow>();
  return results;
}

export interface ShelfNode extends ShelfRow {
  children: ShelfNode[];
}

export async function shelfTree(): Promise<ShelfNode[]> {
  const rows = await listShelves();
  const nodes = new Map(rows.map((r) => [r.id, { ...r, children: [] as ShelfNode[] }]));
  const roots: ShelfNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parent_id ? nodes.get(node.parent_id) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const bySort = (a: ShelfNode, b: ShelfNode) => a.sort - b.sort || a.name.localeCompare(b.name);
  const sortAll = (list: ShelfNode[]): ShelfNode[] =>
    list.sort(bySort).map((n) => ({ ...n, children: sortAll(n.children) }));
  return sortAll(roots);
}

/** Slugs are unique across all shelves, since the path is built from them. */
async function uniqueSlug(base: string, excludeId: number | null): Promise<string> {
  let candidate = base || 'shelf';
  for (let n = 1; n < 60; n++) {
    const clash = await env.DB.prepare(
      'SELECT id FROM categories WHERE slug = ? AND (?2 IS NULL OR id != ?2)',
    )
      .bind(candidate, excludeId)
      .first<{ id: number }>();
    if (!clash) return candidate;
    candidate = `${base}-${n + 1}`;
  }
  return `${base}-${Date.now()}`;
}

/**
 * Rebuilds `path` for a shelf and everything under it. Called after any change
 * to a slug or a parent, since both feed the path of every descendant.
 */
async function rebuildPaths(rootId: number): Promise<void> {
  const { results: all } = await env.DB.prepare(
    'SELECT id, slug, parent_id FROM categories',
  ).all<{ id: number; slug: string; parent_id: number | null }>();

  const byId = new Map(all.map((c) => [c.id, c]));
  const childrenOf = new Map<number | null, typeof all>();
  for (const c of all) {
    const list = childrenOf.get(c.parent_id) ?? [];
    list.push(c);
    childrenOf.set(c.parent_id, list);
  }

  const pathOf = (id: number): string => {
    const parts: string[] = [];
    let cursor = byId.get(id);
    const seen = new Set<number>();
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      parts.unshift(cursor.slug);
      cursor = cursor.parent_id ? byId.get(cursor.parent_id) : undefined;
    }
    return parts.join('/');
  };

  const updates: { id: number; path: string }[] = [];
  const walk = (id: number) => {
    updates.push({ id, path: pathOf(id) });
    for (const child of childrenOf.get(id) ?? []) walk(child.id);
  };
  walk(rootId);

  await env.DB.batch(
    updates.map((u) =>
      env.DB.prepare('UPDATE categories SET path = ? WHERE id = ?').bind(u.path, u.id),
    ),
  );
}

export async function createShelf(name: string, parentId: number | null): Promise<number> {
  const slug = await uniqueSlug(slugifyShelf(name), null);
  const parent = parentId
    ? await env.DB.prepare('SELECT path FROM categories WHERE id = ?')
        .bind(parentId)
        .first<{ path: string }>()
    : null;

  const path = parent ? `${parent.path}/${slug}` : slug;
  const nextSort = await env.DB.prepare(
    'SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM categories WHERE parent_id IS ?',
  )
    .bind(parentId)
    .first<{ n: number }>();

  const row = await env.DB.prepare(
    'INSERT INTO categories (slug, name, parent_id, sort, path) VALUES (?,?,?,?,?) RETURNING id',
  )
    .bind(slug, name.trim(), parentId, nextSort?.n ?? 0, path)
    .first<{ id: number }>();

  return row!.id;
}

export type ShelfError = 'not-found' | 'cycle' | 'has-books' | 'has-children';

export async function updateShelf(
  id: number,
  name: string,
  parentId: number | null,
  sort: number,
): Promise<ShelfError | null> {
  const shelf = await env.DB.prepare('SELECT id, slug, name, parent_id FROM categories WHERE id = ?')
    .bind(id)
    .first<{ id: number; slug: string; name: string; parent_id: number | null }>();
  if (!shelf) return 'not-found';

  // A shelf cannot be moved inside itself or its own descendants: the path
  // walk would never terminate and the tree would detach from the roots.
  if (parentId !== null) {
    if (parentId === id) return 'cycle';
    const { results: all } = await env.DB.prepare(
      'SELECT id, parent_id FROM categories',
    ).all<{ id: number; parent_id: number | null }>();
    const parents = new Map(all.map((c) => [c.id, c.parent_id]));
    let cursor: number | null = parentId;
    const seen = new Set<number>();
    while (cursor !== null && !seen.has(cursor)) {
      if (cursor === id) return 'cycle';
      seen.add(cursor);
      cursor = parents.get(cursor) ?? null;
    }
  }

  // Renaming re-slugs, which is what makes a tidy URL follow a tidy name.
  const nextSlug =
    name.trim() !== shelf.name ? await uniqueSlug(slugifyShelf(name), id) : shelf.slug;

  await env.DB.prepare(
    'UPDATE categories SET name = ?, slug = ?, parent_id = ?, sort = ? WHERE id = ?',
  )
    .bind(name.trim(), nextSlug, parentId, sort, id)
    .run();

  await rebuildPaths(id);
  return null;
}

export async function deleteShelf(id: number): Promise<ShelfError | null> {
  const shelf = await env.DB.prepare(
    `SELECT c.id,
            (SELECT COUNT(*) FROM book_categories WHERE category_id = c.id) AS books,
            (SELECT COUNT(*) FROM categories WHERE parent_id = c.id) AS children
       FROM categories c WHERE c.id = ?`,
  )
    .bind(id)
    .first<{ id: number; books: number; children: number }>();

  if (!shelf) return 'not-found';
  // Deleting either would silently strip listings of their subject or orphan a
  // whole branch of the tree. Both are the owner's call to make explicitly.
  if (shelf.children > 0) return 'has-children';
  if (shelf.books > 0) return 'has-books';

  await env.DB.prepare('DELETE FROM categories WHERE id = ?').bind(id).run();
  return null;
}
