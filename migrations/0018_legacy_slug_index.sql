-- Make the legacy WordPress URL lookup use an index.
--
-- `slugForLegacy` matches with `WHERE LOWER(legacy_slug) = LOWER(?)`, which
-- wraps the column in a function and so cannot use idx_books_legacy. Every old
-- URL hit read all 225 books - 28,000 rows a day for what should be one.
--
-- An expression index matches the expression as written, so the query itself
-- does not change. The comparison stays case-insensitive, which it needs to be:
-- the imported WordPress slugs are not consistently cased.
CREATE INDEX idx_books_legacy_lower ON books(LOWER(legacy_slug));
