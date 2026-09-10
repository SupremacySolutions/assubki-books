/**
 * Acting on many listings at once.
 *
 * The portal's filters already do the hard part - "no subject", "not
 * announced", "drafts" isolate exactly the set the owner means - and then every
 * change had to be made one row at a time. This is the other half of that.
 *
 * Three rules run through all of it:
 *
 * **Nothing here loops.** Every action is one or two statements over a bound
 * JSON array of ids, the way `releaseOrders` does it. D1 refuses a statement
 * with more than a hundred bound parameters, so building `IN (?,?,?…)` from a
 * selection would work on a page of forty and throw on a selection of two
 * hundred - which is precisely when the owner most wants it.
 *
 * **Nothing is silently skipped.** A listing left out because copies are
 * promised to an open order, or because it is part of a set, or a stock figure
 * bent up to the reserved floor, is counted and said out loud. A bulk action
 * that quietly does less than it claims is worse than one that refuses.
 *
 * **Everything records its inverse** before it runs, through `bulk-undo`. That
 * is what makes acting on two hundred listings a reasonable thing to offer at
 * all.
 */

import { env } from 'cloudflare:workers';
import { bookIdsMatching, type BookScope } from './admin-db';

/** Above this, a filter-scoped action refuses rather than guesses. */
export const SCOPE_CAP = 1000;

export type BulkAction =
  | 'publish'
  | 'draft'
  | 'archive'
  | 'announced'
  | 'shelf-add'
  | 'shelf-remove'
  | 'stock-set'
  | 'stock-add'
  | 'price-percent'
  | 'price-fixed';

interface ActionSpec {
  label: string;
  /** Takes a listing off the shop, so it may never run on a described set. */
  destructive: boolean;
}

/**
 * What each action is called and whether it may be aimed at a filter.
 *
 * Only `archive` is barred from filter scope, and the reason is worth stating:
 * everything else here is reversible through the undo record, but archiving
 * takes listings out of the shop, and a set the owner described rather than
 * looked at is the wrong thing to point that at. Publishing is not destructive
 * in the same way - a listing wrongly made live is visible and fixable.
 */
export const BULK_ACTIONS: Record<BulkAction, ActionSpec> = {
  publish: { label: 'Publish', destructive: false },
  draft: { label: 'Make draft', destructive: false },
  archive: { label: 'Archive', destructive: true },
  announced: { label: 'Mark announced', destructive: false },
  'shelf-add': { label: 'Add to shelf', destructive: false },
  'shelf-remove': { label: 'Take off shelf', destructive: false },
  'stock-set': { label: 'Set stock to', destructive: false },
  'stock-add': { label: 'Change stock by', destructive: false },
  'price-percent': { label: 'Change price by %', destructive: false },
  'price-fixed': { label: 'Change price by', destructive: false },
};

/** Every word this feature says, so the wording and the rule cannot drift. */
export const BULK = {
  moved: 'The list changed while you were choosing, so nothing was done. Look again.',
  none: 'Nothing was selected.',
  tooMany: (n: number) =>
    `That is ${n} listings, which is more than one action should quietly change. ` +
    `Narrow it down first.`,
  notForFilter:
    'Archiving has to be pointed at listings you have ticked, not at a filter. ' +
    'Tick the ones you mean.',
  badShelf: 'Choose a shelf first.',
  badNumber: 'That is not a number this can use.',
  done: (verb: string, n: number) => `${verb} ${n} listing${n === 1 ? '' : 's'}.`,
  skippedReserved: (n: number) =>
    `${n} left alone - copies are promised to an open order.`,
  skippedSet: (n: number) =>
    `${n} left alone - they are part of a set, and are published with it.`,
  clamped: (n: number) =>
    `${n} kept a higher stock count than you asked for, because copies are promised to an open order.`,
  undone: 'Put back as it was.',
  undonePartly: (n: number, gone: number) =>
    `Put ${n} back. ${gone} could not be - they have been deleted since.`,
  undoSpent: 'That has already been undone.',
  undoExpired: 'That change is more than a day old, so it can no longer be undone here.',
  undoUnknown: 'There is nothing to undo.',
} as const;

export type Refusal = 'moved' | 'none' | 'toomany' | 'notforfilter';

/**
 * Works out which listings an action is aimed at.
 *
 * Two ways in. Ticked ids are taken as they are. A filter scope is re-resolved
 * here from the same `bookListWhere` the page itself used, and checked against
 * the count the page displayed: if the two disagree, something changed between
 * the page rendering and the button being pressed, and the action refuses
 * rather than acting on a set the owner never saw. That one rule covers a stale
 * tab, a second window, and the expiry sweep landing in between.
 */
export async function resolveSelection(
  input:
    | { scope: 'ids'; ids: number[] }
    | { scope: 'filter'; expect: number; where: BookScope },
  action: BulkAction,
): Promise<{ ids: number[] } | { refusal: Refusal }> {
  if (input.scope === 'ids') {
    const ids = [...new Set(input.ids)].filter((n) => Number.isInteger(n) && n > 0);
    if (!ids.length) return { refusal: 'none' };
    if (ids.length > SCOPE_CAP) return { refusal: 'toomany' };
    return { ids };
  }

  if (BULK_ACTIONS[action].destructive) return { refusal: 'notforfilter' };

  const ids = await bookIdsMatching(input.where, SCOPE_CAP);
  if (ids.length > SCOPE_CAP) return { refusal: 'toomany' };

  /*
   * The count is checked before the emptiness, and the order matters.
   *
   * A filter that matched forty listings when the page rendered and matches
   * none now has *moved* - somebody published them, or the sweep ran. Reporting
   * that as "nothing was selected" would tell the owner they had made a mistake
   * with the mouse when what actually happened is that the shop changed under
   * them. Only a scope that expected nothing and found nothing is empty.
   */
  if (ids.length !== input.expect) return { refusal: 'moved' };
  if (!ids.length) return { refusal: 'none' };
  return { ids };
}

/** Bound once as JSON, so the count of ids has nothing to do with parameters. */
const asJson = (ids: number[]) => JSON.stringify(ids);

/** The rows an action is really allowed to touch, and what they look like now. */
export interface Before {
  id: number;
  status: string;
  stock: number;
  reserved: number;
  price_pence: number;
  set_id: number | null;
  announced_by_hand: number | null;
}

export async function readBefore(ids: number[]): Promise<Before[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, status, stock, reserved, price_pence, set_id, announced_by_hand
       FROM books
      WHERE id IN (SELECT value FROM json_each(?1))
        AND shipment_id IS NULL AND deleted_at IS NULL`,
  )
    .bind(asJson(ids))
    .all<Before>();
  return results;
}

export interface Applied {
  changed: number;
  skippedReserved: number;
  skippedSet: number;
  clamped: number;
  /** Per-book prior values, for the undo record. */
  inverse: unknown[];
  summary: string;
}

/**
 * Status changes.
 *
 * Set members are skipped rather than changed. A part listing going live
 * independently of the set it belongs to is the bug `set.ts`'s unsplit path is
 * written to avoid, and a bulk publish that reached them would reintroduce it
 * two hundred listings at a time. Archiving additionally refuses anything
 * holding copies for an open order, for the reason deleting does.
 */
export async function applyStatus(
  before: Before[],
  status: 'live' | 'draft' | 'archived',
): Promise<Applied> {
  const sets = before.filter((b) => b.set_id !== null);
  const held = status === 'archived' ? before.filter((b) => !b.set_id && b.reserved > 0) : [];
  const doing = before.filter(
    (b) => !b.set_id && !(status === 'archived' && b.reserved > 0) && b.status !== status,
  );

  if (doing.length) {
    await env.DB.prepare(
      `UPDATE books SET status = ?2, updated_at = unixepoch()
        WHERE id IN (SELECT value FROM json_each(?1))
          AND shipment_id IS NULL AND deleted_at IS NULL`,
    )
      .bind(asJson(doing.map((b) => b.id)), status)
      .run();
  }

  const verb = status === 'live' ? 'Published' : status === 'draft' ? 'Made drafts of' : 'Archived';
  return {
    changed: doing.length,
    skippedReserved: held.length,
    skippedSet: sets.length,
    clamped: 0,
    inverse: doing.map((b) => ({ id: b.id, status: b.status })),
    summary: BULK.done(verb, doing.length).replace(/\.$/, ''),
  };
}

/**
 * "I posted these in the channel myself."
 *
 * Writes a column and makes no outbound call. Posting N announcements from one
 * request is the shape the arrival-notice sweep exists to avoid, and this action
 * does not mean "post these" in any case - it means "stop listing these as
 * unannounced, I have dealt with them."
 */
export async function applyAnnounced(before: Before[]): Promise<Applied> {
  const doing = before.filter((b) => !b.announced_by_hand);
  if (doing.length) {
    await env.DB.prepare(
      `UPDATE books SET announced_by_hand = unixepoch(), updated_at = unixepoch()
        WHERE id IN (SELECT value FROM json_each(?1))
          AND shipment_id IS NULL AND deleted_at IS NULL`,
    )
      .bind(asJson(doing.map((b) => b.id)))
      .run();
  }
  return {
    changed: doing.length,
    skippedReserved: 0,
    skippedSet: 0,
    clamped: 0,
    inverse: doing.map((b) => ({ id: b.id })),
    summary: `Marked ${doing.length} as announced`,
  };
}

/**
 * Adding to or taking off a shelf.
 *
 * `INSERT OR IGNORE` and a targeted `DELETE`, never the delete-then-reinsert
 * that `books/save.ts` does. That path replaces a listing's whole membership,
 * which is right when a form has just submitted every shelf it should have and
 * catastrophic here: adding two hundred listings to "Fiqh" would strip every
 * other shelf off all two hundred.
 *
 * The real delta is read first so the count reported is what actually changed
 * rather than what was asked for, and so the undo puts back only what this
 * touched - a listing already on the shelf must not be taken off it by an undo.
 */
export async function applyShelf(
  before: Before[],
  categoryId: number,
  direction: 'add' | 'remove',
): Promise<Applied> {
  const ids = before.map((b) => b.id);
  const { results: existing } = await env.DB.prepare(
    `SELECT book_id FROM book_categories
      WHERE category_id = ?2 AND book_id IN (SELECT value FROM json_each(?1))`,
  )
    .bind(asJson(ids), categoryId)
    .all<{ book_id: number }>();

  const on = new Set(existing.map((r) => r.book_id));
  const doing = direction === 'add' ? ids.filter((id) => !on.has(id)) : ids.filter((id) => on.has(id));

  if (doing.length) {
    await env.DB.prepare(
      direction === 'add'
        ? `INSERT OR IGNORE INTO book_categories (book_id, category_id)
           SELECT value, ?2 FROM json_each(?1)`
        : `DELETE FROM book_categories
            WHERE category_id = ?2 AND book_id IN (SELECT value FROM json_each(?1))`,
    )
      .bind(asJson(doing), categoryId)
      .run();
  }

  return {
    changed: doing.length,
    skippedReserved: 0,
    skippedSet: 0,
    clamped: 0,
    inverse: doing.map((id) => ({ id, categoryId, was: direction === 'add' ? 'off' : 'on' })),
    summary: `${direction === 'add' ? 'Added' : 'Took'} ${doing.length} ${
      direction === 'add' ? 'to a shelf' : 'off a shelf'
    }`,
  };
}

/**
 * Stock, set outright or moved by a delta.
 *
 * **The ledger row is written before the update, and that ordering is
 * load-bearing.** D1 runs a batch in order inside one transaction, so an
 * `INSERT … SELECT` that computes its delta from `books.stock` after the UPDATE
 * has run computes every delta as zero. The ledger would then look perfectly
 * healthy while recording nothing at all - a failure invisible until somebody
 * asks where a copy went, months later.
 *
 * Clamping to the reserved floor rather than refusing matches `setStock`, which
 * has always bent the number rather than rejecting the edit; refusing here would
 * leave a batch half applied.
 */
export async function applyStock(
  before: Before[],
  mode: 'set' | 'add',
  value: number,
  reason: string,
): Promise<Applied> {
  const target = (b: Before) => Math.max(mode === 'set' ? value : b.stock + value, b.reserved);
  const doing = before.filter((b) => target(b) !== b.stock);
  const clamped = before.filter(
    (b) => (mode === 'set' ? value : b.stock + value) < b.reserved,
  ).length;

  if (doing.length) {
    const ids = asJson(doing.map((b) => b.id));
    const expr = mode === 'set' ? 'MAX(?2, b.reserved)' : 'MAX(b.stock + ?2, b.reserved)';
    await env.DB.batch([
      // First: the movement, computed from the stock as it stands.
      env.DB.prepare(
        `INSERT INTO stock_ledger (book_id, delta, field, reason)
         SELECT b.id, ${expr} - b.stock, 'stock', ?3
           FROM books b
          WHERE b.id IN (SELECT value FROM json_each(?1))
            AND b.shipment_id IS NULL AND b.deleted_at IS NULL
            AND ${expr} <> b.stock`,
      ).bind(ids, value, reason),
      env.DB.prepare(
        `UPDATE books SET stock = ${expr.replace(/b\./g, '')}, updated_at = unixepoch()
          WHERE id IN (SELECT value FROM json_each(?1))
            AND shipment_id IS NULL AND deleted_at IS NULL`,
      ).bind(ids, value),
    ]);
  }

  return {
    changed: doing.length,
    skippedReserved: 0,
    skippedSet: 0,
    clamped,
    inverse: doing.map((b) => ({ id: b.id, stock: b.stock })),
    summary:
      mode === 'set'
        ? `Set ${doing.length} to ${value} in stock`
        : `Moved stock by ${value > 0 ? '+' : ''}${value} on ${doing.length}`,
  };
}

/**
 * Price, by percentage or by a fixed number of pence.
 *
 * Rounding lives in the one expression rather than in JavaScript, so the figure
 * the database holds is the figure this decided. Never below zero: a percentage
 * of -150 is a mistake, not a refund.
 */
export async function applyPrice(
  before: Before[],
  mode: 'percent' | 'fixed',
  value: number,
): Promise<Applied> {
  const next = (b: Before) =>
    Math.max(
      0,
      mode === 'percent'
        ? Math.round(b.price_pence * (1 + value / 100))
        : b.price_pence + value,
    );
  const doing = before.filter((b) => next(b) !== b.price_pence);

  if (doing.length) {
    const expr =
      mode === 'percent'
        ? 'MAX(0, CAST(ROUND(price_pence * (1 + ?2 / 100.0)) AS INTEGER))'
        : 'MAX(0, price_pence + ?2)';
    await env.DB.prepare(
      `UPDATE books SET price_pence = ${expr}, updated_at = unixepoch()
        WHERE id IN (SELECT value FROM json_each(?1))
          AND shipment_id IS NULL AND deleted_at IS NULL`,
    )
      .bind(asJson(doing.map((b) => b.id)), value)
      .run();
  }

  return {
    changed: doing.length,
    skippedReserved: 0,
    skippedSet: 0,
    clamped: 0,
    inverse: doing.map((b) => ({ id: b.id, price_pence: b.price_pence })),
    summary:
      mode === 'percent'
        ? `Changed ${doing.length} prices by ${value > 0 ? '+' : ''}${value}%`
        : `Changed ${doing.length} prices by ${value > 0 ? '+' : ''}${value}p`,
  };
}
