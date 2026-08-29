-- A basket several people add to, ending in one order.
--
-- The madrasah case: a dozen teachers each want different titles delivered to
-- one address. Today that arrives as a dozen Telegram messages asking to be
-- posted together, and the shop reassembles them by hand. One shared basket
-- means one reference, one address, one request in the system.
--
-- It holds no stock. Like every other basket here it is a list of intents;
-- copies are reserved only when the organiser submits, on the same path with
-- the same CHECK constraint behind it.

CREATE TABLE group_baskets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Same shape as an order reference: these get read aloud and typed back.
  code       TEXT NOT NULL UNIQUE,
  -- Holding the link is the permission. Nobody signs in to a bookshop basket.
  token      TEXT NOT NULL,
  organiser  TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL,
  -- Set once it has been sent, so the page can say so rather than letting
  -- people keep adding to an order that has already gone.
  order_ref  TEXT
);

CREATE TABLE group_basket_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id   INTEGER NOT NULL REFERENCES group_baskets(id) ON DELETE CASCADE,
  book_id    INTEGER NOT NULL REFERENCES books(id),
  qty        INTEGER NOT NULL CHECK (qty > 0 AND qty <= 99),
  -- Whose copy it is. Forty books and no idea whose is whose would leave the
  -- organiser worse off than the pile of messages this replaces.
  added_by   TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (group_id, book_id, added_by)
);

CREATE INDEX idx_group_items_group ON group_basket_items(group_id);
CREATE INDEX idx_group_baskets_expiry ON group_baskets(expires_at) WHERE order_ref IS NULL;
