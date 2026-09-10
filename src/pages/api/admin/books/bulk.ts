import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { readForm } from '../../../../lib/request-body';
import { forgetCategoryCounts, forgetHomeRows } from '../../../../lib/db';
import { markManyWaitingDue, drainStockAlerts } from '../../../../lib/stock-alerts';
import type { BookFilter } from '../../../../lib/admin-db';
import {
  BULK_ACTIONS,
  resolveSelection,
  readBefore,
  applyStatus,
  applyAnnounced,
  applyShelf,
  applyStock,
  applyPrice,
  type BulkAction,
  type Applied,
} from '../../../../lib/bulk-edit';
import { record, claim } from '../../../../lib/bulk-undo';
import { restore } from '../../../../lib/book-deletion';

export const prerender = false;

/**
 * Every bulk action on listings, and the undo for all of them.
 *
 * One route dispatching on `action`, the way `books/[id]/set.ts` already
 * multiplexes four. Ten routes would be ten copies of the same selection
 * resolution, the same reserved floor, the same undo record and the same cache
 * invalidation - and the first one to be written differently is the bug.
 */

const NUMBER = (raw: unknown): number | null => {
  const n = Number.parseInt(String(raw ?? ''), 10);
  return Number.isInteger(n) ? n : null;
};

export const POST: APIRoute = async ({ request, locals }) => {
  const form = await readForm(request);
  if (!form) return new Response('Bad request', { status: 400 });

  const url = new URL(request.url);
  const actor = locals.admin?.email ?? null;

  /* Every redirect goes back to the list the owner was looking at, with the
     filters they had on. A bulk action that dumps them at an unfiltered page
     loses the set they spent time narrowing. */
  const back = new URL('/admin/books', url.origin);
  for (const key of ['q', 'filter', 'sort', 'per', 'page'] as const) {
    const value = String(form.get(key) ?? '').trim();
    if (value) back.searchParams.set(key, value);
  }
  const go = (params: Record<string, string>) => {
    for (const [k, v] of Object.entries(params)) back.searchParams.set(k, v);
    return new Response(null, {
      status: 302,
      headers: { Location: back.pathname + back.search },
    });
  };

  const action = String(form.get('action') ?? '') as BulkAction | 'undo';

  // ---------------------------------------------------------------------
  // Undo
  // ---------------------------------------------------------------------
  if (action === 'undo') {
    const taken = await claim(String(form.get('token') ?? ''));
    if (!taken.ok) return go({ undone: taken.why });

    const rows = taken.inverse as Record<string, number | string>[];
    const ids = rows.map((r) => Number(r.id));

    /*
     * A delete is undone by restoring the listing, not by replaying a column.
     *
     * It shares this table so that the owner meets one Undo rather than two,
     * but what "put it back" means is different enough to be its own function -
     * the status has to come from the tombstone and the caches have to be
     * dropped.
     */
    if (taken.action === 'delete') {
      const put = await restore(Number(rows[0]?.id));
      return go({ undone: put ? 'ok' : 'gone', n: put ? '1' : '0' });
    }

    /*
     * Anything since deleted is left where it is rather than dragged back.
     *
     * The owner deleted it after the edit; an undo of an unrelated price change
     * is not permission to undelete. `readBefore` excludes the bin, so those
     * ids simply fall out here and are counted as the difference.
     */
    const alive = await readBefore(ids);
    const aliveIds = new Set(alive.map((b) => b.id));
    const missing = ids.filter((id) => !aliveIds.has(id)).length;

    const statements = [];
    for (const row of rows) {
      const id = Number(row.id);
      if (!aliveIds.has(id)) continue;

      if ('status' in row) {
        statements.push(
          env.DB.prepare(
            `UPDATE books SET status = ?2, updated_at = unixepoch()
              WHERE id = ?1 AND deleted_at IS NULL`,
          ).bind(id, String(row.status)),
        );
      } else if ('price_pence' in row) {
        statements.push(
          env.DB.prepare(
            `UPDATE books SET price_pence = ?2, updated_at = unixepoch()
              WHERE id = ?1 AND deleted_at IS NULL`,
          ).bind(id, Number(row.price_pence)),
        );
      } else if ('stock' in row) {
        // Ledger first, then the value - the same ordering, and the same
        // reason, as the edit this is reversing.
        statements.push(
          env.DB.prepare(
            `INSERT INTO stock_ledger (book_id, delta, field, reason)
             SELECT b.id, MAX(?2, b.reserved) - b.stock, 'stock', ?3
               FROM books b
              WHERE b.id = ?1 AND b.deleted_at IS NULL AND MAX(?2, b.reserved) <> b.stock`,
          ).bind(id, Number(row.stock), `undo: ${taken.summary}`),
          env.DB.prepare(
            `UPDATE books SET stock = MAX(?2, reserved), updated_at = unixepoch()
              WHERE id = ?1 AND deleted_at IS NULL`,
          ).bind(id, Number(row.stock)),
        );
      } else if ('categoryId' in row) {
        // `was: 'off'` means the edit put it on, so the undo takes it off.
        statements.push(
          row.was === 'off'
            ? env.DB.prepare(
                'DELETE FROM book_categories WHERE book_id = ? AND category_id = ?',
              ).bind(id, Number(row.categoryId))
            : env.DB.prepare(
                `INSERT OR IGNORE INTO book_categories (book_id, category_id) VALUES (?, ?)`,
              ).bind(id, Number(row.categoryId)),
        );
      } else {
        statements.push(
          env.DB.prepare(
            `UPDATE books SET announced_by_hand = NULL, updated_at = unixepoch()
              WHERE id = ? AND deleted_at IS NULL`,
          ).bind(id),
        );
      }
    }

    if (statements.length) await env.DB.batch(statements);
    forgetCategoryCounts();
    forgetHomeRows();

    return go({
      undone: missing ? 'partly' : 'ok',
      n: String(alive.length),
      gone: String(missing),
    });
  }

  // ---------------------------------------------------------------------
  // The edits
  // ---------------------------------------------------------------------
  if (!(action in BULK_ACTIONS)) return new Response('Bad request', { status: 400 });

  const scope = String(form.get('scope') ?? 'ids');
  const selection =
    scope === 'filter'
      ? await resolveSelection(
          {
            scope: 'filter',
            expect: NUMBER(form.get('expect')) ?? -1,
            where: {
              q: String(form.get('q') ?? '') || null,
              filter: (String(form.get('filter') ?? 'all') || 'all') as BookFilter,
            },
          },
          action,
        )
      : await resolveSelection(
          { scope: 'ids', ids: form.getAll('id').map((v) => NUMBER(v) ?? 0) },
          action,
        );

  if ('refusal' in selection) return go({ bulk: 'no', why: selection.refusal });

  const before = await readBefore(selection.ids);
  if (!before.length) return go({ bulk: 'no', why: 'none' });

  let applied: Applied;
  switch (action) {
    case 'publish':
      applied = await applyStatus(before, 'live');
      break;
    case 'draft':
      applied = await applyStatus(before, 'draft');
      break;
    case 'archive':
      applied = await applyStatus(before, 'archived');
      break;
    case 'announced':
      applied = await applyAnnounced(before);
      break;
    case 'shelf-add':
    case 'shelf-remove': {
      const shelf = NUMBER(form.get('categoryId'));
      if (!shelf) return go({ bulk: 'no', why: 'badshelf' });
      applied = await applyShelf(before, shelf, action === 'shelf-add' ? 'add' : 'remove');
      break;
    }
    case 'stock-set':
    case 'stock-add': {
      const value = NUMBER(form.get('value'));
      if (value === null) return go({ bulk: 'no', why: 'badnumber' });
      if (action === 'stock-set' && value < 0) return go({ bulk: 'no', why: 'badnumber' });
      applied = await applyStock(
        before,
        action === 'stock-set' ? 'set' : 'add',
        value,
        'bulk edit in portal',
      );
      break;
    }
    case 'price-percent':
    case 'price-fixed': {
      const value = NUMBER(form.get('value'));
      if (value === null) return go({ bulk: 'no', why: 'badnumber' });
      applied = await applyPrice(before, action === 'price-percent' ? 'percent' : 'fixed', value);
      break;
    }
    default:
      return new Response('Bad request', { status: 400 });
  }

  /*
   * Shelf membership and listing status both change what the public shelf
   * counts say; stock and price change what the home rows show. Dropping both
   * caches on every action is a line of code against a minute of the owner
   * looking at their own edit and not seeing it.
   */
  forgetCategoryCounts();
  forgetHomeRows();

  /*
   * Anybody waiting on a title this put back in stock hears once, in one pass.
   *
   * `tellWaiting` in a loop would be one drain per listing - the shape the
   * arrival sweep exists to avoid. Marking due is a single statement and the
   * drain is bounded at twenty, with the quarter-hourly cron collecting the
   * rest.
   */
  if (action === 'stock-set' || action === 'stock-add' || action === 'publish') {
    await markManyWaitingDue(selection.ids);
    await drainStockAlerts(env.DB, url.origin);
  }

  const token = applied.changed
    ? await record(
        action === 'shelf-add' || action === 'shelf-remove'
          ? action
          : action.startsWith('stock')
            ? 'stock'
            : action.startsWith('price')
              ? 'price'
              : action === 'announced'
                ? 'announced'
                : 'status',
        applied.summary,
        actor,
        applied.inverse,
      )
    : null;

  return go({
    bulk: action,
    n: String(applied.changed),
    skipped: String(applied.skippedReserved),
    sets: String(applied.skippedSet),
    clamped: String(applied.clamped),
    ...(token ? { undo: token } : {}),
  });
};
