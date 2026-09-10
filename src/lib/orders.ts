/**
 * Order requests.
 *
 * An order here is a *request to buy*, not a sale. No money moves. What the
 * request does is put a 48-hour hold on the copies so the owner can arrange
 * payment over Telegram without someone else taking the same book.
 */

import { env } from 'cloudflare:workers';
import { whenText } from './incoming';
import { salePrice, orderDiscount, totals } from './sales';
import { expireOrders } from './stock-release';
import type { AddressParts } from './address';

export const HOLD_HOURS = 48;

/** No 0/O/1/I - these get read aloud and typed back over Telegram. */
const REF_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export interface RequestedItem {
  bookId: number;
  qty: number;
}

export interface OrderInput {
  name: string;
  email: string;
  phone?: string | null;
  fulfilment: 'delivery' | 'collection';
  /** The formatted block, which is what every page and email reads. */
  address?: string | null;
  /** The same address in parts, for labels and customs forms. */
  addressParts?: AddressParts | null;
  /** What the customer said they would rather do: 'transfer' or 'cash'. */
  paymentPreference?: string | null;
  notes?: string | null;
  items: RequestedItem[];
}

export interface CreatedOrder {
  /** The row's own id, for anything that has to undo it. */
  id: number;
  ref: string;
  token: string;
  subtotalPence: number;
  /**
   * When the hold lapses, or null for an order waiting on a delivery.
   *
   * A reservation cannot be given 48 hours to complete: the thing it is for
   * does not exist yet. Null keeps it out of the expiry sweep, which is already
   * written to skip it - see the WHERE clause in expireStaleHolds.
   */
  expiresAt: number | null;
  /** Roughly when the delivery is due, for an order that is waiting on one. */
  waitingWhen: string | null;
  /** Carried over from an earlier order by the same customer, if any. */
  telegramChatId: string | null;
  items: { bookId: number; title: string; qty: number; pricePence: number; fromIncoming: boolean }[];
}

export class StockConflict extends Error {
  constructor(
    public readonly problems: { bookId: number; title: string; wanted: number; available: number }[],
  ) {
    super('Some titles are no longer available in the quantity requested');
    this.name = 'StockConflict';
  }
}

function randomRef(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  let out = '';
  for (const b of bytes) out += REF_ALPHABET[b % REF_ALPHABET.length];
  return `ASB-${out}`;
}

function randomToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Releases holds that were never confirmed.
 *
 * A dedicated cron Worker runs this on a schedule, but it also runs at the top
 * of order creation: whether a customer can buy the last copy must not depend
 * on when a scheduled job last fired.
 */
export async function expireStaleHolds(): Promise<number> {
  return (await expireOrders(env.DB)).orders;
}

export async function createCheckout(input: OrderInput): Promise<CreatedOrder[]> {
  await expireStaleHolds();

  const ids = input.items.map((i) => i.bookId);
  const placeholders = ids.map(() => '?').join(',');
  const { results: books } = await env.DB.prepare(
    /*
     * The price a customer is charged is decided here, once, server-side - so
     * the sale has to be applied here too. Anywhere else and a sale ending
     * mid-order would reprice an order already placed, and the customer would
     * be charged something other than what they were shown.
     */
    /*
     * `available` has to be the pooled figure for a split set.
     *
     * A set is one pool of volumes sold under several listings, so any single
     * listing's `stock - reserved` is not the truth: holding one copy of
     * volumes 1-2 leaves the complete-set row untouched while the pool is a
     * set short. The catalogue and basket have always shown the pooled number,
     * and this read used the raw one - so checkout would accept an order the
     * shop could not build. `books_set_not_oversold` is the backstop; this is
     * what turns it into a sentence naming the title rather than a rolled-back
     * batch.
     */
    `SELECT b.id, b.title, b.price_pence, b.shipment_id,
            CASE WHEN b.set_id IS NULL THEN (b.stock - b.reserved)
                 ELSE MAX(0, COALESCE((
                   SELECT MIN(v.have - COALESCE((
                            SELECT SUM(o.reserved) FROM books o
                             WHERE o.set_id = b.set_id
                               AND o.deleted_at IS NULL
                               AND v.volume BETWEEN o.set_from AND o.set_to
                          ), 0))
                     FROM book_set_stock v
                    WHERE v.set_id = b.set_id
                      AND v.volume BETWEEN b.set_from AND b.set_to
                 ), 0))
            END AS available,
            MAX(0, b.incoming - b.reserved_incoming) AS reservable,
            si.percent_off AS sale_percent,
            si.sale_id AS sale_id
       FROM books b
       LEFT JOIN sale_items si ON si.book_id = b.id
            AND si.sale_id = (SELECT id FROM sales WHERE status = 'live')
      WHERE b.id IN (${placeholders}) AND b.deleted_at IS NULL AND (
              (b.status = 'live' AND b.shipment_id IS NULL)
              /*
               * Or it is on a shipment that is open for reservations.
               *
               * A basket may hold both, and an order carrying either is
               * handled by the same machinery: a line the shelf cannot cover
               * becomes a claim, and an order with any claim in it gets no
               * 48-hour clock, so the half that is here is not released out
               * from under the half still coming.
               *
               * What this must never admit is a shipment book whose shipment
               * has arrived or been put away, and it does not - which is also
               * what shuts new reservations off at arrival, with no second
               * flag to keep in step.
               */
              OR EXISTS (SELECT 1 FROM shipments s
                          WHERE s.id = b.shipment_id AND s.status = 'open')
            )`,
  )
    .bind(...ids)
    .all<{
      id: number; title: string; price_pence: number; shipment_id: number | null;
      available: number; reservable: number;
      sale_percent: number | null; sale_id: number | null;
    }>();

  const byId = new Map(books.map((b) => [b.id, b]));

  // Check first so the customer gets a readable message naming the titles.
  // Correctness does not rest on this check - see the CHECK constraint below.
  const problems = [];
  for (const item of input.items) {
    const book = byId.get(item.bookId);
    if (!book) {
      problems.push({ bookId: item.bookId, title: 'Unavailable title', wanted: item.qty, available: 0 });
    } else if ((book.shipment_id !== null ? book.reservable < item.qty : book.available < item.qty && book.reservable < item.qty)) {
      /*
       * Neither on the shelf nor claimable from a delivery. The two are checked
       * separately and never added together: a line is one or the other, so a
       * customer is never sold "two, one of which is imaginary".
       */
      problems.push({
        bookId: item.bookId,
        title: book.title,
        wanted: item.qty,
        available: Math.max(0, Math.max(book.available, book.reservable)),
      });
    }
  }
  if (problems.length) throw new StockConflict(problems);

  const items = input.items.map((item) => {
    const book = byId.get(item.bookId)!;
    return {
      bookId: book.id,
      title: book.title,
      qty: item.qty,
      // The reduced price, which is what price_pence_snapshot must record.
      pricePence: salePrice(book.price_pence, book.sale_percent),
      /*
       * And what it was reduced *from*, plus which sale did it.
       *
       * Recorded here because this is the only moment both are true. Working
       * the discount out later from the book's current price meant that
       * repricing a title rewrote what a finished sale appeared to have given
       * away, and picking qualifying orders by date credited the sale with
       * every other discount in the same window.
       */
      saleId: book.sale_percent ? book.sale_id : null,
      fullPricePence: book.price_pence,
      /*
       * On the shelf if it can be; a claim on the delivery only when it cannot.
       *
       * Except on a shipment, where it is always a claim. Once a box has landed
       * its books have real stock, and deriving this would quietly turn the
       * next reservation into an ordinary sale of a listing that has no cover,
       * no description and no page to read - which is not what somebody
       * browsing a shipment is agreeing to. Marking a shipment arrived closes
       * it to new reservations, so this only matters in the gap between the
       * stock landing and that happening; it should not depend on the owner
       * pressing things in the right order.
       */
      fromIncoming: book.shipment_id !== null || book.available < item.qty,
    };
  });
  /*
   * The order discount, worked out once and written down.
   *
   * `items` already carries reduced prices, so this is the "after sale" figure
   * the threshold is meant to be tested against. Stored rather than recomputed
   * later: the rule can be switched off tomorrow, and an order must still show
   * the discount it was actually given.
   */
  const discountRule = await orderDiscount();
  const figures = totals(
    items.map((i) => ({ pricePence: i.pricePence, qty: i.qty })),
    discountRule,
  );
  const discountPence = figures.orderDiscountPence;

  // A customer who has already started the bot stays reachable: Telegram grants
  // that permission per person, not per order, so making them tap Connect again
  // for every order would be asking for something they already gave.
  /*
   * Matched case-insensitively, as `findOrder` already does.
   *
   * `WHERE email = ?` is exact, so someone who typed `Ali@Example.com` once and
   * `ali@example.com` the next time was treated as two people and lost the
   * Telegram connection they had already granted. That matters more now that
   * Telegram is a way into the order's thread and not only a way out.
   */
  // Same second, same tie: the id decides, so which chat a returning customer
  // keeps is never left to the query planner.
  const priorLink = await env.DB.prepare(
    `SELECT telegram_chat_id FROM orders
      WHERE LOWER(email) = LOWER(?) AND telegram_chat_id IS NOT NULL
      ORDER BY telegram_linked_at DESC, id DESC LIMIT 1`,
  )
    .bind(input.email)
    .first<{ telegram_chat_id: string }>();
  // Shelf copies and future deliveries carry different expiry promises.
  const parcels = new Map<string, typeof items>();
  for (const item of items) {
    const shipment = byId.get(item.bookId)!.shipment_id;
    const group = !item.fromIncoming ? 'shelf' : shipment === null ? 'incoming' : `shipment:${shipment}`;
    parcels.set(group, [...(parcels.get(group) ?? []), item]);
  }
  const groups = [...parcels].sort(([a],[b])=>a==='shelf'?-1:b==='shelf'?1:a.localeCompare(b));
  const splitGroup = groups.length>1 ? crypto.randomUUID() : null;
  // Apply the discount the customer saw to the whole basket, then allocate it
  // proportionally. Splitting parcels must not silently remove that discount.
  const gross = items.reduce((n,i)=>n+i.pricePence*i.qty,0);
  const discounts = groups.map(([,lines])=>Math.floor(discountPence * lines.reduce((n,i)=>n+i.pricePence*i.qty,0) / (gross || 1)));
  let pennies = discountPence-discounts.reduce((n,d)=>n+d,0);
  for(let i=0;pennies>0;i=(i+1)%discounts.length,pennies--) discounts[i]++;

  for (let attempt=0;attempt<5;attempt++) {
    const statements: D1PreparedStatement[] = [];
    const created: CreatedOrder[] = [];
    const insertPositions: number[] = [];
    for (const [index,[group,lines]] of groups.entries()) {
      const ref=randomRef(), token=randomToken();
      const shipmentId=group.startsWith('shipment:')?Number(group.slice(9)):null;
      const expiresAt=group==='shelf'?Math.floor(Date.now()/1000)+HOLD_HOURS*3600:null;
      const lineTotal=lines.reduce((n,i)=>n+i.pricePence*i.qty,0)-discounts[index];
      const data=JSON.stringify(lines);
      insertPositions.push(statements.length);
      statements.push(env.DB.prepare(`INSERT INTO orders
        (ref,access_token,customer_name,email,phone,fulfilment,address,notes,status,
         subtotal_pence,discount_pence,expires_at,shipment_id,split_group,telegram_chat_id,telegram_linked_at,
         address_line1,address_line2,address_city,address_region,address_postcode,address_country,payment_preference,cash_payment)
        SELECT ?1,?2,?3,?4,?5,?6,?7,?8,'requested',?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23
        WHERE NOT EXISTS (SELECT 1 FROM json_each(?24) j WHERE NOT EXISTS (
          SELECT 1 FROM books b WHERE b.id=json_extract(j.value,'$.bookId') AND
            b.deleted_at IS NULL AND
            ((?12 IS NULL AND b.shipment_id IS NULL AND b.status='live') OR
             (b.shipment_id=?12 AND EXISTS (SELECT 1 FROM shipments WHERE id=b.shipment_id AND status='open')))
        )) RETURNING id`).bind(ref,token,input.name,input.email,input.phone??null,input.fulfilment,input.address??null,
          input.notes??null,lineTotal,discounts[index],expiresAt,shipmentId,splitGroup,priorLink?.telegram_chat_id??null,
          priorLink?Math.floor(Date.now()/1000):null,input.addressParts?.line1??null,input.addressParts?.line2??null,
          input.addressParts?.city??null,input.addressParts?.region??null,input.addressParts?.postcode??null,
          input.addressParts?.country??null,input.paymentPreference??null,input.paymentPreference==='cash'?1:0,data));
      statements.push(env.DB.prepare(`INSERT INTO order_items(order_id,book_id,title_snapshot,price_pence_snapshot,qty,from_incoming,sale_id,full_price_pence)
        SELECT (SELECT id FROM orders WHERE ref=?1),json_extract(value,'$.bookId'),json_extract(value,'$.title'),
          json_extract(value,'$.pricePence'),json_extract(value,'$.qty'),json_extract(value,'$.fromIncoming'),
          json_extract(value,'$.saleId'),json_extract(value,'$.fullPricePence') FROM json_each(?2)`).bind(ref,data));
      statements.push(env.DB.prepare(`UPDATE books SET
        reserved=reserved+COALESCE((SELECT SUM(qty) FROM order_items WHERE order_id=(SELECT id FROM orders WHERE ref=?1) AND book_id=books.id AND from_incoming=0),0),
        reserved_incoming=reserved_incoming+COALESCE((SELECT SUM(qty) FROM order_items WHERE order_id=(SELECT id FROM orders WHERE ref=?1) AND book_id=books.id AND from_incoming=1),0)
        WHERE id IN (SELECT book_id FROM order_items WHERE order_id=(SELECT id FROM orders WHERE ref=?1))`).bind(ref));
      statements.push(env.DB.prepare(`INSERT INTO stock_ledger(book_id,delta,field,reason,order_id)
        SELECT book_id,qty,'reserved','order requested',order_id FROM order_items
        WHERE order_id=(SELECT id FROM orders WHERE ref=?) AND from_incoming=0`).bind(ref));
      created.push({id:0,ref,token,subtotalPence:lineTotal,expiresAt,waitingWhen:null,
        telegramChatId:priorLink?.telegram_chat_id??null,items:lines});
    }
    // This read only supplies wording; order creation and every hold commit as
    // one batch. There is no compensating cancellation that can itself fail.
    for(const made of created) {
      const incoming=made.items.find(i=>i.fromIncoming);
      if(incoming) {
        const date=await env.DB.prepare('SELECT incoming_vague AS v,incoming_month AS m FROM books WHERE id=?')
          .bind(incoming.bookId).first<{v:string|null;m:string|null}>();
        made.waitingWhen=whenText(date?.v??null,date?.m??null);
      }
    }
    try {
      const result=await env.DB.batch(statements);
      created.forEach((made,i)=>{made.id=(result[insertPositions[i]].results[0] as {id:number}).id;});
      return created;
    } catch(err) {
      const message=String(err);
      if(message.includes('orders.ref')) continue;
      if(/reserved <= stock|set pool oversold|more copies claimed|shipment is not open|order_items.order_id/.test(message)) {
        throw new StockConflict(items.map(i=>({bookId:i.bookId,title:i.title,wanted:i.qty,available:-1})));
      }
      throw err;
    }
  }
  throw new Error('Could not allocate an order reference');
}

/**
 * Finds an order from what a customer can remember.
 *
 * Both the reference and the email must match, and a miss is reported the same
 * way whether the reference was wrong or the email was: telling someone a
 * reference exists but the email is wrong would confirm an order to a stranger.
 */
export async function findOrder(ref: string, email: string): Promise<{ ref: string; token: string } | null> {
  const row = await env.DB.prepare(
    `SELECT ref, access_token FROM orders
      WHERE UPPER(ref) = UPPER(?) AND LOWER(email) = LOWER(?)`,
  )
    .bind(ref.trim(), email.trim())
    .first<{ ref: string; access_token: string }>();
  return row ? { ref: row.ref, token: row.access_token } : null;
}

export interface OrderSummary {
  ref: string;
  token: string;
  status: string;
  createdAt: number;
  totalPence: number;
  items: number;
  fulfilment: string;
}

/**
 * Every order this customer has placed.
 *
 * **Gated on the reference *and* the email, never on a token.** A token proves
 * one order and travels in a link people forward; if this hung off that, a
 * forwarded confirmation would hand somebody the whole of another person's
 * buying history. Knowing a reference and the address it was placed with is
 * the higher bar, and it is the same one `findOrder` already sets.
 *
 * Matched case-insensitively, like `findOrder`, so somebody who typed
 * `Ali@Example.com` once and `ali@example.com` the next time is one customer.
 */
export async function ordersForCustomer(email: string): Promise<OrderSummary[]> {
  const { results } = await env.DB.prepare(
    `SELECT o.ref, o.access_token, o.status, o.created_at, o.fulfilment,
            COALESCE(o.total_pence, o.subtotal_pence) AS total_pence,
            (SELECT COALESCE(SUM(qty), 0) FROM order_items WHERE order_id = o.id) AS items
       FROM orders o
      WHERE LOWER(o.email) = LOWER(?)
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT 50`,
  )
    .bind(email.trim())
    .all<{
      ref: string; access_token: string; status: string; created_at: number;
      fulfilment: string; total_pence: number; items: number;
    }>();

  return results.map((r) => ({
    ref: r.ref,
    token: r.access_token,
    status: r.status,
    createdAt: r.created_at,
    totalPence: r.total_pence,
    items: r.items,
    fulfilment: r.fulfilment,
  }));
}

export interface OrderView {
  ref: string;
  status: string;
  customer_name: string;
  email: string;
  fulfilment: string;
  address: string | null;
  notes: string | null;
  subtotal_pence: number;
  created_at: number;
  expires_at: number | null;
  /** The reply deadline a landed delivery starts. Null on an ordinary order. */
  pay_by: number | null;
  /** Ties together the orders one checkout produced. See `splitGroup`. */
  split_group: string | null;
  /**
   * The shipment this was reserved from, if it was one.
   *
   * The discriminator between a reservation and an ordinary order, and the
   * only reliable one: `from_incoming` goes false the moment the box lands,
   * so a page asking "was this a reservation?" after arrival gets the wrong
   * answer from the lines.
   */
  shipment_id: number | null;
  telegram_chat_id: string | null;
  postage_pence: number | null;
  total_pence: number | null;
  confirmed_at: number | null;
  paid_at: number | null;
  dispatched_at: number | null;
  completed_at: number | null;
  tracking_number: string | null;
  postage_provider: string | null;
  postage_service: string | null;
  /**
   * The handle typed at checkout. No longer asked for - Telegram is now offered
   * to everyone through the deep link - but orders placed before that still
   * carry one, and the portal shows it as a way to reach them.
   */
  telegram: string | null;
  /** For collection orders: whether payment will be made in cash on pickup. */
  cash_payment: number;
  /** What the owner said when cancelling, if anything. */
  cancel_note: string | null;
  /** What the customer said, if anything. A different fact from the above. */
  customer_cancel_note: string | null;
  /** Set while a customer is waiting on the shop to answer a cancellation. */
  cancel_requested_at: number | null;
  /**
   * When books were last taken off this order, if they ever were.
   *
   * The record of what came off lives in `order_amendments`; this is what lets
   * a page decide whether that table is worth reading at all, which for nearly
   * every order it is not.
   */
  amended_at: number | null;
  /** The order's own id, for routes that act on it. */
  id: number;
  /** Messages the customer has not opened yet. */
  unread_for_customer: number;
  /** Messages the owner has not opened yet. */
  unread_for_owner: number;
  /** When the thread last moved, either way. Null on an order with no thread. */
  last_message_at: number | null;
  /**
   * The newest message's id, which is what the poll compares against.
   *
   * Separate from `last_message_at` because a cursor has to be monotonic and
   * whole seconds are not: two messages inside one second used to leave the
   * page's cursor equal to the time, so the poll concluded nothing had moved.
   */
  last_message_id: number | null;
  /** When the customer was last told there is a reply. Debounce marker. */
  message_notified_at: number | null;
  items: {
    title_snapshot: string; price_pence_snapshot: number; qty: number; slug: string | null;
    /** This line is a claim on a delivery, not a copy off the shelf. */
    from_incoming: number;
    /**
     * The shipment it is still on, if it is on one.
     *
     * A shipment row has no product page - deliberately, since it has no
     * cover, no description and an address like `sh61-4` - so a link to
     * `/book/<slug>` is a 404. It has a page all the same: the shipment's.
     */
    shipment_id: number | null;
    incoming_vague: string | null;
    incoming_month: string | null;
  }[];
}

/**
 * The other orders the same checkout produced.
 *
 * A basket holding shelf books and shipment books becomes one order per
 * parcel. Without this the customer is handed two references and nothing
 * saying they belong together - and no way back to the other one.
 *
 * Reachable only from an order whose token the reader already holds. They came
 * from one press of one button by one person, so somebody holding one of them
 * is entitled to the rest.
 */
export async function siblingOrders(
  splitGroup: string,
  exceptId: number,
): Promise<{ ref: string; access_token: string; shipment_id: number | null; status: string }[]> {
  const { results } = await env.DB.prepare(
    `SELECT ref, access_token, shipment_id, status FROM orders
      WHERE split_group = ? AND id != ? ORDER BY id`,
  )
    .bind(splitGroup, exceptId)
    .all<{ ref: string; access_token: string; shipment_id: number | null; status: string }>();
  return results;
}

/**
 * Just enough of an order to answer a poll.
 *
 * The order page asks every twenty seconds whether the status moved or a
 * message arrived, and `getOrder` answers that question by reading the whole
 * order and then every line on it - a second query, for items the poll never
 * looks at. Both sides poll now, so an idle conversation was costing four
 * statements a cycle to say that nothing had happened.
 *
 * A separate function rather than a flag on `getOrder`, because a flag returns
 * an `OrderView` whose `items` are silently empty and the next caller has no
 * way to know. This type simply has no items to read.
 */
export interface OrderPollView {
  id: number;
  status: string;
  unread_for_customer: number;
  unread_for_owner: number;
  last_message_id: number | null;
  last_message_at: number | null;
  completed_at: number | null;
}

/** The poll's read, token-checked exactly as `getOrder` is. */
export async function pollOrder(ref: string, token: string): Promise<OrderPollView | null> {
  const order = await env.DB.prepare(
    `SELECT id, status, access_token, completed_at,
            COALESCE(unread_for_customer, 0) AS unread_for_customer,
            COALESCE(unread_for_owner, 0) AS unread_for_owner,
            last_message_at, last_message_id
       FROM orders WHERE ref = ?`,
  )
    .bind(ref)
    .first<OrderPollView & { access_token: string }>();
  if (!order) return null;

  // The same constant-time-ish comparison `getOrder` makes: length, then a
  // full scan, so a timing difference does not leak the token a character at
  // a time.
  const a = new TextEncoder().encode(order.access_token);
  const b = new TextEncoder().encode(token);
  if (a.length !== b.length) return null;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  if (diff !== 0) return null;

  const { access_token: _drop, ...rest } = order;
  return rest;
}

/** The same narrow read for the portal, where the session is the authority. */
export async function pollOrderByRef(ref: string): Promise<OrderPollView | null> {
  return env.DB.prepare(
    `SELECT id, status, completed_at,
            COALESCE(unread_for_customer, 0) AS unread_for_customer,
            COALESCE(unread_for_owner, 0) AS unread_for_owner,
            last_message_at, last_message_id
       FROM orders WHERE ref = ?`,
  )
    .bind(ref)
    .first<OrderPollView>();
}

/** Token-checked so a guessed reference cannot expose someone else's order. */
export async function getOrder(ref: string, token: string): Promise<OrderView | null> {
  const order = await env.DB.prepare(
    `SELECT id, ref, status, customer_name, email, fulfilment, address, notes,
            subtotal_pence, postage_pence, total_pence, created_at, expires_at, pay_by,
            shipment_id, split_group,
            confirmed_at, paid_at, dispatched_at, completed_at, tracking_number,
            postage_provider, postage_service, telegram, cancel_note,
            customer_cancel_note, cancel_requested_at, amended_at,
            access_token, telegram_chat_id, COALESCE(cash_payment, 0) as cash_payment,
            COALESCE(unread_for_customer, 0) AS unread_for_customer,
            COALESCE(unread_for_owner, 0) AS unread_for_owner,
            last_message_at, last_message_id, message_notified_at
       FROM orders WHERE ref = ?`,
  )
    .bind(ref)
    .first<OrderView & { access_token: string }>();

  if (!order) return null;

  // Constant-time-ish comparison: length check then full scan, so a timing
  // difference does not leak the token a character at a time.
  const a = new TextEncoder().encode(order.access_token);
  const b = new TextEncoder().encode(token);
  if (a.length !== b.length) return null;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  if (diff !== 0) return null;

  const { results: items } = await env.DB.prepare(
    `SELECT oi.title_snapshot, oi.price_pence_snapshot, oi.qty, b.slug,
            oi.from_incoming, b.incoming_vague, b.incoming_month, b.shipment_id
       FROM order_items oi LEFT JOIN books b ON b.id = oi.book_id
      WHERE oi.order_id = (SELECT id FROM orders WHERE ref = ?)`,
  )
    .bind(ref)
    .all<OrderView['items'][number]>();

  const { access_token: _drop, ...rest } = order;
  return { ...rest, items };
}
