-- The search index learns the publisher.
--
-- A customer who types "Darussalam" or "Zam Zam" into the search box is asking
-- for that publisher's books, and until now the box only found them when the
-- description happened to mention the name. The publisher is on every listing
-- the owner has filled it in for; it only had to be indexed.
--
-- Rebuilt rather than altered, for the reason 0031 gives: fts5 has no ADD
-- COLUMN, and the index is external content, so 'rebuild' regenerates every
-- word of it from `books`.
--
-- The update trigger keeps 0038's column list, with `publisher` added to it.
-- 0038's warning stands: miss a column there and edits to it silently stop
-- reaching the index.
DROP TRIGGER IF EXISTS books_fts_insert;
DROP TRIGGER IF EXISTS books_fts_delete;
DROP TRIGGER IF EXISTS books_fts_update;
DROP TABLE IF EXISTS books_fts;

CREATE VIRTUAL TABLE books_fts USING fts5(
  title,
  title_ar,
  title_ur,
  author,
  publisher,
  description_html,
  content = 'books',
  content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2'
);

INSERT INTO books_fts(books_fts) VALUES ('rebuild');

CREATE TRIGGER books_fts_insert AFTER INSERT ON books BEGIN
  INSERT INTO books_fts(rowid, title, title_ar, title_ur, author, publisher, description_html)
  VALUES (new.id, new.title, new.title_ar, new.title_ur, new.author, new.publisher, new.description_html);
END;

CREATE TRIGGER books_fts_delete AFTER DELETE ON books BEGIN
  INSERT INTO books_fts(books_fts, rowid, title, title_ar, title_ur, author, publisher, description_html)
  VALUES ('delete', old.id, old.title, old.title_ar, old.title_ur, old.author, old.publisher, old.description_html);
END;

CREATE TRIGGER books_fts_update
AFTER UPDATE OF title, title_ar, title_ur, author, publisher, description_html ON books BEGIN
  INSERT INTO books_fts(books_fts, rowid, title, title_ar, title_ur, author, publisher, description_html)
  VALUES ('delete', old.id, old.title, old.title_ar, old.title_ur, old.author, old.publisher, old.description_html);
  INSERT INTO books_fts(rowid, title, title_ar, title_ur, author, publisher, description_html)
  VALUES (new.id, new.title, new.title_ar, new.title_ur, new.author, new.publisher, new.description_html);
END;
