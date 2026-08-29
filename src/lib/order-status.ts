/**
 * What an order is called, and what can happen to it next.
 *
 * This exists because the answer depends on two things - the status *and*
 * whether the customer is collecting - and six different files used to decide
 * it independently. Five of them forgot about collection, so a customer picking
 * books up in person was shown "Dispatched", told "Your books are on their
 * way", and emailed "Your order has been posted", while the timeline directly
 * below said "Ready to collect".
 *
 * Every label, blurb, button and transition now comes from here. Adding a
 * status means editing one file, and a collection order cannot be described as
 * posted without someone deliberately writing that here.
 */

export type OrderStatus =
  | 'requested'
  | 'awaiting_payment'
  | 'paid'
  | 'dispatched'
  | 'completed'
  | 'cancelled'
  | 'expired';

export type Fulfilment = 'delivery' | 'collection';

/** How the customer page tints the status panel. */
export type Tone = 'wait' | 'good' | 'done' | 'off';

const isCollection = (f: string): boolean => f === 'collection';

// ---------------------------------------------------------------------------
// What the customer sees
// ---------------------------------------------------------------------------

export interface CustomerStatus {
  label: string;
  blurb: string;
  tone: Tone;
}

/**
 * The heading and explanation on the customer's order page.
 *
 * `collectionAddress` is only consulted for a collection order that is ready,
 * because that is the one moment the customer needs to know where to go.
 * 
 * `cashPayment` is true when a collection order will be paid in cash on pickup,
 * which changes the wording to reflect a time agreed with the owner.
 */
export function statusLabel(
  status: string,
  fulfilment: string,
  collectionAddress = '',
  cashPayment = false,
): CustomerStatus {
  const collecting = isCollection(fulfilment);

  switch (status) {
    case 'requested':
      return {
        label: 'Request received',
        blurb: 'Your books are held. We will reply with the total and how to pay.',
        tone: 'wait',
      };

    case 'awaiting_payment':
      return collecting && cashPayment
        ? {
            label: 'Ready to arrange collection',
            blurb: collectionAddress
              ? `Your books are being set aside at ${collectionAddress}. Get in touch and we will agree a time - you can pay in cash when you collect.`
              : 'Your books are being set aside. Get in touch and we will agree a time - you can pay in cash when you collect.',
            tone: 'wait',
          }
        : {
            label: 'Awaiting payment',
            blurb:
              'We have sent you payment details. Your books stay held until payment reaches us.',
            tone: 'wait',
          };

    case 'paid':
      return collecting
        ? {
            label: 'Ready to collect',
            blurb: collectionAddress
              ? cashPayment
                ? `Your books are ready at ${collectionAddress}. Contact us to arrange a collection time. Payment can be made when you collect.`
                : `Thank you. Your books are set aside for you at ${collectionAddress}.`
              : cashPayment
                ? 'Your books are ready for collection. Contact us to arrange a time. Payment can be made when you collect.'
                : 'Thank you. Your books are set aside and ready whenever suits you.',
            tone: 'good',
          }
        : {
            label: 'Payment received',
            blurb: 'Thank you. Your order is being packed.',
            tone: 'good',
          };

    // Delivery only - the endpoint refuses it for a collection. The collection
    // branch is here because orders predating that rule exist, and telling
    // someone who collected in person that their books were posted is the whole
    // bug this module was written to end.
    case 'dispatched':
      return collecting
        ? {
            label: 'Collected',
            blurb: 'Your order is complete. Thank you for your custom.',
            tone: 'done',
          }
        : { label: 'Posted', blurb: 'Your books are on their way.', tone: 'done' };

    case 'completed':
      return collecting
        ? {
            label: 'Collected',
            blurb: 'Your order is complete. Thank you for your custom.',
            tone: 'done',
          }
        : {
            label: 'Delivered',
            blurb: 'Your order is complete. Thank you for your custom.',
            tone: 'done',
          };

    case 'cancelled':
      return {
        label: 'Cancelled',
        blurb: 'This request was cancelled. Nothing was charged.',
        tone: 'off',
      };

    case 'expired':
      return {
        label: 'Hold lapsed',
        blurb:
          'We did not hear back within 48 hours, so the books returned to the shelf. Nothing was charged - you are welcome to request again.',
        tone: 'off',
      };

    default:
      return statusLabel('requested', fulfilment, collectionAddress, cashPayment);
  }
}

/** True once the order has moved past waiting on the customer. */
export const isSettled = (status: string): boolean =>
  status === 'paid' || status === 'dispatched' || status === 'completed';

/**
 * Whether the shop actually has the money.
 *
 * Not the same question as `isSettled`. A cash collection reaches 'paid' when
 * the books are set aside, which is *before* anyone has paid for them - so the
 * page said "Total paid - paid in full, nothing further is owed" directly under
 * a blurb inviting them to pay when they arrive. The money is only real once
 * they have been and gone.
 */
export const moneyReceived = (status: string, cashPayment = false): boolean =>
  cashPayment ? status === 'completed' : isSettled(status);

// ---------------------------------------------------------------------------
// What the owner sees
// ---------------------------------------------------------------------------

/** The short label in the portal list and the status chip. */
export function portalLabel(status: string, fulfilment: string, cashPayment = false): string {
  const collecting = isCollection(fulfilment);
  const cash = collecting && cashPayment;

  switch (status) {
    case 'requested':
      return 'Needs reply';
    case 'awaiting_payment':
      // Nothing is owed yet on a cash order, so "Awaiting payment" would have
      // the owner chasing money that is not late.
      return cash ? 'To arrange' : 'Awaiting payment';
    case 'paid':
      if (cash) return 'Ready to collect · cash';
      return collecting ? 'Ready to collect' : 'Paid, to post';
    case 'dispatched':
      return collecting ? 'Collected' : 'Posted';
    case 'completed':
      return collecting ? 'Collected' : 'Delivered';
    case 'cancelled':
      return 'Cancelled';
    case 'expired':
      return 'Lapsed';
    default:
      return status.replace('_', ' ');
  }
}

export interface NextAction {
  /** The status this moves the order to. */
  action: OrderStatus;
  label: string;
  hint?: string;
  /** Show the tracking number, provider and service fields with this action. */
  needsPostage?: boolean;
  /** Rendered quietly - the exception rather than the usual path. */
  secondary?: boolean;
  /** Rendered as a destructive action. */
  danger?: boolean;
}

/**
 * The buttons the owner is offered.
 *
 * The owner records payment and posting in one go, because that is how they
 * actually work - so from `awaiting_payment` the primary action for a delivery
 * both marks it paid and posts it. Recording payment on its own stays available
 * underneath for the occasional order paid on a Friday and posted on Monday,
 * where telling the customer it was posted would be a lie.
 */
export function nextActions(
  status: string,
  fulfilment: string,
  cashPayment = false,
): NextAction[] {
  const collecting = isCollection(fulfilment);
  const cash = collecting && cashPayment;
  const cancel: NextAction = {
    action: 'cancelled',
    label: 'Cancel order',
    hint: 'Releases the held copies back to the shelf.',
    danger: true,
  };

  switch (status) {
    case 'requested':
      return [cancel];

    case 'awaiting_payment':
      return collecting
        ? [
            // Same transition either way. Only the words change: on a cash
            // order the owner would be clicking "Payment received" before any
            // money existed, purely to tell the customer the books are ready.
            cash
              ? {
                  action: 'paid',
                  label: 'Set aside for collection',
                  hint: 'Tells them the books are ready and to agree a time. The money comes when they collect.',
                }
              : {
                  action: 'paid',
                  label: 'Payment received',
                  hint: 'Tells them their books are set aside and ready to collect.',
                },
            cancel,
          ]
        : [
            {
              action: 'dispatched',
              label: 'Payment received and posted',
              hint: 'Records the payment and tells them it is on the way.',
              needsPostage: true,
            },
            {
              action: 'paid',
              label: 'Payment received, not posted yet',
              hint: 'Use when you will post it later.',
              secondary: true,
            },
            cancel,
          ];

    case 'paid':
      return collecting
        ? [
            {
              action: 'completed',
              label: 'Mark as collected',
              hint: cash ? 'Closes the order - take the cash when they arrive.' : 'Closes the order.',
            },
            cancel,
          ]
        : [
            {
              action: 'dispatched',
              label: 'Mark as posted',
              hint: 'Tells the customer the books are on the way.',
              needsPostage: true,
            },
            cancel,
          ];

    case 'dispatched':
      return [{ action: 'completed', label: 'Mark as delivered', hint: 'Closes the order.' }];

    // completed, cancelled, expired
    default:
      return [];
  }
}

/**
 * Whether a transition is permitted.
 *
 * Derived from the buttons rather than kept as a second list, so the endpoint
 * can never accept something the portal does not offer. In particular a
 * collection order has no route to `dispatched` - there is nothing to post -
 * and this is what refuses a request crafted by hand.
 */
export function canTransition(
  from: string,
  to: string,
  fulfilment: string,
  cashPayment = false,
): boolean {
  return nextActions(from, fulfilment, cashPayment).some((a) => a.action === to);
}

// ---------------------------------------------------------------------------
// What gets sent
// ---------------------------------------------------------------------------

export interface StatusMessage {
  subject: string;
  line: string;
}

/**
 * The email and Telegram copy for a status change.
 *
 * Returns null for statuses that are not worth a message - there is no point
 * telling someone their lapsed hold has lapsed.
 */
export function statusMessage(
  status: string,
  fulfilment: string,
  opts: {
    ref: string;
    tracking?: string | null;
    provider?: string | null;
    collectionAddress?: string;
    /** See statusLabel: a cash collection is not paid for until they arrive. */
    cashPayment?: boolean;
  } = {
    ref: '',
  },
): StatusMessage | null {
  const collecting = isCollection(fulfilment);
  const { ref, tracking, provider, collectionAddress, cashPayment } = opts;

  switch (status) {
    case 'paid':
      if (collecting && cashPayment) {
        return {
          subject: `Ready to collect - ${ref}`,
          line: collectionAddress
            ? `Your books are set aside for you at ${collectionAddress}. Get in touch to arrange a time - you can pay when you collect.`
            : 'Your books are set aside for you. Get in touch to arrange a time - you can pay when you collect.',
        };
      }
      return collecting
        ? {
            subject: `Ready to collect - ${ref}`,
            line: collectionAddress
              ? `We have received your payment. Your books are set aside for you at ${collectionAddress}.`
              : 'We have received your payment. Your books are set aside, ready whenever suits you.',
          }
        : {
            subject: `Payment received - ${ref}`,
            line: 'We have received your payment. Your books are being packed.',
          };

    case 'dispatched':
      return {
        subject: `Your books are on the way - ${ref}`,
        line: tracking
          ? `Your order has been posted${provider ? ` with ${provider}` : ''}. Your tracking number is ${tracking}.`
          : 'Your order has been posted. Thank you for your custom.',
      };

    case 'completed':
      return {
        subject: `Order complete - ${ref}`,
        line: collecting
          ? 'Thank you for collecting your books, and for your custom.'
          : 'Your order is complete. Thank you for your custom.',
      };

    case 'cancelled':
      return {
        subject: `Order cancelled - ${ref}`,
        line: 'This request has been cancelled. Nothing was charged.',
      };

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Postage
// ---------------------------------------------------------------------------

/**
 * Carriers the shop uses, and where their tracking lives.
 *
 * The tracking link used to be hardcoded to Royal Mail, so an Evri number sent
 * the customer to a Royal Mail page that could not find it. "Other" is
 * deliberately linkless rather than guessing.
 */
export const POSTAGE_PROVIDERS = [
  'Royal Mail',
  'Evri',
  'DPD',
  'Parcelforce',
  'Yodel',
  'Other',
] as const;

const TRACKING: Record<string, (n: string) => string> = {
  'Royal Mail': (n) => `https://www.royalmail.com/track-your-item#/tracking-results/${n}`,
  Evri: (n) => `https://www.evri.com/track/parcel/${n}`,
  DPD: (n) => `https://track.dpd.co.uk/search?reference=${n}`,
  Parcelforce: (n) => `https://www.parcelforce.com/track-trace?trackNumber=${n}`,
  Yodel: (n) => `https://www.yodel.co.uk/track/${n}`,
};

/** Null when the carrier is unknown - the number is still worth showing. */
export function trackingUrl(provider: string | null | undefined, number: string): string | null {
  const build = provider ? TRACKING[provider] : undefined;
  return build ? build(encodeURIComponent(number)) : null;
}
