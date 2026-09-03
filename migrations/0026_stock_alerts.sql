-- "Tell me when it is back."
--
-- The book page has promised this out loud for as long as it has existed, and
-- kept it only by the owner remembering. This is the promise, written down.
CREATE TABLE stock_alerts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id    INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  email      TEXT    NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  -- Asking twice is asking once.
  UNIQUE (book_id, email)
);

CREATE INDEX idx_alerts_book ON stock_alerts(book_id);
