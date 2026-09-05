-- An Urdu title beside the Arabic one, and the language that follows from them.
--
-- The shop sells in three languages and had a column for one of them. Adding
-- `title_ur` is the small half; the useful half is that a book's language is
-- now something the database knows, so it can be filtered on rather than
-- worked out per row in the application.
--
-- Derived, not stored separately. A book that carries an Arabic title is an
-- Arabic book, one that carries an Urdu title is an Urdu book, and one that
-- carries neither is English - which is exactly how the owner describes the
-- catalogue. Writing that as a generated column means it cannot drift from the
-- titles it is drawn from: there is no second field to forget to update, and
-- no import or edit path that can leave the two disagreeing.
--
-- VIRTUAL rather than STORED because SQLite will not add a stored generated
-- column to an existing table, and the alternative is rebuilding a table with
-- live orders pointing at it. The index below is what makes that cost nothing:
-- it holds the computed value, so a filtered query is an index search rather
-- than a scan of every row. Confirmed against D1's planner:
--   SEARCH books USING INDEX idx_books_language (status=? AND language=?)
--
-- Precedence matters where a book has both titles: Arabic wins. It is the
-- older field, it is the one the catalogue was built around, and a book with
-- an Arabic title is an Arabic book whatever else is recorded beside it.
ALTER TABLE books ADD COLUMN title_ur TEXT;

ALTER TABLE books ADD COLUMN language TEXT GENERATED ALWAYS AS (
  CASE
    WHEN title_ar IS NOT NULL AND trim(title_ar) <> '' THEN 'arabic'
    WHEN title_ur IS NOT NULL AND trim(title_ur) <> '' THEN 'urdu'
    ELSE 'english'
  END
) VIRTUAL;

-- Status first: every customer-facing query already narrows to 'live', so the
-- two together are what actually gets asked, and a language search inside the
-- live shop never touches a draft or an archived row.
CREATE INDEX idx_books_language ON books(status, language);

-- The search index has to learn the new title, or an Urdu book would be
-- findable by its English name and invisible under its own.
--
-- Rebuilt rather than altered because fts5 has no ADD COLUMN. It is external
-- content - every word in it is a copy of something in `books` - so dropping
-- and rebuilding loses nothing that cannot be regenerated, which is what
-- 'rebuild' below does.
DROP TRIGGER IF EXISTS books_fts_insert;
DROP TRIGGER IF EXISTS books_fts_delete;
DROP TRIGGER IF EXISTS books_fts_update;
DROP TABLE IF EXISTS books_fts;

CREATE VIRTUAL TABLE books_fts USING fts5(
  title,
  title_ar,
  title_ur,
  author,
  description_html,
  content = 'books',
  content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2'
);

INSERT INTO books_fts(books_fts) VALUES ('rebuild');

CREATE TRIGGER books_fts_insert AFTER INSERT ON books BEGIN
  INSERT INTO books_fts(rowid, title, title_ar, title_ur, author, description_html)
  VALUES (new.id, new.title, new.title_ar, new.title_ur, new.author, new.description_html);
END;

CREATE TRIGGER books_fts_delete AFTER DELETE ON books BEGIN
  INSERT INTO books_fts(books_fts, rowid, title, title_ar, title_ur, author, description_html)
  VALUES ('delete', old.id, old.title, old.title_ar, old.title_ur, old.author, old.description_html);
END;

CREATE TRIGGER books_fts_update AFTER UPDATE ON books BEGIN
  INSERT INTO books_fts(books_fts, rowid, title, title_ar, title_ur, author, description_html)
  VALUES ('delete', old.id, old.title, old.title_ar, old.title_ur, old.author, old.description_html);
  INSERT INTO books_fts(rowid, title, title_ar, title_ur, author, description_html)
  VALUES (new.id, new.title, new.title_ar, new.title_ur, new.author, new.description_html);
END;
