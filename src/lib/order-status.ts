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

/**
 * When the money actually changes hands on a cash order.
 *
 * Cash used to mean collection, so every string could say "when you collect".
 * It can now be either journey - a posted order marked cash is one handed over
 * in person - and this is the one phrase that has to differ, so it lives here
 * with the rest of the wording rather than being written out at each call site.
 */
export const cashMoment = (fulfilment: string): string =>
  isCollection(fulfilment) ? 'when you collect' : 'when we hand them over';

/** The same moment, said to the owner rather than the customer. */
export const cashMomentOwner = (fulfilment: string): string =>
  isCollection(fulfilment) ? 'when they collect' : 'when you hand them over';

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
      if (cashPayment) {
        // Nothing is owed yet either way, so "Awaiting payment" would be a lie -
        // no payment details were sent. What differs is only where the money
        // changes hands.
        if (collecting) {
          return {
            label: 'Ready to arrange collection',
            blurb: collectionAddress
              ? `Your books are being set aside at ${collectionAddress}. Get in touch and we will agree a time - you can pay in cash when you collect.`
              : 'Your books are being set aside. Get in touch and we will agree a time - you can pay in cash when you collect.',
            tone: 'wait',
          };
        }
        return {
          label: 'Confirmed, paying in cash',
          blurb:
            'Your books are set aside. We will be in touch to arrange handing them over, and you can pay in cash then.',
          tone: 'wait',
        };
      }
      return {
        label: 'Awaiting payment',
        blurb: 'We have sent you payment details. Your books stay held until payment reaches us.',
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
        : cashPayment
          ? {
              // Not "Payment received": on a cash order this step means the
              // books are ready, and the money still comes later.
              label: 'Ready to hand over',
              blurb:
                'Your books are packed. We will be in touch to arrange handing them over, and you can pay in cash then.',
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
            blurb: 'Your order is complete. جزاكم الله خيرا.',
            tone: 'done',
          }
        : cashPayment
          ? {
              label: 'On its way',
              blurb: 'Your books are on their way. The payment is due in cash when we hand them over.',
              tone: 'done',
            }
          : { label: 'Posted', blurb: 'Your books are on their way.', tone: 'done' };

    case 'completed':
      return collecting
        ? {
            label: 'Collected',
            blurb: 'Your order is complete. جزاكم الله خيرا.',
            tone: 'done',
          }
        : {
            label: 'Delivered',
            blurb: 'Your order is complete. جزاكم الله خيرا.',
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
  const cash = cashPayment;

  switch (status) {
    case 'requested':
      return 'Needs reply';
    case 'awaiting_payment':
      // Nothing is owed yet on a cash order, so "Awaiting payment" would have
      // the owner chasing money that is not late.
      if (cash) return collecting ? 'To arrange' : 'To hand over';
      return 'Awaiting payment';
    case 'paid':
      if (cash) return collecting ? 'Ready to collect · cash' : 'Ready to send · cash';
      return collecting ? 'Ready to collect' : 'Paid, to post';
    case 'dispatched':
      if (cash && !collecting) return 'Posted · cash due';
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
  const cash = cashPayment;
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
        : cash
          ? [
              // Nothing has been received, so neither button may say so.
              {
                action: 'dispatched',
                label: 'Sent, cash still due',
                hint: 'Tells them it is on the way. You take the cash when you hand them over.',
                needsPostage: true,
              },
              {
                action: 'paid',
                label: 'Ready, not sent yet',
                hint: 'Use when you will send it later.',
                secondary: true,
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
              label: cash ? 'Mark as sent' : 'Mark as posted',
              hint: cash
                ? 'Tells them it is on the way. The cash comes when you hand them over.'
                : 'Tells the customer the books are on the way.',
              needsPostage: true,
            },
            cancel,
          ];

    /*
     * A posted order is finished when it is posted.
     *
     * There used to be a "Mark as delivered" button here for every order, and
     * on a paid one it carried no information: the money was in, the parcel
     * was gone, and the click only told the portal something it already knew.
     * Posting now closes it outright - see `closesOnDispatch`.
     *
     * Cash on delivery is the exception, and the reason this is not simply
     * removed: there the second step is when the money actually arrives, so
     * closing at dispatch would file an unpaid order as done.
     */
    case 'dispatched':
      return cash
        ? [
            {
              action: 'completed',
              label: 'Cash received, close the order',
              hint: 'Use once you have handed them over and been paid.',
            },
          ]
        : [];

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
/**
 * Whether posting this order also finishes it.
 *
 * Only for orders that are already paid for. A cash order still owes money at
 * the point it is sent, so it keeps its second step.
 */
export function closesOnDispatch(fulfilment: string, cashPayment = false): boolean {
  return !isCollection(fulfilment) && !cashPayment;
}

export function canTransition(
  from: string,
  to: string,
  fulfilment: string,
  cashPayment = false,
): boolean {
  return nextActions(from, fulfilment, cashPayment).some((a) => a.action === to);
}

// ---------------------------------------------------------------------------
// The thread
// ---------------------------------------------------------------------------

/**
 * Every word the message thread says, in one place.
 *
 * The page, the email and the Telegram message all read from here for the same
 * reason the status copy does: three places writing their own version is how
 * the shop ends up promising one thing on screen and another in an inbox.
 */
/** What the shop says when a book somebody asked about comes back. */
export const BACK_IN_STOCK = {
  ask: 'Tell me when it is back',
  help: 'One email when it returns, and nothing else - we do not keep the address afterwards.',
  placeholder: 'Your email address',
  added: 'We will email you the moment it is back.',
  already: 'You are already on the list for this one.',
  tooMany: 'That is a lot of titles to watch at once. Please wait for one of them first.',
  bad: 'That does not look like an email address.',
  subject: (title: string) => `Back in stock: ${title}`,
  heading: 'It is back',
} as const;

export const THREAD = {
  heading: 'Messages',
  /** The empty state, which is the one that has to do the persuading. */
  emptyCustomer:
    'Anything you need to ask about this order, ask it here. It reaches the shop with your order attached, so nobody has to look up who you are.',
  emptyOwner: 'Nothing yet. You can start the conversation from here.',
  /*
   * A finished order that was never talked about.
   *
   * The two empty states above both invite a message, which on a closed thread
   * sat directly above "the conversation is closed" and contradicted it.
   */
  emptyClosed: 'Nothing was said about this order.',
  placeholder: 'Write a message about this order',
  send: 'Send',
  /**
   * The one line the compose box needs about paying.
   *
   * "Paid already?" asked a question without answering the one the customer
   * actually has, which is *where do I send the proof*. This says it: here, or
   * Telegram, and nowhere else.
   *
   * How long the shop keeps the file is deliberately not here. It is the
   * shop's own retention policy, it belongs on the privacy page, and under a
   * compose box it was three lines of housekeeping between the customer and
   * the send button. The owner sees it instead, where it is actually
   * actionable.
   */
  payHint: 'Sent a payment? Attach the screenshot here, or send it to us on Telegram.',
  /** The paperclip's accessible name - there is no visible label. */
  attach: 'Attach a screenshot',
  /** Shown once something is chosen, so the file has a name on screen. */
  attached: 'Screenshot attached',
  remove: 'Remove',
  /** Owner side only: what the shop is holding, and for how long. */
  ownerRetention: (n: number) =>
    `${n} ${n === 1 ? 'photo' : 'photos'} on this order, kept for six months after it is finished.`,
  /** A thread nobody is left to answer. */
  closed: 'This order is finished, so the conversation is closed. It stays here for your records.',
  /** The customer typed more than the column can hold. */
  tooLong: 'That message is too long. Please shorten it and send again.',
  /** Sent too much, too fast. */
  tooMany: 'That is a lot of messages at once. Please give the shop a moment to catch up.',
  imageCapped: 'You have sent the most photos this order can take. The shop has them all.',
  imageWrongType: 'Photos only, please - a JPEG, PNG or WebP.',
  imageTooBig: 'That photo is larger than 8 MB. Please send a smaller one.',
  /** Something went wrong that is nobody's fault in particular. */
  failed: 'That did not send. Your words are still here - please try again.',
} as const;

/** How an owner reply will actually reach this customer. */
export function replyChannel(telegramChatId: string | null | undefined): 'telegram' | 'email' {
  return telegramChatId ? 'telegram' : 'email';
}

/** What the owner is told about that, before they write. */
export function replyChannelNote(
  telegramChatId: string | null | undefined,
  email: string,
): string {
  return telegramChatId
    ? 'Your reply goes to their Telegram.'
    : `Your reply goes to ${email}.`;
}

// ---------------------------------------------------------------------------
// What gets sent
// ---------------------------------------------------------------------------

export interface StatusMessage {
  subject: string;
  line: string;
  /** Set only on 'dispatched', and only when the carrier is one we can link to. */
  trackingLink?: string | null;
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
      if (cashPayment) {
        if (collecting) {
          return {
            subject: `Ready to collect - ${ref}`,
            line: collectionAddress
              ? `Your books are set aside for you at ${collectionAddress}. Get in touch to arrange a time - you can pay when you collect.`
              : 'Your books are set aside for you. Get in touch to arrange a time - you can pay when you collect.',
          };
        }
        // Not "Payment received": nothing has been received yet on a cash order.
        return {
          subject: `Your books are ready - ${ref}`,
          line: 'Your books are packed. We will be in touch to arrange handing them over, and you can pay in cash then.',
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
      // A tracking number with nowhere to take it was making the customer go
      // and find the carrier's site themselves - the order page already has a
      // working link, this is that same link, reused.
      return {
        subject: `Your books are on the way - ${ref}`,
        line:
          (tracking
            ? `Your order has been posted${provider ? ` with ${provider}` : ''}. Your tracking number is ${tracking}.`
            : 'Your order has been posted. جزاكم الله خيرا.') +
          // The money is still to come, and a message about the parcel is where
          // they will be looking when it arrives.
          (cashPayment ? ' The payment is due in cash when we hand them over.' : ''),
        trackingLink: tracking ? trackingUrl(provider, tracking) : null,
      };

    case 'completed':
      return {
        subject: `Order complete - ${ref}`,
        line: collecting
          ? 'Thank you for collecting your books. جزاكم الله خيرا.'
          : 'Your order is complete. جزاكم الله خيرا.',
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
  'DHL',
  'Parcelforce',
  'Yodel',
  'InPost',
  'Other',
] as const;

export type PostageProvider = (typeof POSTAGE_PROVIDERS)[number];

export const isPostageProvider = (value: string): value is PostageProvider =>
  (POSTAGE_PROVIDERS as readonly string[]).includes(value);

// Typed against the list, so a carrier added to one and mistyped in the other
// fails the build instead of quietly behaving like "Other". The number arrives
// already encoded - do not encode it again.
const TRACKING: Partial<Record<PostageProvider, (n: string) => string>> = {
  'Royal Mail': (n) => `https://www.royalmail.com/track-your-item#/tracking-results/${n}`,
  Evri: (n) => `https://www.evri.com/track/parcel/${n}`,
  DPD: (n) => `https://track.dpd.co.uk/search?reference=${n}`,
  DHL: (n) => `https://www.dhl.com/gb-en/home/tracking/tracking-express.html?submit=1&tracking-id=${n}`,
  Parcelforce: (n) => `https://www.parcelforce.com/track-trace?trackNumber=${n}`,
  Yodel: (n) => `https://www.yodel.co.uk/track/${n}`,
  InPost: (n) => `https://inpost.co.uk/tracking/result/?trackingNumber=${n}`,
};

/** Null when the carrier is unknown - the number is still worth showing. */
export function trackingUrl(provider: string | null | undefined, number: string): string | null {
  const build = provider && isPostageProvider(provider) ? TRACKING[provider] : undefined;
  return build ? build(encodeURIComponent(number)) : null;
}
