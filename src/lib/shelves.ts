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

/**
 * Every shelf, with the three counts the portal shows beside it.
 *
 * Two flat reads rolled up here rather than three correlated subqueries per
 * shelf. The `total_books` one in particular re-joined `categories` against
 * `book_categories` once for every row, which cost 23,430 row reads a load -
 * the same shape, and the same mistake, as the category counts that once ate
 * 95% of the daily read budget.
 *
 * Counts every linked book whatever its status, which is what the portal wants:
 * a draft sitting on a shelf is still something the owner put there.
 */
export async function listShelves(): Promise<ShelfRow[]> {
  const [cats, links] = await env.DB.batch([
    env.DB.prepare(
      'SELECT id, slug, name, parent_id, path, sort FROM categories ORDER BY path',
    ),
    env.DB.prepare('SELECT category_id, book_id FROM book_categories'),
  ]);

  const rows = cats.results as Omit<ShelfRow, 'direct_books' | 'total_books' | 'child_count'>[];
  const byId = new Map(rows.map((r) => [r.id, r]));

  const direct = new Map<number, number>();
  const children = new Map<number, number>();
  for (const r of rows) {
    if (r.parent_id) children.set(r.parent_id, (children.get(r.parent_id) ?? 0) + 1);
  }

  // A book counts once for a shelf and once for each shelf above it, however
  // many of that shelf's children it sits on - hence a set per shelf.
  const reach = new Map<string, Set<number>>();
  for (const raw of links.results as { category_id: number; book_id: number }[]) {
    const cat = byId.get(raw.category_id);
    if (!cat) continue;
    direct.set(raw.category_id, (direct.get(raw.category_id) ?? 0) + 1);
    for (let path: string | undefined = cat.path; path; ) {
      let set = reach.get(path);
      if (!set) reach.set(path, (set = new Set()));
      set.add(raw.book_id);
      const cut = path.lastIndexOf('/');
      path = cut > 0 ? path.slice(0, cut) : undefined;
    }
  }
  return rows.map((r) => ({
    ...r,
    direct_books: direct.get(r.id) ?? 0,
    total_books: reach.get(r.path)?.size ?? 0,
    child_count: children.get(r.id) ?? 0,
  })) as ShelfRow[];
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
  const row = await env.DB.prepare(
    'INSERT INTO categories (slug, name, parent_id, sort, path) VALUES (?,?,?,?,?) RETURNING id',
  )
    .bind(slug, name.trim(), parentId, await nextSort(parentId), path)
    .first<{ id: number }>();

  return row!.id;
}

export type ShelfError = 'not-found' | 'cycle' | 'has-books' | 'has-children';

/** Next free position among a parent's children. */
async function nextSort(parentId: number | null): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM categories WHERE parent_id IS ?',
  )
    .bind(parentId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Renumbers a parent's children 0..n in their current display order.
 *
 * The imported shelves all share a position, so "swap with the one above" has
 * nothing to swap against until the row actually holds distinct numbers. This
 * settles them the first time anything is moved.
 */
async function normaliseSiblings(parentId: number | null): Promise<ShelfRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, sort, name FROM categories WHERE parent_id IS ? ORDER BY sort, name`,
  )
    .bind(parentId)
    .all<{ id: number; sort: number; name: string }>();

  const needsWork = results.some((r, i) => r.sort !== i);
  if (needsWork && results.length) {
    await env.DB.batch(
      results.map((r, i) =>
        env.DB.prepare('UPDATE categories SET sort = ? WHERE id = ?').bind(i, r.id),
      ),
    );
  }
  return results.map((r, i) => ({ ...r, sort: i }) as ShelfRow);
}

/** Moves a shelf one place among its siblings. Order is never typed by hand. */
export async function moveShelf(id: number, direction: 'up' | 'down'): Promise<ShelfError | null> {
  const shelf = await env.DB.prepare('SELECT id, parent_id FROM categories WHERE id = ?')
    .bind(id)
    .first<{ id: number; parent_id: number | null }>();
  if (!shelf) return 'not-found';

  const siblings = await normaliseSiblings(shelf.parent_id);
  const index = siblings.findIndex((s) => s.id === id);
  const swapWith = direction === 'up' ? index - 1 : index + 1;
  if (index === -1 || swapWith < 0 || swapWith >= siblings.length) return null; // already at the end

  await env.DB.batch([
    env.DB.prepare('UPDATE categories SET sort = ? WHERE id = ?').bind(swapWith, id),
    env.DB.prepare('UPDATE categories SET sort = ? WHERE id = ?').bind(index, siblings[swapWith].id),
  ]);
  return null;
}

export async function updateShelf(
  id: number,
  name: string,
  parentId: number | null,
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

  // Moving to a different parent puts it at the end of that parent's shelves;
  // keeping its old position would drop it in at an arbitrary point.
  const moved = parentId !== shelf.parent_id;
  const sort = moved ? await nextSort(parentId) : undefined;

  await env.DB.prepare(
    sort === undefined
      ? 'UPDATE categories SET name = ?, slug = ?, parent_id = ? WHERE id = ?'
      : 'UPDATE categories SET name = ?, slug = ?, parent_id = ?, sort = ? WHERE id = ?',
  )
    .bind(...(sort === undefined
      ? [name.trim(), nextSlug, parentId, id]
      : [name.trim(), nextSlug, parentId, sort, id]))
    .run();

  await rebuildPaths(id);
  if (moved) await normaliseSiblings(shelf.parent_id);
  return null;
}

/**
 * Deletes a shelf, and says what it cost.
 *
 * Refusing whenever a shelf held listings made almost every shelf permanently
 * undeletable, which is not a rule so much as a dead end. Nothing here is
 * destructive to a book: listings only lose this one subject, and any shelves
 * underneath move up a level rather than being orphaned. The page states both
 * numbers before asking.
 */
export async function deleteShelf(id: number): Promise<ShelfError | null> {
  const shelf = await env.DB.prepare('SELECT id, parent_id FROM categories WHERE id = ?')
    .bind(id)
    .first<{ id: number; parent_id: number | null }>();
  if (!shelf) return 'not-found';

  const { results: children } = await env.DB.prepare(
    'SELECT id FROM categories WHERE parent_id = ?',
  )
    .bind(id)
    .all<{ id: number }>();

  // Lift the children before the delete, so ON DELETE SET NULL never gets the
  // chance to strand them at the top level by accident.
  if (children.length) {
    await env.DB.batch(
      children.map((c) =>
        env.DB.prepare('UPDATE categories SET parent_id = ? WHERE id = ?').bind(shelf.parent_id, c.id),
      ),
    );
  }

  // book_categories rows cascade, which unfiles the listings without touching
  // the books themselves.
  await env.DB.prepare('DELETE FROM categories WHERE id = ?').bind(id).run();

  for (const child of children) await rebuildPaths(child.id);
  await normaliseSiblings(shelf.parent_id);
  return null;
}
