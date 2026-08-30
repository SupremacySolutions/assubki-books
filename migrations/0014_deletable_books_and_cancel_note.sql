-- Two unrelated things a listing and an order each needed.
--
-- 1. A book that has ever been in a group basket could not be deleted.
--
--    `group_basket_items.book_id` was the only foreign key onto `books`
--    without an ON DELETE clause - the other four are CASCADE or SET NULL - so
--    a single leftover row in somebody's shared basket refused the delete, and
--    the portal had nothing useful to say about why. SQLite cannot alter a
--    constraint, so the table is rebuilt.
--
--    CASCADE rather than SET NULL because a group basket is a shopping list,
--    not a record: once the book is gone the line means nothing. That is the
--    opposite of `order_items`, which keeps its own title and price snapshot
--    precisely so a past order still reads correctly afterwards.
--
-- 2. Cancelling an order could not carry a reason.

PRAGMA foreign_keys = OFF;

CREATE TABLE group_basket_items_rebuild (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id   INTEGER NOT NULL REFERENCES group_baskets(id) ON DELETE CASCADE,
  book_id    INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  qty        INTEGER NOT NULL CHECK (qty > 0 AND qty <= 99),
  -- Whose copy it is. Forty books and no idea whose is whose would leave the
  -- organiser worse off than the pile of messages this replaces.
  added_by   TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (group_id, book_id, added_by)
);

INSERT INTO group_basket_items_rebuild (id, group_id, book_id, qty, added_by, updated_at)
  SELECT id, group_id, book_id, qty, added_by, updated_at FROM group_basket_items;

DROP TABLE group_basket_items;
ALTER TABLE group_basket_items_rebuild RENAME TO group_basket_items;
CREATE INDEX idx_group_items_group ON group_basket_items(group_id);

PRAGMA foreign_keys = ON;

-- Why the order was cancelled, in the owner's own words. Shown on the
-- customer's order page and sent with the email and the Telegram message, so
-- the three cannot disagree. Empty means the standing wording, unchanged.
ALTER TABLE orders ADD COLUMN cancel_note TEXT;
