-- A set that can be bought whole or in parts.
--
-- The owner holds complete sets and may sell a half. The rule they described:
-- three sets of four, sell volumes 1-2, and the full set drops to two, that
-- half drops to two, and the *other* half stays at three.
--
-- That last number is why this is a count per volume rather than a single
-- "sets in stock". After that sale the shop holds two whole sets plus one
-- orphaned second half, and no single number says both "two complete sets" and
-- "three of volumes 3-4". Per volume it is simply [2,2,3,3], and the
-- availability of any option is the smallest count among the volumes it
-- covers. Selling the whole thing takes one off all four.
--
-- Each purchasable option stays an ordinary row in `books`: its own title,
-- price, cover and Telegram post, and every part of ordering that already
-- works - holds, the ledger, cancellation, the 48-hour expiry sweep - keeps
-- working without learning anything new. Only the reading of availability
-- changes, and the pool is decremented when a sale completes.

CREATE TABLE book_sets (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  -- What the owner calls the whole thing, for the portal only.
  name     TEXT    NOT NULL,
  -- How many volumes the complete set has.
  volumes  INTEGER NOT NULL CHECK (volumes > 0 AND volumes <= 200),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- How many of each volume are on the shelf. One row per volume.
CREATE TABLE book_set_stock (
  set_id  INTEGER NOT NULL REFERENCES book_sets(id) ON DELETE CASCADE,
  volume  INTEGER NOT NULL,
  have    INTEGER NOT NULL DEFAULT 0 CHECK (have >= 0),
  PRIMARY KEY (set_id, volume)
);

-- Which set a listing belongs to, and which volumes it is.
--
-- A contiguous range: the halves and thirds a set is actually broken into are
-- runs of volumes, and "1-2" needs two numbers rather than a parser. NULL
-- set_id is every listing that exists today and every ordinary book after it.
ALTER TABLE books ADD COLUMN set_id   INTEGER REFERENCES book_sets(id) ON DELETE SET NULL;
ALTER TABLE books ADD COLUMN set_from INTEGER;
ALTER TABLE books ADD COLUMN set_to   INTEGER;

CREATE INDEX idx_books_set ON books(set_id);
