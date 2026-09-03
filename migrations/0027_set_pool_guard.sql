-- More complete sets sold than the shelf can build must be impossible.
--
-- A split set is one pool of volumes sold under several listings: the whole
-- set, and each part. `books.stock` on any one of those listings is not the
-- truth about how many can be had - the truth is per volume, in
-- `book_set_stock`, minus everything every sibling listing is already holding.
-- The catalogue and the basket have always shown that pooled figure.
--
-- Checkout did not. It validated against the listing's own `stock - reserved`,
-- and the backstop it leaned on - CHECK (reserved <= stock) - is per row, so it
-- cannot see a sibling. Holding one copy of volumes 1-2 left the complete-set
-- listing still reading as fully available: in production on 2026-09-02 the
-- complete set showed 9 to a customer and 10 to checkout.
--
-- A trigger rather than a check in the ordering code, for the reason the
-- incoming guard is one: it covers every writer, not only the one that
-- remembered, and it aborts the statement so D1 rolls the whole batch back.
CREATE TRIGGER books_set_not_oversold
BEFORE UPDATE OF reserved ON books
WHEN NEW.set_id IS NOT NULL AND NEW.reserved > OLD.reserved
BEGIN
  SELECT RAISE(ABORT, 'set pool oversold')
  WHERE EXISTS (
    SELECT 1
      FROM book_set_stock v
     WHERE v.set_id = NEW.set_id
       AND v.volume BETWEEN NEW.set_from AND NEW.set_to
       -- What this listing wants, plus what every *other* listing covering the
       -- same volume already holds, must fit in that volume's shelf count.
       AND v.have - COALESCE((
             SELECT SUM(o.reserved) FROM books o
              WHERE o.set_id = NEW.set_id
                AND o.id <> NEW.id
                AND v.volume BETWEEN o.set_from AND o.set_to
           ), 0) < NEW.reserved
  );
END;
