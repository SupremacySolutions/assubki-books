/**
 * Deleting a selection of listings.
 *
 * The portal's filters already do the hard part - "no subject", "not
 * announced", "drafts" isolate exactly the set the owner means - and the bin on
 * each row clears them one at a time. This is the other half: tick several and
 * bin them together.
 *
 * This was ten actions wide once. Publish, draft, mark announced, archive,
 * shelf on and off, stock set and add, price by percent and by pence - all
 * built, all shipped, all taken out again. The filters that fed them were the
 * useful part; a toolbar of ten buttons above a list of two hundred was mostly
 * new ways to be wrong at scale. What is left is the one that earned its place.
 *
 * Three rules survive from that, and still hold:
 *
 * **Nothing loops in SQL.** The selection travels as one bound JSON array,
 * because D1 refuses a statement carrying more than a hundred bound parameters,
 * and a selection of a hundred listings is exactly when this is worth having.
 *
 * **Nothing is silently skipped.** A listing left where it is because copies are
 * promised to an open order is counted and said out loud. A bulk action that
 * quietly does less than it claims is worse than one that refuses outright.
 *
 * **Only listings that were ticked.** There is deliberately no filter scope.
 * Filter scope existed for the actions that could be put back in place by
 * replaying a column; deleting is not one of those. When there were ten
 * actions, `archive` alone was barred from it, on the grounds that taking
 * listings out of the shop should not be pointed at a set the owner described
 * rather than looked at. The only action left is more destructive than
 * archiving, so that bar now covers everything and the scope is gone with it.
 */

/**
 * The most listings one press may bin.
 *
 * Lower than the thousand a filter scope used to allow, and the reason is the
 * Telegram fan-out rather than the SQL: the announcement has to come down as
 * the listing goes, one API call per message, and an album is one message per
 * photograph. A hundred listings is already a plausible several hundred calls
 * against a Worker's subrequest budget and Telegram's own rate limit, which is
 * why `softDeleteMany` spends that budget explicitly and reports what it could
 * not reach. Past a hundred the honest answer is to narrow the filter.
 */
export const SELECTION_CAP = 100;

/** Every word this feature says, so the wording and the rule cannot drift. */
export const BULK = {
  none: 'Nothing was selected.',
  tooMany: (n: number) =>
    `That is ${n} listings, which is more than one press should bin at once. ` +
    `Narrow it down first.`,
  done: (n: number) => `Deleted ${n} listing${n === 1 ? '' : 's'}.`,
  skippedReserved: (n: number) =>
    `${n} left alone - copies are promised to an open order.`,
  skippedGone: (n: number) =>
    `${n} left alone - they had already gone.`,
  /* The channel post is gone whatever happens next, so the owner is told once,
     plainly, rather than discovering it later. Same promise as the single
     delete's `DELETION.orphaned`, said for a batch. */
  orphaned: (n: number) =>
    `${n} still have a post in the channel that could not be removed. ` +
    `Take those down in Telegram by hand.`,
  undone: (n: number) => `Put ${n} listing${n === 1 ? '' : 's'} back.`,
  undonePartly: (n: number, gone: number) =>
    `Put ${n} back. ${gone} could not be - they have been destroyed since.`,
  undoSpent: 'That has already been undone.',
  undoExpired: 'That change is more than a day old, so it can no longer be undone here.',
  undoUnknown: 'There is nothing to undo.',
} as const;

export type Refusal = 'none' | 'toomany';

/**
 * Works out which listings the delete is aimed at.
 *
 * One way in now: the ids that were ticked. They are deduplicated and sanity
 * checked here rather than trusted, because they arrive from a form and a
 * repeated or malformed id would otherwise reach the count the owner is shown.
 *
 * There is no re-resolution against the filter and so no "the list moved"
 * refusal to make: the owner ticked particular rows, and those ids mean the
 * same thing whatever the filter matches by the time the button is pressed.
 * A listing that has gone in the meantime falls out in `softDeleteMany` and is
 * counted there.
 */
export function resolveSelection(ids: number[]): { ids: number[] } | { refusal: Refusal } {
  const clean = [...new Set(ids)].filter((n) => Number.isInteger(n) && n > 0);
  if (!clean.length) return { refusal: 'none' };
  if (clean.length > SELECTION_CAP) return { refusal: 'toomany' };
  return { ids: clean };
}
