-- Asking for a book the shop does not have.
--
-- A search that finds nothing is a purchase request the shop never hears.
-- `searches` has recorded those since 0024, but only as terms and a timestamp -
-- deliberately anonymous, and so deliberately unanswerable. The empty state
-- said "ask on Telegram" in prose, with nothing to press. The shop was already
-- collecting the demand signal and had no way to reply to it.
--
-- This is the other half: the same normalised terms, plus a way to write back.
--
-- Not `stock_alerts`, which is the obvious neighbour and cannot be used: its
-- `book_id` is a NOT NULL foreign key, and the whole point here is that there
-- is no book. Not a column on `searches` either - that table is written on
-- every fruitless search by anybody, and hanging an address off one row of it
-- would make an anonymous log into a personal one.

CREATE TABLE book_requests (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Normalised through `searches.normalise`, the same function the miss log
  -- uses, so a request and the miss it came from are the same string and the
  -- owner can see the two together rather than guessing they are related.
  terms TEXT    NOT NULL,
  -- Their own words, if they added any: an author, a publisher, an edition.
  -- Optional, because demanding an explanation loses the people who only know
  -- the title.
  note  TEXT,
  email TEXT    NOT NULL,
  at    INTEGER NOT NULL DEFAULT (unixepoch()),
  -- Asking twice is asking once, exactly as `stock_alerts` has it. Gives the
  -- 'already' answer for nothing, through INSERT OR IGNORE.
  UNIQUE (email, terms)
);

-- The only two questions asked of this table: what came in lately, and what is
-- old enough to forget.
CREATE INDEX idx_book_requests_at ON book_requests(at);

-- There is deliberately no `handled_at`.
--
-- Nothing is ever sent from here - the owner reads these in the portal and
-- writes back themselves - so this cannot borrow `stock_alerts`' honest answer
-- to "how long do you keep this", which is "until the message is sent, and not
-- one moment longer". The promise made on the privacy page instead is: kept
-- until the owner is done with it, and in any case no longer than ninety days.
--
-- That promise is only keepable if being done with it *deletes the row*. A
-- `handled_at` column would turn this into a growing archive of addresses
-- nobody ever reads again, while the privacy page went on claiming otherwise.
-- So the owner's one action is "Done with this", and it is a DELETE.
