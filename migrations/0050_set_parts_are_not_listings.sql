-- A set sold in parts is one listing, not several.
--
-- The parts have always been ordinary `books` rows, and that was the right call
-- for everything downstream of a sale: holds, the stock ledger, cancellation and
-- the forty-eight-hour sweep never had to learn what a set is, because there was
-- no new kind of thing for them to understand. Orders point at a part the same
-- way they point at any other listing.
--
-- What it also did, and nobody wanted, is put every part in the shop. A
-- four-volume work split three ways became four entries in the catalogue, four
-- in search, four in the sitemap and four in the owner's own list - and the book
-- page already offered all of them behind one picker, so the extra entries were
-- the same choice said twice.
--
-- This marks a part as a part. The row stays exactly where it is and keeps
-- selling through the picker; it simply stops being something to browse.
--
-- Stored rather than derived, which is a deliberate trade. "Is this row the
-- whole set?" cannot be answered from the row alone: a part covering volumes 1-2
-- of four has set_from = 1 and set_to = volumes = 2, which is indistinguishable
-- from a whole two-volume set without reading `book_sets.volumes`. Deriving it
-- would put a correlated subquery on the catalogue's hot path, and the read
-- budget is the binding constraint on this database - `categoryCounts` once
-- spent 95% of it. So the fact is written down once, and the test suite asserts
-- it still agrees with the ranges.
ALTER TABLE books ADD COLUMN set_part INTEGER NOT NULL DEFAULT 0;

-- Every part that already exists. The whole is the row covering volume 1 to the
-- set's last volume; everything else attached to a set is a part of it.
UPDATE books
   SET set_part = 1
 WHERE set_id IS NOT NULL
   AND NOT (set_from = 1
            AND set_to = (SELECT volumes FROM book_sets WHERE id = books.set_id));
