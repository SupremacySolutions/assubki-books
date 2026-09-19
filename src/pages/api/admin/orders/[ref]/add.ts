import type { APIRoute } from 'astro';
import { syncChannelSoon } from '../../../../../lib/publish';
import { env } from 'cloudflare:workers';
import { getOrderByRef, getOrderItems } from '../../../../../lib/admin-db';
import {
  canAmend,
  howToAdd,
  planAddition,
  NOTE_MAX,
  type AddCandidate,
  type AmendableLine,
} from '../../../../../lib/amend';
import { sellable } from '../../../../../lib/availability';
import { salePrice } from '../../../../../lib/sales';
import { notifyBooksAdded } from '../../../../../lib/notify';
import { forgetDashboard } from '../../../../../lib/dashboard';
import { postMessage } from '../../../../../lib/messages';
import { readForm } from '../../../../../lib/request-body';
import { HOLD_HOURS, expireStaleHolds } from '../../../../../lib/orders';

export const prerender = false;

/** A hand-typed quantity that is plainly a slip rather than an order. */
const MAX_PER_LINE = 50;

/**
 * Books go on to an order that has already been placed.
 *
 * The mirror of `amend` beside it, and written to the same shape on purpose:
 * one guarded batch, figures read back out of the order's own lines, and a
 * change that stands whether or not the customer could be told. What it has
 * that removing does not is the hard half - a book going on has to be
 * available, priced at today's sale, and held before anyone else takes it.
 *
 * None of that arithmetic is done here. `lib/availability` is the one read that
 * decides what may be sold and for how much - the same read checkout uses, so
 * the portal cannot accept a title the shop would refuse a customer - and
 * `howToAdd` decides whether this order is the right kind to take it. What is
 * left here is the writing.
 *
 * Deliberately not a status change, again. Nothing about where the order is in
 * its journey moves; what moves is stock, written exactly the way checkout
 * writes it - on to `reserved`, or `reserved_incoming` for a claim on a
 * delivery, with every shelf copy appended to the ledger.
 */
export const POST: APIRoute = async ({ params, request, url, locals }) => {
  const ref = params.ref!;
  const order = await getOrderByRef(ref);
  if (!order) return new Response('No such order', { status: 404 });

  const back = (query: string) =>
    new Response(null, {
      status: 302,
      headers: { Location: `/admin/orders/${encodeURIComponent(order.ref)}${query}` },
    });

  // The same gate as removing: up to payment and no further. After it the
  // copies have left `stock` and the money has been agreed, so putting another
  // book on would be quoting a total nobody has paid against an order that is
  // already settled.
  if (!canAmend(order.status)) return back('?e=state');

  const form = await readForm(request);
  if (!form) return new Response('Bad request', { status: 400 });

  /*
   * One field per chosen title, `add_<book id>` carrying a quantity.
   *
   * Nothing else about the book is read from the form. A price or a title
   * arriving in a POST is a price or a title the browser chose, and both are
   * about to be snapshotted on to the order for ever.
   */
  const wanted = new Map<number, number>();
  for (const key of [...form.keys()]) {
    const match = key.match(/^add_(\d+)$/);
    if (!match) continue;
    const qty = Math.trunc(Number(form.get(key)));
    if (!Number.isFinite(qty) || qty < 1) continue;
    wanted.set(Number(match[1]), Math.min(MAX_PER_LINE, qty));
  }
  if (!wanted.size) return back('?e=noadd');

  /*
   * Deadlines first, exactly as checkout does it.
   *
   * Whether the last copy of something is free must not depend on when the
   * cron Worker last fired - and this is the one path where the owner is
   * looking at a stock figure the picker read a minute ago.
   */
  await expireStaleHolds();

  const [items, priced] = await Promise.all([
    getOrderItems(order.id),
    sellable([...wanted.keys()]),
  ]);

  const lines: AmendableLine[] = items.map((item) => ({
    id: item.id,
    bookId: item.book_id,
    title: item.title_snapshot,
    pricePence: item.price_pence_snapshot,
    qty: item.qty,
    fromIncoming: item.from_incoming,
  }));

  /*
   * What may actually go on, cut to what is free.
   *
   * A book that has sold out since the picker listed it is dropped rather than
   * failing the whole submission: the owner chose three titles and two are
   * still there, and refusing all three would mean doing the search again to
   * find out which. If that leaves nothing, the refusal below says so in the
   * words `ADD_REFUSAL.gone` gives it.
   */
  const candidates: AddCandidate[] = [];
  for (const [bookId, qty] of wanted) {
    const book = priced.get(bookId);
    if (!book) continue;
    const verdict = howToAdd(order.shipment_id, book);
    if (!verdict.ok) continue;

    candidates.push({
      bookId: book.id,
      title: book.title,
      pricePence: salePrice(book.price_pence, book.sale_percent),
      // What it was reduced from and which sale did it, recorded because this
      // is the only moment both are true - the reasoning in `createCheckout`.
      fullPricePence: book.price_pence,
      saleId: book.sale_percent ? book.sale_id : null,
      qty: Math.min(qty, verdict.free),
      fromIncoming: verdict.fromIncoming,
    });
  }

  const plan = planAddition(lines, candidates, order.discount_pence ?? 0);
  if (plan.unchanged) return back('?e=gone');

  const note = String(form.get('note') ?? '').trim().slice(0, NOTE_MAX) || null;

  /*
   * Postage, when there is a total to keep in step with it. A bigger parcel
   * often costs more to send, and the customer is holding a message quoting
   * the old figure - so the owner corrects both in one action. Before the order
   * is confirmed there is no total and no postage yet, and nothing here invents
   * one.
   */
  const quoted = order.total_pence !== null;
  const collecting = order.fulfilment === 'collection';
  const typedPostage = form.get('postage');
  const postagePence = collecting
    ? 0
    : quoted && typedPostage !== null
      ? Math.max(0, Math.round((Number(typedPostage) || 0) * 100))
      : (order.postage_pence ?? 0);

  /*
   * Everything below commits as one batch, guarded on the status this request
   * read. Nothing in the batch changes that status, so the guard is either true
   * for every statement or false for all of them - which is what makes an
   * addition racing a cancellation, a payment or the expiry sweep come out as
   * one or the other and never as half of each.
   */
  const allowed = `EXISTS (SELECT 1 FROM orders o WHERE o.id = ?1 AND o.status = '${order.status}')`;
  /*
   * The order's subtotal is read back out of its own lines after this batch's
   * own inserts, never taken from a number worked out in JS - the same rule
   * amending follows, and the reason the figures always describe the order
   * that actually exists.
   */
  const GROSS = `(SELECT COALESCE(SUM(price_pence_snapshot * qty), 0)
                    FROM order_items WHERE order_id = ?1)`;

  const fresh = JSON.stringify(
    plan.added
      .filter((line) => line.mergesInto === null)
      .map((line) => ({
        bookId: line.bookId,
        title: line.title,
        pricePence: line.pricePence,
        fullPricePence: line.fullPricePence,
        saleId: line.saleId,
        qty: line.qty,
        fromIncoming: line.fromIncoming ? 1 : 0,
      })),
  );
  const joined = JSON.stringify(
    plan.added
      .filter((line) => line.mergesInto !== null)
      .map((line) => ({ id: line.mergesInto, qty: line.qty })),
  );
  /*
   * The holds, by book and by which column they land in.
   *
   * Taken from the plan rather than derived from `order_items` afterwards.
   * Removing can derive its release from the rows because it is idempotent by
   * construction - a second submission finds the line already trimmed and
   * subtracts nothing. Adding has no such shape: two copies added twice are
   * four copies, which is what the owner asked for both times. What stops a
   * double-press turning into an oversell is the same thing that stops
   * checkout doing it - `CHECK (reserved <= stock)`, the set-pool trigger and
   * the incoming guard, which abort the batch rather than let it through.
   */
  const byBook = new Map<string, { bookId: number; qty: number; fromIncoming: number }>();
  for (const line of plan.added) {
    const key = `${line.bookId}:${line.fromIncoming}`;
    const running = byBook.get(key);
    if (running) running.qty += line.qty;
    else byBook.set(key, { bookId: line.bookId, qty: line.qty, fromIncoming: line.fromIncoming ? 1 : 0 });
  }
  const holds = JSON.stringify([...byBook.values()]);

  const addedRecord = JSON.stringify(
    plan.added.map((line) => ({ title: line.title, qty: line.qty, pricePence: line.pricePence })),
  );

  const statements: D1PreparedStatement[] = [];

  if (plan.added.some((line) => line.mergesInto === null)) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO order_items
           (order_id, book_id, title_snapshot, price_pence_snapshot, qty, from_incoming,
            sale_id, full_price_pence)
         SELECT ?1, json_extract(value, '$.bookId'), json_extract(value, '$.title'),
                json_extract(value, '$.pricePence'), json_extract(value, '$.qty'),
                json_extract(value, '$.fromIncoming'), json_extract(value, '$.saleId'),
                json_extract(value, '$.fullPricePence')
           FROM json_each(?2) WHERE ${allowed}`,
      ).bind(order.id, fresh),
    );
  }

  // A line for the same book at the same price, held the same way, is that
  // line with a bigger number on it. See `AddedLine.mergesInto`.
  if (plan.added.some((line) => line.mergesInto !== null)) {
    statements.push(
      env.DB.prepare(
        `UPDATE order_items
            SET qty = qty + (SELECT json_extract(j.value, '$.qty') FROM json_each(?2) j
                              WHERE json_extract(j.value, '$.id') = order_items.id)
          WHERE order_id = ?1
            AND id IN (SELECT json_extract(value, '$.id') FROM json_each(?2))
            AND ${allowed}`,
      ).bind(order.id, joined),
    );
  }

  // The copies come off the shelf now, in the column this order's kind of hold
  // lives in. `reserved` and `reserved_incoming` are never both touched for one
  // book by one addition - `howToAdd` allows only one kind per order.
  for (const field of ['reserved', 'reserved_incoming'] as const) {
    const claim = field === 'reserved' ? 0 : 1;
    statements.push(
      env.DB.prepare(
        `UPDATE books SET ${field} = ${field} + COALESCE((
               SELECT SUM(json_extract(j.value, '$.qty')) FROM json_each(?2) j
                WHERE json_extract(j.value, '$.bookId') = books.id
                  AND json_extract(j.value, '$.fromIncoming') = ${claim}), 0),
             updated_at = unixepoch()
          WHERE id IN (SELECT json_extract(value, '$.bookId') FROM json_each(?2)
                        WHERE json_extract(value, '$.fromIncoming') = ${claim})
            AND ${allowed}`,
      ).bind(order.id, holds),
    );
  }

  /*
   * Only the shelf half is ledgered, exactly as checkout does it. A claim on a
   * delivery never enters `reserved`, so a ledger row for it would describe a
   * movement of copies that were never on a shelf - and break the invariant the
   * suite checks, that a book's `reserved` equals the sum of its ledger deltas.
   */
  if (plan.added.some((line) => !line.fromIncoming)) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO stock_ledger (book_id, delta, field, reason, order_id)
         SELECT json_extract(value, '$.bookId'), json_extract(value, '$.qty'),
                'reserved', 'books added', ?1
           FROM json_each(?2)
          WHERE json_extract(value, '$.fromIncoming') = 0 AND ${allowed}`,
      ).bind(order.id, holds),
    );
  }

  /*
   * The record, written before the order is updated so it can read both sides:
   * the lines are already in place at this point, and the order still carries
   * the figures it was quoted. `removed` is not null-able and is the empty list
   * here - this row is an addition, and says so by carrying one and not the
   * other.
   */
  statements.push(
    env.DB.prepare(
      `INSERT INTO order_amendments
         (order_id, removed, added, note, subtotal_before, subtotal_after,
          total_before, total_after)
       SELECT ?1, '[]', ?2, ?3, o.subtotal_pence, ${GROSS} - MIN(?4, ${GROSS}), o.total_pence,
              CASE WHEN o.total_pence IS NULL THEN NULL
                   ELSE ${GROSS} - MIN(?4, ${GROSS}) + ?5 END
         FROM orders o WHERE o.id = ?1 AND ${allowed}`,
    ).bind(order.id, addedRecord, note, plan.discountAfter, postagePence),
  );

  /*
   * Last, and the one whose row count is read: if the guard has gone false
   * every statement above no-opped with it, so a zero here means the whole
   * addition did not happen rather than half of it.
   */
  statements.push(
    env.DB.prepare(
      `UPDATE orders
          SET discount_pence = MIN(?2, ${GROSS}),
              subtotal_pence = ${GROSS} - MIN(?2, ${GROSS}),
              postage_pence = CASE WHEN total_pence IS NULL THEN postage_pence ELSE ?3 END,
              total_pence = CASE WHEN total_pence IS NULL THEN NULL
                                 ELSE ${GROSS} - MIN(?2, ${GROSS}) + ?3 END,
              amended_at = unixepoch(),
              -- Editing an order restarts its hold and clears any lapse, for
              -- the reason removing does: the owner working on an order is the
              -- clearest evidence it is still live, and the sweep had taken one
              -- out from under exactly that. Only while it is still a shelf
              -- hold - the expiry column is stale on a confirmed order by
              -- design, and writing a fresh one there would invent a deadline
              -- that order does not have.
              expires_at = CASE WHEN status = 'requested' AND expires_at IS NOT NULL
                                THEN unixepoch() + ${HOLD_HOURS * 3600} ELSE expires_at END,
              lapsed_at = CASE WHEN status = 'requested' THEN NULL ELSE lapsed_at END,
              updated_at = unixepoch()
        WHERE id = ?1 AND ${allowed}`,
    ).bind(order.id, plan.discountAfter, postagePence),
  );

  let done;
  try {
    done = await env.DB.batch(statements);
  } catch (err) {
    /*
     * The shelf said no, and the shelf is the authority.
     *
     * Between the availability read a moment ago and this batch, a customer can
     * have taken the last copy. The CHECK constraints and the set-pool trigger
     * abort the whole batch when that happens, which is precisely the outcome
     * wanted: the order is untouched and the owner is told the copies have
     * gone, in the same words as a picker that had already noticed.
     */
    const message = String(err);
    if (/reserved <= stock|set pool oversold|more copies claimed|shipment is not open/.test(message)) {
      return back('?e=gone');
    }
    throw err;
  }
  if (!done[done.length - 1].meta.changes) return back('?e=state');

  forgetDashboard();
  await syncChannelSoon(locals, url.origin);

  /*
   * The note goes into the thread as well as into the email, for the reason
   * spelled out in `amend`: a question the owner asks while editing an order
   * has to exist in that order's own conversation, not only in the customer's
   * inbox. Verbatim and unprefixed - it is the owner's own sentence.
   *
   * `postMessage` writes the row and moves the unread counter; it sends
   * nothing. The note is already in the email going out below, and a second
   * notification would deliver the same sentence twice.
   */
  if (note) {
    await postMessage({ orderId: order.id, sender: 'owner', via: 'web', body: note }).catch(
      (err) => {
        // The addition itself stands. A thread missing a line is the problem
        // this solves, not a reason to undo the change that caused it.
        console.error('[admin] addition note could not be threaded', ref, err);
        return null;
      },
    );
  }

  /*
   * Read back rather than assumed. The figures the customer is sent have to be
   * the ones the database now holds - the subtotal was written by SQL from the
   * lines themselves, and the lines are what the order actually has.
   */
  const [changed, holding] = await Promise.all([
    getOrderByRef(order.ref),
    getOrderItems(order.id),
  ]);

  const sent = await notifyBooksAdded({
    ref: order.ref,
    token: order.access_token,
    name: order.customer_name,
    email: order.email,
    telegramChatId: order.telegram_chat_id,
    added: plan.added.map((line) => ({
      title: line.title,
      qty: line.qty,
      pricePence: line.pricePence,
    })),
    items: holding.map((i) => ({
      title: i.title_snapshot,
      qty: i.qty,
      pricePence: i.price_pence_snapshot,
    })),
    fromIncoming: order.shipment_id !== null,
    subtotalPence: changed?.subtotal_pence ?? plan.subtotalAfter,
    postagePence: changed?.postage_pence ?? postagePence,
    totalPence: changed?.total_pence ?? null,
    fulfilment: order.fulfilment,
    cashPayment: Boolean(order.cash_payment),
    note,
    origin: url.origin,
  }).catch((err) => {
    console.error('[admin] addition notification failed', ref, err);
    return { email: false, telegram: false };
  });

  /*
   * The change stands either way, as it does for a removal - but for the
   * opposite reason. There the copies were already back on the shelf and
   * undoing would have been worse; here the copies are held, and releasing
   * them again because an email bounced would lose the customer the books the
   * owner has just put aside for them. The owner is told what did not go out
   * and can say it in the thread, which reaches the same person.
   */
  const via = [sent.telegram && 'telegram', sent.email && 'email'].filter(Boolean).join('+');
  return back(`?added=${plan.copies}&told=${via}`);
};
