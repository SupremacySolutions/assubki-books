-- As-Subkī Books - core schema.
--
-- Two ideas drive the shape of this file:
--
--   1. Availability is never a single mutable number. A book has `stock` (copies
--      physically held) and `reserved` (copies spoken for by an unpaid request).
--      Available = stock - reserved. Every movement is also appended to
--      stock_ledger, so "where did that copy go?" is always answerable.
--
--   2. Orders snapshot what was agreed. Payment is arranged over Telegram days
--      after the request, so an order must show the title and price at the time
--      of ordering, not whatever the catalogue says today.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Categories - WooCommerce's hierarchy, preserved (Syllabus → Dars Nizami etc.)
-- ---------------------------------------------------------------------------
CREATE TABLE categories (
  id          INTEGER PRIMARY KEY,
  slug        TEXT    NOT NULL UNIQUE,
  name        TEXT    NOT NULL,
  parent_id   INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  sort        INTEGER NOT NULL DEFAULT 0,
  -- Denormalised full path ("syllabus/dars-nizami") so /catalogue/<path>
  -- resolves in one lookup instead of walking parents on every request.
  path        TEXT    NOT NULL UNIQUE
);

CREATE INDEX idx_categories_parent ON categories(parent_id);

-- ---------------------------------------------------------------------------
-- Books
-- ---------------------------------------------------------------------------
CREATE TABLE books (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  slug             TEXT    NOT NULL UNIQUE,
  -- The old percent-encoded WooCommerce slug. Kept so /product/<legacy_slug>/
  -- links already posted in the Telegram channel can 301 to the new page.
  legacy_slug      TEXT,
  legacy_wc_id     INTEGER,

  -- Titles are bilingual. Splitting them lets each be rendered with the right
  -- font and `dir`, which the old WordPress theme did badly.
  title            TEXT    NOT NULL,
  title_ar         TEXT,

  author           TEXT,
  publisher        TEXT,
  description_html TEXT,

  price_pence      INTEGER NOT NULL CHECK (price_pence >= 0),

  stock            INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  reserved         INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),

  status           TEXT    NOT NULL DEFAULT 'live'
                     CHECK (status IN ('draft', 'live', 'archived')),

  created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at       INTEGER NOT NULL DEFAULT (unixepoch()),

  -- A reservation must never exceed the copies actually held.
  CHECK (reserved <= stock)
);

CREATE INDEX idx_books_status  ON books(status);
CREATE INDEX idx_books_legacy  ON books(legacy_slug);
CREATE INDEX idx_books_created ON books(created_at DESC);

CREATE TABLE book_categories (
  book_id     INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (book_id, category_id)
);

CREATE INDEX idx_bookcats_category ON book_categories(category_id);

CREATE TABLE book_images (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id  INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  -- Storage key, e.g. "books/al-nahw-al-wadih/1.webp". The prefix decides
  -- where it is served from: "books/" are the migrated covers, shipped as
  -- static assets under public/img/ and immutable; "uploads/" are images the
  -- owner adds later, which live in R2. Both resolve under /img/<key>.
  image_key TEXT   NOT NULL,
  alt      TEXT,
  sort     INTEGER NOT NULL DEFAULT 0,
  width    INTEGER,
  height   INTEGER
);

CREATE INDEX idx_bookimages_book ON book_images(book_id, sort);

-- ---------------------------------------------------------------------------
-- Search - FTS5 over both the transliterated and Arabic titles.
-- ---------------------------------------------------------------------------
-- The column names must match books' own column names exactly: an external
-- content table resolves them against `books` on read, so a column called
-- `description` here would send FTS looking for a `books.description` that
-- does not exist.
CREATE VIRTUAL TABLE books_fts USING fts5(
  title,
  title_ar,
  author,
  description_html,
  content = 'books',
  content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER books_fts_insert AFTER INSERT ON books BEGIN
  INSERT INTO books_fts(rowid, title, title_ar, author, description_html)
  VALUES (new.id, new.title, new.title_ar, new.author, new.description_html);
END;

CREATE TRIGGER books_fts_delete AFTER DELETE ON books BEGIN
  INSERT INTO books_fts(books_fts, rowid, title, title_ar, author, description_html)
  VALUES ('delete', old.id, old.title, old.title_ar, old.author, old.description_html);
END;

CREATE TRIGGER books_fts_update AFTER UPDATE ON books BEGIN
  INSERT INTO books_fts(books_fts, rowid, title, title_ar, author, description_html)
  VALUES ('delete', old.id, old.title, old.title_ar, old.author, old.description_html);
  INSERT INTO books_fts(rowid, title, title_ar, author, description_html)
  VALUES (new.id, new.title, new.title_ar, new.author, new.description_html);
END;

-- ---------------------------------------------------------------------------
-- Orders - requests, not sales. No money moves through this table.
-- ---------------------------------------------------------------------------
CREATE TABLE orders (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Human-quotable reference, e.g. "ASB-4F7K". This is what the owner and the
  -- customer say to each other on Telegram.
  ref            TEXT    NOT NULL UNIQUE,
  -- Unguessable token for the /order/<ref>?t=<token> status page. Without it,
  -- sequential refs would expose other people's orders.
  access_token   TEXT    NOT NULL,

  customer_name  TEXT    NOT NULL,
  email          TEXT    NOT NULL,
  phone          TEXT,
  telegram       TEXT,

  fulfilment     TEXT    NOT NULL DEFAULT 'delivery'
                   CHECK (fulfilment IN ('delivery', 'collection')),
  address        TEXT,
  notes          TEXT,

  status         TEXT    NOT NULL DEFAULT 'requested'
                   CHECK (status IN ('requested', 'awaiting_payment', 'paid',
                                     'dispatched', 'cancelled', 'expired')),

  subtotal_pence INTEGER NOT NULL CHECK (subtotal_pence >= 0),

  created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  -- When the stock hold lapses. The hourly cron expires anything past this
  -- that is still 'requested'.
  expires_at     INTEGER,

  -- Set once the order has been announced to the owner, so a retry cannot
  -- double-notify.
  notified_at    INTEGER
);

CREATE INDEX idx_orders_status  ON orders(status);
CREATE INDEX idx_orders_expiry  ON orders(status, expires_at);
CREATE INDEX idx_orders_created ON orders(created_at DESC);
CREATE INDEX idx_orders_email   ON orders(email);

CREATE TABLE order_items (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id             INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  -- Deliberately not CASCADE: deleting a book must not erase the record of it
  -- having been ordered.
  book_id              INTEGER REFERENCES books(id) ON DELETE SET NULL,
  title_snapshot       TEXT    NOT NULL,
  price_pence_snapshot INTEGER NOT NULL CHECK (price_pence_snapshot >= 0),
  qty                  INTEGER NOT NULL CHECK (qty > 0)
);

CREATE INDEX idx_orderitems_order ON order_items(order_id);
CREATE INDEX idx_orderitems_book  ON order_items(book_id);

-- ---------------------------------------------------------------------------
-- Stock ledger - append-only audit of every movement.
-- ---------------------------------------------------------------------------
CREATE TABLE stock_ledger (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id  INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  -- Negative takes copies away, positive puts them back.
  delta    INTEGER NOT NULL,
  field    TEXT    NOT NULL CHECK (field IN ('stock', 'reserved')),
  reason   TEXT    NOT NULL,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  at       INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_ledger_book  ON stock_ledger(book_id, at DESC);
CREATE INDEX idx_ledger_order ON stock_ledger(order_id);
