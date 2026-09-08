-- Amending an order: taking books off one that has already been placed.
--
-- The gap this closes is a real conversation. A customer wrote asking for three
-- titles to be taken off an order, and there was nothing the owner could press:
-- the portal could cancel the whole thing or delete it, and neither is what was
-- asked for. The order was left as it stood and the removal happened only in
-- the messages, so the shop's own record still said the customer wanted books
-- they had said they did not, and the copies stayed held against them.
--
-- What an amendment is, precisely: copies come off an order and go back to
-- being available, and the order's own figures follow them. It is not a status
-- change - nothing about where the order is in its journey moves - so it needs
-- none of the transition machinery and cannot put an order into a state it
-- should not be in.

-- What was taken off, kept the way `order_items` keeps titles: snapshotted.
--
-- The stock ledger already answers "where did that copy go?" - every release
-- here writes to it - but it cannot answer "what did this order look like
-- before?", because the lines it refers to are gone. Payment is agreed days
-- later over Telegram, so an order has to be able to show what was agreed and
-- when it changed, and a customer who was quoted one total and then another is
-- entitled to see why.
CREATE TABLE order_amendments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id        INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  at              INTEGER NOT NULL DEFAULT (unixepoch()),
  -- JSON: [{ "title": …, "qty": …, "pricePence": … }], as the lines read at the
  -- time. Not a foreign key to books: a title removed from an order and later
  -- deleted from the catalogue must still name itself here.
  removed         TEXT    NOT NULL,
  -- The owner's own words to the customer, if they wrote any. The same fact as
  -- `cancel_note` is on a cancellation, and shown in the same places.
  note            TEXT,
  -- Both figures, so the record reads as a change rather than a state. The
  -- totals are null on an order that had not been quoted one yet.
  subtotal_before INTEGER NOT NULL,
  subtotal_after  INTEGER NOT NULL,
  total_before    INTEGER,
  total_after     INTEGER
);

CREATE INDEX idx_amendments_order ON order_amendments(order_id, at);

-- Set on the order itself so the pages that show an amendment can decide
-- whether to look for one without reading a second table on every view.
--
-- The same reasoning that took `categoryCounts` out of SQL: the customer's
-- order page and the portal's order page are opened all day, and almost no
-- order is ever amended. A null here is the answer for nearly all of them.
ALTER TABLE orders ADD COLUMN amended_at INTEGER;
