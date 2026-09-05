-- Shipments: the box of books, as a thing the database knows about.
--
-- The shop buys in bulk a few times a year, and until now the only notion of
-- "coming soon" was three columns on a single listing. Nothing tied together
-- the books that arrive in the same box, so announcing forty titles was forty
-- separate edits and a customer had no page that said what was coming.
--
-- Almost none of the machinery is new. `order_items.from_incoming`,
-- `books.reserved_incoming`, the oversell trigger and the first-promised-first-
-- served filling in `arrived.ts` already exist and are correct; they have simply
-- never been used, because nothing in the shop has ever had a delivery coming.
-- What was missing is the grouping, and a deadline once the box lands.

CREATE TABLE shipments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  title          TEXT NOT NULL,               -- 'India Shipment August 2026'
  note           TEXT,                        -- shown to customers under the list
  /*
   * draft   - being pasted and checked over, nobody can see it
   * open    - customers can reserve
   * arrived - the box landed; the list stays readable, reservations are shut
   * closed  - put away
   */
  status         TEXT NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','open','arrived','closed')),
  -- Same vocabulary as books.incoming_vague / incoming_month, so `whenText`
  -- in src/lib/incoming.ts formats a shipment exactly as it formats a book.
  incoming_vague TEXT,
  incoming_month TEXT,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  opened_at      INTEGER,
  arrived_at     INTEGER
);

CREATE INDEX idx_shipments_status ON shipments(status);

/*
 * A shipment item is a `books` row, not a record of its own kind.
 *
 * That decision is what keeps the rest of this small: orders, holds, the
 * oversell trigger, message threads, Telegram, cancellation and the arrival
 * logic all keep working with no knowledge of shipments at all. And turning a
 * leftover copy into an ordinary listing becomes a status change rather than
 * copying a row between tables - which would mean rewriting `order_items
 * .book_id` on orders that already have money attached to them.
 *
 * `shipment_id` is the discriminator, deliberately not a fourth value of
 * `books.status`. That column carries `CHECK (status IN ('draft','live',
 * 'archived'))` from the original schema, and SQLite cannot alter a CHECK -
 * adding a value means rebuilding a table that six foreign keys, an
 * external-content FTS5 index and four triggers point at. Not on a live shop.
 */
ALTER TABLE books ADD COLUMN shipment_id   INTEGER REFERENCES shipments(id) ON DELETE SET NULL;
ALTER TABLE books ADD COLUMN shipment_sort INTEGER;

ALTER TABLE orders ADD COLUMN shipment_id INTEGER REFERENCES shipments(id);

/*
 * A deadline of its own, and emphatically not a reuse of `expires_at`.
 *
 * They are two different promises - forty-eight hours to decide on a copy that
 * is on the shelf, seven days to reply once a delivery has landed - and the
 * order page has to be able to word them differently.
 *
 * The safety matters more than the wording. `confirm.ts` does not clear
 * `expires_at`, so every order sitting in `awaiting_payment` today still
 * carries the stale forty-eight hour value it was created with, long in the
 * past. A sweep written as `status IN ('requested','awaiting_payment') AND
 * expires_at <= now` would expire every live confirmed order in the shop
 * within fifteen minutes of deploying and release all of their stock. A column
 * that nothing existing carries cannot do that to anybody.
 */
ALTER TABLE orders ADD COLUMN pay_by INTEGER;

/*
 * Telling everyone the box landed, without spending the day's email.
 *
 * A shipment with forty reservations cannot be announced inside the button
 * press: the mail provider allows a hundred messages a day and a Worker caps
 * how many outbound requests one handler may make. Forty sends in one request
 * risks failing halfway, having told some customers and not others, with no
 * record of which.
 *
 * So arrival queues, and the sweep that already runs every fifteen minutes
 * drains it in small batches. `UNIQUE (shipment_id, order_id)` is what makes a
 * second press of the button - or a retry - unable to tell anyone twice.
 */
CREATE TABLE shipment_notices (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  shipment_id INTEGER NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  order_id    INTEGER NOT NULL REFERENCES orders(id)    ON DELETE CASCADE,
  queued_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  sent_at     INTEGER,
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  UNIQUE (shipment_id, order_id)
);

CREATE INDEX idx_books_shipment  ON books(shipment_id, shipment_sort) WHERE shipment_id IS NOT NULL;
CREATE INDEX idx_orders_shipment ON orders(shipment_id) WHERE shipment_id IS NOT NULL;
CREATE INDEX idx_orders_pay_by   ON orders(status, pay_by) WHERE pay_by IS NOT NULL;
CREATE INDEX idx_notices_pending ON shipment_notices(sent_at, id) WHERE sent_at IS NULL;

/*
 * The oversell guard, closed on the way in as well as the way out.
 *
 * `books_incoming_not_oversold` from 0020 is `BEFORE UPDATE OF`, so a row could
 * be inserted already claiming more copies than are coming. Nothing did that
 * while the only writer was the portal's own form; the shipment importer
 * inserts rows with `incoming` set, so it is worth closing now rather than
 * trusting every future caller.
 */
CREATE TRIGGER books_incoming_not_oversold_insert
BEFORE INSERT ON books WHEN NEW.reserved_incoming > NEW.incoming
BEGIN
  SELECT RAISE(ABORT, 'more copies claimed than are coming');
END;
