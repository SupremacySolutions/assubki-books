import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getOrderByRef, getOrderItems } from '../../../../../lib/admin-db';
import { canAmend, planAmendment, NOTE_MAX, type AmendableLine } from '../../../../../lib/amend';
import { notifyOrderAmended } from '../../../../../lib/notify';
import { forgetDashboard } from '../../../../../lib/dashboard';
import { readForm } from '../../../../../lib/request-body';

export const prerender = false;

/**
 * Books come off an order that has already been placed.
 *
 * The owner's only answers to "please take these three off" used to be cancel
 * the whole order or delete it, so the removal happened in the conversation and
 * nowhere else: the shop's record still said the customer wanted books they had
 * said they did not, and the copies stayed held against them.
 *
 * Deliberately not a status change. Nothing about where the order is in its
 * journey moves, so this needs none of the transition machinery and cannot put
 * an order into a state it should not be in. What it does move is stock, and
 * that half is written exactly the way cancelling writes it - the hold comes
 * off `reserved`, or off `reserved_incoming` for a claim on a delivery, and
 * every copy is appended to the ledger.
 *
 * Adding a title is not offered. It would need an availability check, the set
 * pool, a fresh hold and today's sale price, and getting any of those wrong
 * oversells the shelf; somebody who wants more books places another order,
 * which is what they already do.
 */
export const POST: APIRoute = async ({ params, request, url }) => {
  const ref = params.ref!;
  const order = await getOrderByRef(ref);
  if (!order) return new Response('No such order', { status: 404 });

  const back = (query: string) =>
    new Response(null, {
      status: 302,
      headers: { Location: `/admin/orders/${encodeURIComponent(order.ref)}${query}` },
    });

  // Up to payment and no further: after it the copies have left `stock` and any
  // money is settled outside this site, so there is nothing an endpoint here
  // could do that would not be a lie about where the books are.
  if (!canAmend(order.status)) return back('?e=state');

  const form = await readForm(request);
  if (!form) return new Response('Bad request', { status: 400 });

  const items = await getOrderItems(order.id);
  const lines: AmendableLine[] = items.map((item) => ({
    id: item.id,
    bookId: item.book_id,
    title: item.title_snapshot,
    pricePence: item.price_pence_snapshot,
    qty: item.qty,
    fromIncoming: item.from_incoming,
  }));

  // One field per line, named by the line's own id. A line the form did not
  // mention keeps what it has, so a stale page cannot silently drop a book that
  // was added to the order after it rendered.
  const wanted = new Map<number, number>();
  for (const line of lines) {
    const raw = form.get(`qty_${line.id}`);
    if (raw !== null) wanted.set(line.id, Number(raw));
  }

  const plan = planAmendment(lines, wanted, order.discount_pence ?? 0);
  if (plan.unchanged) return back('?e=nochange');
  // Emptying an order is a cancellation: it releases everything, tells the
  // customer it is over and files the order as cancelled. Doing that silently
  // under the name "amend" would leave a live order with nothing on it.
  if (plan.empties) return back('?e=empty');

  const note = String(form.get('note') ?? '').trim().slice(0, NOTE_MAX) || null;

  /*
   * Postage, when there is a total to keep in step with it.
   *
   * A smaller parcel often costs less to send, and the customer is holding a
   * message quoting the old figure - so the owner gets to correct both in one
   * action. Before the order is confirmed there is no total and no postage yet;
   * the confirm step still decides it, and nothing here invents one.
   */
  const quoted = order.total_pence !== null;
  const collecting = order.fulfilment === 'collection';
  const typedPostage = form.get('postage');
  const postagePence =
    collecting
      ? 0
      : quoted && typedPostage !== null
        ? Math.max(0, Math.round((Number(typedPostage) || 0) * 100))
        : (order.postage_pence ?? 0);

  /*
   * Everything below commits as one batch, guarded on the status this request
   * read. Nothing in the batch changes that status, so the guard is either true
   * for every statement or false for all of them - which is what makes an
   * amendment racing a cancellation, a payment or the expiry sweep come out as
   * one or the other and never as half of each.
   */
  const allowed = `EXISTS (SELECT 1 FROM orders o WHERE o.id = ?1 AND o.status = '${order.status}')`;
  /*
   * The order's own lines are what decide its subtotal, read back after this
   * batch's own deletes rather than taken from a number worked out in JS. If
   * anything else has moved a line, the figures still describe the order that
   * actually exists.
   */
  const GROSS = `(SELECT COALESCE(SUM(price_pence_snapshot * qty), 0)
                    FROM order_items WHERE order_id = ?1)`;

  /*
   * Every line this touches, and what it should be left holding.
   *
   * The copies released are worked out from `order_items` against this, never
   * from a quantity carried in the request: `qty - keep`, read as the row
   * actually stands. Two submissions of the same form arriving together
   * therefore cannot take the same copies off twice - the second sees rows that
   * are already trimmed or gone, subtracts nothing, and cannot drive `reserved`
   * below nought against its CHECK. (Sequential double-submits never get this
   * far: the second request re-reads the lines, finds them already amended and
   * is refused as changing nothing.)
   *
   * A line whose book has since been deleted still comes off the order; there
   * is simply no stock row left to give its copies back to.
   */
  const changes = JSON.stringify(
    plan.removed.map((r) => ({
      id: r.id,
      bookId: r.bookId,
      keep: r.remaining,
      fromIncoming: r.fromIncoming ? 1 : 0,
    })),
  );
  const gone = JSON.stringify(plan.removed.filter((r) => r.remaining === 0).map((r) => r.id));
  const trimmed = JSON.stringify(
    plan.removed.filter((r) => r.remaining > 0).map((r) => ({ id: r.id, keep: r.remaining })),
  );
  const removedRecord = JSON.stringify(
    plan.removed.map((r) => ({ title: r.title, qty: r.qty, pricePence: r.pricePence })),
  );

  const statements: D1PreparedStatement[] = [];

  if (plan.removed.some((r) => r.bookId !== null)) {
    // A hold lives in `reserved`; a claim on a delivery lives in
    // `reserved_incoming` and never entered `reserved` at all. Same statement,
    // written twice against the column each kind of line actually occupies.
    for (const field of ['reserved', 'reserved_incoming'] as const) {
      const claim = field === 'reserved' ? 0 : 1;
      statements.push(
        env.DB.prepare(
          `UPDATE books SET ${field} = ${field} - COALESCE((
                 SELECT SUM(oi.qty - json_extract(j.value, '$.keep'))
                   FROM json_each(?2) j
                   JOIN order_items oi ON oi.id = json_extract(j.value, '$.id')
                  WHERE oi.order_id = ?1 AND oi.book_id = books.id
                    AND oi.from_incoming = ${claim}), 0),
               updated_at = unixepoch()
            WHERE id IN (SELECT json_extract(value, '$.bookId') FROM json_each(?2)
                          WHERE json_extract(value, '$.fromIncoming') = ${claim})
              AND ${allowed}`,
        ).bind(order.id, changes),
      );
    }

    /*
     * Only the shelf half is written to the ledger, exactly as releasing a hold
     * does. A claim on a delivery never entered `reserved`, so a ledger row for
     * it would describe a movement of copies that were never on a shelf - and
     * break the invariant the suite checks, that a book's `reserved` equals the
     * sum of its ledger deltas.
     *
     * The HAVING is what keeps that invariant honest under a repeat: a release
     * of nought is not a movement, and a row saying it happened would be a
     * line in the record for copies that did not go anywhere.
     */
    statements.push(
      env.DB.prepare(
        `INSERT INTO stock_ledger (book_id, delta, field, reason, order_id)
         SELECT oi.book_id, -SUM(oi.qty - json_extract(j.value, '$.keep')),
                'reserved', 'order amended', ?1
           FROM json_each(?2) j
           JOIN order_items oi ON oi.id = json_extract(j.value, '$.id')
          WHERE oi.order_id = ?1 AND oi.from_incoming = 0 AND oi.book_id IS NOT NULL
            AND ${allowed}
          GROUP BY oi.book_id
         HAVING SUM(oi.qty - json_extract(j.value, '$.keep')) > 0`,
      ).bind(order.id, changes),
    );
  }

  // `order_items.qty` is CHECKed above zero, so a line that goes entirely is
  // deleted rather than set to nought.
  if (plan.removed.some((r) => r.remaining === 0)) {
    statements.push(
      env.DB.prepare(
        `DELETE FROM order_items
           WHERE order_id = ?1 AND id IN (SELECT value FROM json_each(?2)) AND ${allowed}`,
      ).bind(order.id, gone),
    );
  }

  if (plan.removed.some((r) => r.remaining > 0)) {
    statements.push(
      env.DB.prepare(
        `UPDATE order_items
            SET qty = (SELECT json_extract(j.value, '$.keep') FROM json_each(?2) j
                        WHERE json_extract(j.value, '$.id') = order_items.id)
          WHERE order_id = ?1
            AND id IN (SELECT json_extract(value, '$.id') FROM json_each(?2))
            AND ${allowed}`,
      ).bind(order.id, trimmed),
    );
  }

  /*
   * The record, written before the order is updated so it can read both sides:
   * the lines are already trimmed at this point, and the order still carries
   * the figures it was quoted.
   */
  statements.push(
    env.DB.prepare(
      `INSERT INTO order_amendments
         (order_id, removed, note, subtotal_before, subtotal_after, total_before, total_after)
       SELECT ?1, ?2, ?3, o.subtotal_pence, ${GROSS} - MIN(?4, ${GROSS}), o.total_pence,
              CASE WHEN o.total_pence IS NULL THEN NULL
                   ELSE ${GROSS} - MIN(?4, ${GROSS}) + ?5 END
         FROM orders o WHERE o.id = ?1 AND ${allowed}`,
    ).bind(order.id, removedRecord, note, plan.discountAfter, postagePence),
  );

  /*
   * Last, and the one whose row count is read: if the guard has gone false
   * every statement above no-opped with it, so a zero here means the whole
   * amendment did not happen rather than half of it.
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
              updated_at = unixepoch()
        WHERE id = ?1 AND ${allowed}`,
    ).bind(order.id, plan.discountAfter, postagePence),
  );

  const done = await env.DB.batch(statements);
  if (!done[done.length - 1].meta.changes) return back('?e=state');

  forgetDashboard();

  /*
   * Read back rather than assumed. The figures the customer is sent have to be
   * the ones the database now holds - that is the whole complaint an amendment
   * answers - and the subtotal was written by SQL from the lines themselves.
   */
  const [amended, remaining] = await Promise.all([
    getOrderByRef(order.ref),
    getOrderItems(order.id),
  ]);

  const sent = await notifyOrderAmended({
    ref: order.ref,
    token: order.access_token,
    name: order.customer_name,
    email: order.email,
    telegramChatId: order.telegram_chat_id,
    removed: plan.removed.map((r) => ({ title: r.title, qty: r.qty, pricePence: r.pricePence })),
    items: remaining.map((i) => ({
      title: i.title_snapshot,
      qty: i.qty,
      pricePence: i.price_pence_snapshot,
    })),
    subtotalPence: amended?.subtotal_pence ?? plan.subtotalAfter,
    postagePence: amended?.postage_pence ?? postagePence,
    totalPence: amended?.total_pence ?? null,
    fulfilment: order.fulfilment,
    cashPayment: Boolean(order.cash_payment),
    note,
    origin: url.origin,
  }).catch((err) => {
    console.error('[admin] amendment notification failed', ref, err);
    return { email: false, telegram: false };
  });

  /*
   * The change stands either way.
   *
   * Confirming an order is held back when nothing could be delivered, because
   * an order marked "awaiting payment" that the customer never heard about
   * looks handled and is not. This is the opposite case: the copies are already
   * back on the shelf and somebody else may have taken them by the time a
   * retry could happen, so undoing it to make the send succeed would be the
   * worse outcome. The owner is told what did not go out and can say it in the
   * thread, which reaches the same person.
   */
  // `told` rather than `sent`: the confirm step already owns `sent`, and its
  // banner announces that payment details went out - which is not what
  // happened here.
  const via = [sent.telegram && 'telegram', sent.email && 'email'].filter(Boolean).join('+');
  return back(`?amended=${plan.removed.length}&told=${via}`);
};
