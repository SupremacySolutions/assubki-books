-- Three measured savings, from the audit's D1 review.
--
-- None of them changes an answer; each changes how much of the database has to
-- be read or written to give it.

-- 1. The search index is rebuilt on every write to a book.
--
-- `books_fts` carries the title, both translated titles, the author and the
-- description. The trigger fired on any UPDATE at all, so changing a stock
-- count - which reservation, payment, cancellation, expiry and every delivery
-- do - deleted the book's row from the index and inserted it again. Measured
-- locally, a stock-only update cost 9 SQLite changes; naming the columns takes
-- it to 1.
--
-- Every column the index actually holds is listed. Miss one and a title edit
-- silently stops being searchable, which is why they are spelled out rather
-- than trimmed to the ones that seemed to matter.
DROP TRIGGER books_fts_update;
CREATE TRIGGER books_fts_update
AFTER UPDATE OF title, title_ar, title_ur, author, description_html ON books BEGIN
  INSERT INTO books_fts(books_fts, rowid, title, title_ar, title_ur, author, description_html)
  VALUES ('delete', old.id, old.title, old.title_ar, old.title_ur, old.author, old.description_html);
  INSERT INTO books_fts(rowid, title, title_ar, title_ur, author, description_html)
  VALUES (new.id, new.title, new.title_ar, new.title_ur, new.author, new.description_html);
END;

-- 2. The message poll's cursor.
--
-- Both sides ask "anything newer than this id?" every few seconds. The only
-- index was (order_id, created_at), so the answer came from a scan of the
-- thread plus a temporary sort. On a 10,000-message fixture the audit measured
-- ~50,100 VM steps falling to ~100.
--
-- The older index stays: it serves the retention sweep, which asks by time.
CREATE INDEX idx_messages_cursor ON messages(order_id, id);

-- 3. Throttle housekeeping.
--
-- `public_actions` is indexed on (action, ip, at), which answers "has this
-- address done this lately?" but not the tidy-up that follows it: deleting
-- everything older than the window has no leading column to seek on, so it
-- scanned the table each time. The audit measured ~30,100 VM steps over 10,000
-- rows falling to ~300 with an index on `at` alone.
--
-- `login_attempts` is left as it is. Its cleanup runs on the same shape, but
-- the table only ever holds a handful of rows for a shop with one owner, and
-- an index costs writes on the path that matters most - somebody signing in.
CREATE INDEX idx_public_actions_at ON public_actions(at);
