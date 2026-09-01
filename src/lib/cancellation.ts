/**
 * Who may cancel an order, and what happens when they do.
 *
 * The line falls where the shop sends payment details. Before that the
 * customer owes nothing and nothing has been arranged, so the decision is
 * theirs and the copies go straight back on the shelf. After it the owner has
 * quoted a total and set books aside, so cancelling becomes a conversation -
 * the order stays exactly as it is until they answer.
 *
 * Kept beside the status model rather than in the route, because the customer
 * page, the API and the portal all have to agree about which of the three it
 * is, and three copies of that rule is how they stop agreeing.
 */
export type CancelRight = 'outright' | 'ask' | 'none';

export function cancelRight(status: string, alreadyAsked = false): CancelRight {
  if (alreadyAsked) return 'none';
  if (status === 'requested') return 'outright';
  if (['awaiting_payment', 'paid', 'dispatched'].includes(status)) return 'ask';
  // completed, cancelled, expired - there is nothing left to cancel.
  return 'none';
}

/** The most a customer may write about why. Long enough to explain, not to vent. */
export const REASON_MAX = 600;
