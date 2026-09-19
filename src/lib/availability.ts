/**
 * What may be sold right now, and for how much.
 *
 * One read, in one place, because two things depend on it and they must not
 * drift apart: placing an order, and adding a book to an order that has
 * already been placed. Both have to ask the same question - is this title
 * sellable, how many are free, and what does it cost today - and a second copy
 * of this query is how the portal would come to accept a book the shop cannot
 * build while checkout refuses it, or charge a sale price the catalogue has
 * stopped showing.
 *
 * It lived inside `createCheckout` until adding needed it too. Nothing about
 * the query changed in the move.
 */

import { env } from 'cloudflare:workers';

/**
 * Copies free now, for a row aliased `b` - pooled when it is part of a set.
 *
 * Shared with the channel sync, which has to show the same figure as the
 * catalogue: a set listing's own `stock - reserved` is not the truth once a
 * sibling listing holds some of the same volumes.
 */
export const AVAILABLE_SQL = `CASE WHEN b.set_id IS NULL THEN (b.stock - b.reserved)
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
            END`;

export interface Sellable {
  id: number;
  title: string;
  price_pence: number;
  /** Set when the book is on a shipment rather than on the shelf. */
  shipment_id: number | null;
  /** Copies that can be had now. Pooled, for a listing that is part of a set. */
  available: number;
  /** Copies of a delivery that are still free to claim. */
  reservable: number;
  /** Percent off while a sale is running, never zero. */
  sale_percent: number | null;
  sale_id: number | null;
}

/**
 * The sellable titles among the ids given, keyed by id.
 *
 * A missing id is the answer to "may this be sold?" - deleted, not live, or on
 * a shipment that has closed to reservations. Callers treat absence as a
 * refusal rather than checking a flag, so there is no way to read the row and
 * forget the gate that produced it.
 */
export async function sellable(ids: number[]): Promise<Map<number, Sellable>> {
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => '?').join(',');

  const { results } = await env.DB.prepare(
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
            ${AVAILABLE_SQL} AS available,
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
    .all<Sellable>();

  return new Map(results.map((row) => [row.id, row]));
}
