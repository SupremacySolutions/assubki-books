-- A sale: a named set of books, each with its own percentage off.
--
-- One runs at a time. That is a database rule rather than a habit, because
-- "putting this live ends the other one" is exactly the kind of thing that
-- gets forgotten in a route and leaves two sales both claiming a book.
CREATE TABLE sales (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Customer-facing: it becomes the heading on the home page row.
  name       TEXT    NOT NULL,
  -- The owner's optional line beneath the heading.
  blurb      TEXT,
  status     TEXT    NOT NULL DEFAULT 'draft'
             CHECK (status IN ('draft', 'live', 'ended')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  started_at INTEGER,
  ended_at   INTEGER
);

-- Only one live sale, enforced rather than remembered.
CREATE UNIQUE INDEX idx_sales_one_live ON sales(status) WHERE status = 'live';

-- What is in it, and by how much.
--
-- A row exists only for a book actually in the sale: the owner's screen treats
-- a blank or zero percentage as "not in the sale", so it deletes the row
-- rather than storing a zero that would have to be filtered out everywhere.
CREATE TABLE sale_items (
  sale_id     INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  book_id     INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  percent_off INTEGER NOT NULL CHECK (percent_off > 0 AND percent_off <= 90),
  PRIMARY KEY (sale_id, book_id)
);

-- The join runs on every catalogue page, so it is indexed by the column it is
-- joined on. A correlated subquery here is what once ate the read budget.
CREATE INDEX idx_sale_items_book ON sale_items(book_id);

-- What came off this order, so the order page, the emails and the portal all
-- show the same number rather than three recalculations that can disagree.
--
-- Only the order-level discount. A sale price is already inside
-- price_pence_snapshot, where it belongs: it is the price that was charged.
ALTER TABLE orders ADD COLUMN discount_pence INTEGER NOT NULL DEFAULT 0
  CHECK (discount_pence >= 0);
