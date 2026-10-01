-- Pre-orders: asking customers before buying, rather than buying and hoping.
--
-- The shop buys in bulk, and until now the only way to judge how many copies
-- of a title to bring in was a guess and a few Telegram replies. A pre-order is
-- a book the owner is *thinking* of buying, put in front of customers so they
-- can say "I would take two". The total is the number the order is sized by.
--
-- A table of its own, deliberately not `books` rows the way shipments are.
-- A shipment item is a book with copies coming - every order, hold and arrival
-- rule applies to it, which is why it reuses the row. A pre-order is nothing of
-- the kind: no copies, no price anyone has agreed, nothing to put in a basket.
-- As a `books` row it would sit within reach of everything that reads that
-- table - checkout, search, the sitemap, bulk edits, and the quarter-hourly
-- channel sync, which would rewrite its announcement to "out of stock" - and
-- each of those would need teaching to step around it. Here nothing has to.

CREATE TABLE preorders (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  title            TEXT    NOT NULL,
  title_ar         TEXT,
  title_ur         TEXT,
  author           TEXT,
  publisher        TEXT,
  volumes          INTEGER,
  isbn             TEXT,
  description_html TEXT,
  -- What the owner expects to charge. NULL is "not known yet", which is a real
  -- answer before the supplier has quoted, and is shown as such rather than as
  -- £0.00.
  price_pence      INTEGER CHECK (price_pence IS NULL OR price_pence >= 0),
  /*
   * draft  - being written, nobody outside the portal can see it
   * open   - on the pre-order page, taking interest
   * closed - the owner has their number, and the list of names stays for them
   */
  status           TEXT    NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','open','closed')),
  -- One cover, in R2 under `uploads/preorders/`, so `/img/<key>` serves it
  -- exactly as it serves a listing's photos.
  image_key        TEXT,
  image_width      INTEGER,
  image_height     INTEGER,
  -- The channel announcement, so a later change edits it rather than posting
  -- the same book twice.
  telegram_message_id INTEGER,
  telegram_posted_at  INTEGER,
  created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  closed_at        INTEGER
);

CREATE INDEX idx_preorders_status ON preorders(status, created_at);

CREATE TABLE preorder_interest (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  preorder_id INTEGER NOT NULL REFERENCES preorders(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  email       TEXT    NOT NULL,
  copies      INTEGER NOT NULL CHECK (copies BETWEEN 1 AND 50),
  at          INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER,
  -- One line per person per book. Registering again changes the number rather
  -- than adding a second line, so a customer who changes their mind from one
  -- copy to three is counted as three, not four.
  UNIQUE (preorder_id, email)
);

-- No `handled_at` and no archive. A pre-order's names are kept while it is
-- open and for ninety days after it closes - long enough to write to everyone
-- when the books arrive - and then the sweep deletes them. Deleting the
-- pre-order deletes them at once. Stated on the privacy page.
