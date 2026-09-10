import type { APIRoute } from 'astro';
import { readForm } from '../../../../lib/request-body';
import { resolveSelection } from '../../../../lib/bulk-edit';
import { claim } from '../../../../lib/bulk-undo';
import { softDeleteMany, restore } from '../../../../lib/book-deletion';

export const prerender = false;

/**
 * Binning a selection of listings, and the undo for it.
 *
 * One route with two verbs. It was ten wide once - publish, draft, announced,
 * archive, shelf on and off, stock, price - and the multiplexing was there so
 * that ten routes would not each grow their own copy of the selection
 * resolution, the reserved floor and the undo record. Nine of those actions
 * have since been taken out; the shape is kept because `delete` and `undo` are
 * still two things that must agree about the same tombstone, and splitting them
 * is how they would stop agreeing.
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

  const action = String(form.get('action') ?? '');

  // ---------------------------------------------------------------------
  // Undo
  // ---------------------------------------------------------------------
  if (action === 'undo') {
    const taken = await claim(String(form.get('token') ?? ''));
    if (!taken.ok) return go({ undone: taken.why });

    const rows = taken.inverse as Record<string, number | string>[];

    /*
     * Undoing a delete is restoring every listing the tombstone covers.
     *
     * `restore` is per listing because the bin's own Restore button is too, and
     * one of them may fail on its own terms - a listing whose thirty days ran
     * out and was destroyed by the sweep between the delete and the undo is
     * gone for good, and the rest should still come back. So they are counted
     * rather than assumed, and the banner says how many of each.
     */
    let put = 0;
    for (const row of rows) {
      if (await restore(Number(row.id))) put += 1;
    }
    const missing = rows.length - put;

    return go({
      undone: missing ? 'partly' : 'ok',
      n: String(put),
      gone: String(missing),
    });
  }

  // ---------------------------------------------------------------------
  // The delete
  // ---------------------------------------------------------------------
  if (action !== 'delete') return new Response('Bad request', { status: 400 });

  /*
   * Ticked ids only. There is no filter scope to fall back to - see
   * `bulk-edit.ts` for why deleting may not be pointed at a described set - so
   * a form that arrives without ids is refused rather than widened.
   */
  const selection = resolveSelection(form.getAll('id').map((v) => NUMBER(v) ?? 0));
  if ('refusal' in selection) return go({ bulk: 'no', why: selection.refusal });

  const result = await softDeleteMany(selection.ids, actor);
  if (!result.deleted) {
    return go({
      bulk: 'no',
      why: result.held ? 'held' : 'none',
      skipped: String(result.held),
    });
  }

  return go({
    bulk: 'delete',
    n: String(result.deleted),
    skipped: String(result.held),
    gone: String(result.gone),
    orphaned: String(result.orphaned),
    ...(result.token ? { undo: result.token } : {}),
  });
};
