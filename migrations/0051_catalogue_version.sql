-- The catalogue's version: one number that moves whenever anything a customer
-- could see changes.
--
-- Customer pages read the catalogue from a cache that outlives a single Worker
-- instance (src/lib/read-cache.ts). Until now that cache could only be told an
-- answer was stale by waiting for it to expire, because the Cache API cannot
-- delete an entry in any data centre but its own - so its entries lived sixty
-- seconds, and the shelf roll-up was re-read from D1 about once a minute all day
-- whatever the traffic. On 12 October that floor, plus the uncached listing
-- queries underneath it, took the database past its 5,000,000-row daily
-- allowance for the first time on real customer traffic.
--
-- With the version in every cache key, an edit is not something to propagate:
-- the next page view reads a new number and simply asks a different question.
-- Entries can then live for hours, and a page view costs this one row.
--
-- The triggers are what make that safe. They fire on every write to every table
-- `src/lib/db.ts` reads, however the write arrives - the portal, a checkout, the
-- expiry sweep, a migration, or somebody fixing a row by hand in the console.
-- That last case is why this is triggers and not a call in the application: the
-- previous attempt at a catalogue cache was shelved precisely because a manual
-- SQL fix stayed invisible for five minutes. A trigger cannot be forgotten.
--
-- If a table is added to db.ts's reads, it needs triggers here too. The listings
-- suite reads db.ts and fails if one is missing.
CREATE TABLE catalogue_version (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  n  INTEGER NOT NULL
);
INSERT INTO catalogue_version (id, n) VALUES (1, 1);

CREATE TRIGGER catalogue_version_books_insert AFTER INSERT ON books
BEGIN
  UPDATE catalogue_version SET n = n + 1 WHERE id = 1;
END;
CREATE TRIGGER catalogue_version_books_update AFTER UPDATE ON books
BEGIN
  UPDATE catalogue_version SET n = n + 1 WHERE id = 1;
END;
CREATE TRIGGER catalogue_version_books_delete AFTER DELETE ON books
BEGIN
  UPDATE catalogue_version SET n = n + 1 WHERE id = 1;
END;
CREATE TRIGGER catalogue_version_book_categories_insert AFTER INSERT ON book_categories
BEGIN
  UPDATE catalogue_version SET n = n + 1 WHERE id = 1;
END;
CREATE TRIGGER catalogue_version_book_categories_update AFTER UPDATE ON book_categories
BEGIN
  UPDATE catalogue_version SET n = n + 1 WHERE id = 1;
END;
CREATE TRIGGER catalogue_version_book_categories_delete AFTER DELETE ON book_categories
BEGIN
  UPDATE catalogue_version SET n = n + 1 WHERE id = 1;
END;
CREATE TRIGGER catalogue_version_categories_insert AFTER INSERT ON categories
BEGIN
  UPDATE catalogue_version SET n = n + 1 WHERE id = 1;
END;
CREATE TRIGGER catalogue_version_categories_update AFTER UPDATE ON categories
BEGIN
  UPDATE catalogue_version SET n = n + 1 WHERE id = 1;
END;
CREATE TRIGGER catalogue_version_categories_delete AFTER DELETE ON categories
BEGIN
  UPDATE catalogue_version SET n = n + 1 WHERE id = 1;
END;
CREATE TRIGGER catalogue_version_book_images_insert AFTER INSERT ON book_images
BEGIN
  UPDATE catalogue_version SET n = n + 1 WHERE id = 1;
END;
CREATE TRIGGER catalogue_version_book_images_update AFTER UPDATE ON book_images
BEGIN
  UPDATE catalogue_version SET n = n + 1 WHERE id = 1;
END;
CREATE TRIGGER catalogue_version_book_images_delete AFTER DELETE ON book_images
BEGIN
  UPDATE catalogue_version SET n = n + 1 WHERE id = 1;
END;
CREATE TRIGGER catalogue_version_sale_items_insert AFTER INSERT ON sale_items
BEGIN
  UPDATE catalogue_version SET n = n + 1 WHERE id = 1;
END;
CREATE TRIGGER catalogue_version_sale_items_update AFTER UPDATE ON sale_items
BEGIN
  UPDATE catalogue_version SET n = n + 1 WHERE id = 1;
END;
CREATE TRIGGER catalogue_version_sale_items_delete AFTER DELETE ON sale_items
BEGIN
  UPDATE catalogue_version SET n = n + 1 WHERE id = 1;
END;
CREATE TRIGGER catalogue_version_sales_insert AFTER INSERT ON sales
BEGIN
  UPDATE catalogue_version SET n = n + 1 WHERE id = 1;
END;
CREATE TRIGGER catalogue_version_sales_update AFTER UPDATE ON sales
BEGIN
  UPDATE catalogue_version SET n = n + 1 WHERE id = 1;
END;
CREATE TRIGGER catalogue_version_sales_delete AFTER DELETE ON sales
BEGIN
  UPDATE catalogue_version SET n = n + 1 WHERE id = 1;
END;
CREATE TRIGGER catalogue_version_book_set_stock_insert AFTER INSERT ON book_set_stock
BEGIN
  UPDATE catalogue_version SET n = n + 1 WHERE id = 1;
END;
CREATE TRIGGER catalogue_version_book_set_stock_update AFTER UPDATE ON book_set_stock
BEGIN
  UPDATE catalogue_version SET n = n + 1 WHERE id = 1;
END;
CREATE TRIGGER catalogue_version_book_set_stock_delete AFTER DELETE ON book_set_stock
BEGIN
  UPDATE catalogue_version SET n = n + 1 WHERE id = 1;
END;
CREATE TRIGGER catalogue_version_shipments_insert AFTER INSERT ON shipments
BEGIN
  UPDATE catalogue_version SET n = n + 1 WHERE id = 1;
END;
CREATE TRIGGER catalogue_version_shipments_update AFTER UPDATE ON shipments
BEGIN
  UPDATE catalogue_version SET n = n + 1 WHERE id = 1;
END;
CREATE TRIGGER catalogue_version_shipments_delete AFTER DELETE ON shipments
BEGIN
  UPDATE catalogue_version SET n = n + 1 WHERE id = 1;
END;
CREATE TRIGGER catalogue_version_stock_ledger_insert AFTER INSERT ON stock_ledger
BEGIN
  UPDATE catalogue_version SET n = n + 1 WHERE id = 1;
END;
