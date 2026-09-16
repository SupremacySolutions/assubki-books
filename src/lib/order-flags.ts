/**
 * The live conditions on an order, in the order they matter.
 *
 * The portal's order page used to append a full-width card per condition, and
 * in a bad afternoon it stacked four: a lapsed hold, a sibling-orders notice,
 * the result of the last save and a cancellation the customer had asked for.
 * The owner scrolled past the lot to find out what to do next.
 *
 * Nothing is dropped. This only ranks them, so the page can put the most
 * pressing one in a single strip under the action bar and leave the rest as
 * ordinary panels in the left pane. The ranking is the one the owner works to:
 *
 *   a hold that has run out  - books are off the shelf and nobody is deciding
 *   a customer asking to cancel - somebody is waiting on an answer
 *   one basket, two orders   - changes what postage may be charged
 *   what the last press did  - already happened, and is only a receipt
 *
 * The wording lives here rather than in the page for the same reason the
 * status wording lives in `lib/order-status`: a strip and a panel describing
 * the same condition differently is how a shop ends up contradicting itself.
 */

import { AMEND_REFUSAL } from './amend';

export type OrderFlagKind =
  | 'lapsed'
  | 'cancel-requested'
  | 'siblings'
  | 'saved-tracking'
  | 'sent'
  | 'nosend'
  | 'state'
  | 'refused'
  | 'amended'
  | 'extended';

export interface OrderFlag {
  kind: OrderFlagKind;
  /** red for wrong, brass for a question, green for something that worked. */
  tone: 'warn' | 'ask' | 'good' | 'note';
  /** The line itself, which is all the strip is guaranteed to show. */
  text: string;
  /** One more line, and never a third. */
  sub?: string | null;
}

export interface FlagInput {
  customerName: string;
  /** The shelf hold ran out and nothing was done about it. */
  lapsed: boolean;
  lapsedDays: number;
  /** How many copies this order is holding, which is what a lapse costs. */
  totalCopies: number;
  /** A customer waiting to hear whether their cancellation is accepted. */
  cancelRequestedAt: number | null;
  customerCancelNote: string | null;
  /** How many other orders one checkout produced. */
  siblingCount: number;
  /** The query string the last press came back with. */
  saved: string | null;
  sentVia: string | null;
  problem: string | null;
  amendedCount: number;
  told: string;
  extended: string | null;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

const when = (at: number) =>
  new Date(at * 1000).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

/**
 * What the last press did, if anything.
 *
 * Only ever one of these: they are the outcome of a single request, and the
 * page is drawn once per request.
 */
function resultFlag(input: FlagInput): OrderFlag | null {
  const { saved, sentVia, problem, amendedCount, told, extended } = input;

  if (saved === 'tracking') {
    return {
      kind: 'saved-tracking',
      tone: 'good',
      text: 'Tracking updated. Nothing was sent to the customer.',
    };
  }

  if (sentVia) {
    return {
      kind: 'sent',
      tone: 'good',
      text: `Confirmed. Payment details sent by ${sentVia.replace('+', ' and ')}.`,
    };
  }

  if (problem === 'nosend') {
    return {
      kind: 'nosend',
      tone: 'warn',
      text: 'Nothing was sent, so this order is still waiting.',
      /* The original said this in four lines. It says the same thing: the
         figures are safe, no message went, and here is what to set. */
      sub:
        'The postage and total have been saved, but email is not configured and this ' +
        'customer has not connected Telegram. Set RESEND_API_KEY and ORDER_FROM, then ' +
        'confirm again - or contact them directly using the details below.',
    };
  }

  if (problem === 'state') {
    return {
      kind: 'state',
      tone: 'warn',
      text: 'That order had already moved on - nothing was changed.',
    };
  }

  // Both refusals in the words lib/amend gives them, so the endpoint and the
  // page cannot describe the same refusal differently.
  if (problem === 'nochange' || problem === 'empty') {
    return {
      kind: 'refused',
      tone: 'ask',
      text: problem === 'empty' ? AMEND_REFUSAL.empty : AMEND_REFUSAL.none,
    };
  }

  if (amendedCount > 0) {
    return {
      kind: 'amended',
      /* Whether the customer actually heard is the part worth colouring. The
         change stands either way - the copies are back on the shelf. */
      tone: told ? 'good' : 'warn',
      text: `${amendedCount === 1 ? 'One book' : `${amendedCount} books`} taken off, and the copies are back on the shelf.`,
      sub: told
        ? `They were told by ${told.replace('+', ' and ')}.`
        : 'Nothing could be delivered to them - tell them yourself in the messages.',
    };
  }

  if (extended) {
    return {
      kind: 'extended',
      tone: 'good',
      text: 'Another week. Nothing was sent - let them know in the messages.',
    };
  }

  return null;
}

/** Every condition that is live, most pressing first. */
export function orderFlags(input: FlagInput): OrderFlag[] {
  const flags: OrderFlag[] = [];

  if (input.lapsed) {
    const { totalCopies, lapsedDays } = input;
    flags.push({
      kind: 'lapsed',
      tone: 'warn',
      text:
        'The 48-hour hold ran out' +
        (lapsedDays >= 1 ? ` ${lapsedDays} ${plural(lapsedDays, 'day', 'days')} ago` : '') +
        ', and this is waiting on you.',
      /*
       * What ignoring it costs, which is the whole reason the sweep stopped
       * cancelling these outright: an order left here keeps books off the
       * shelf, and the owner has to be told that rather than find out.
       */
      sub:
        `Nothing was cancelled and nothing was sent. ${totalCopies} ` +
        `${plural(totalCopies, 'copy is', 'copies are')} still held off the shelf, so it ` +
        'is worth an answer either way.',
    });
  }

  if (input.cancelRequestedAt) {
    flags.push({
      kind: 'cancel-requested',
      tone: 'ask',
      text: `${input.customerName} asked to cancel.`,
      sub:
        (input.customerCancelNote ? `“${input.customerCancelNote}”` : 'They gave no reason.') +
        ` · asked ${when(input.cancelRequestedAt)}, and their order is still live until you answer.`,
    });
  }

  if (input.siblingCount > 0) {
    flags.push({
      kind: 'siblings',
      tone: 'note',
      text: `Part of one basket that became ${input.siblingCount + 1} orders.`,
      sub:
        'The books on the shelf are separated from the ones still coming, so each can be ' +
        'sent when it is ready.',
    });
  }

  const result = resultFlag(input);
  if (result) flags.push(result);

  return flags;
}
