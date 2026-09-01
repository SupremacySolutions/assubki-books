-- More copies claimed than are coming must be impossible, not merely unlikely.
--
-- Shelf stock has `CHECK (reserved <= stock)`, and that constraint - not the
-- read before it - is what makes two simultaneous requests for the last copy
-- safe: the second write fails and D1 rolls the whole batch back.
--
-- A claim on a delivery needs the same backstop, but the equivalent rule spans
-- two columns and SQLite cannot add a table CHECK to an existing table without
-- rebuilding it. A trigger enforces exactly the same thing, and it covers every
-- writer rather than only the one that remembered.
CREATE TRIGGER books_incoming_not_oversold
BEFORE UPDATE OF reserved_incoming, incoming ON books
WHEN NEW.reserved_incoming > NEW.incoming
BEGIN
  SELECT RAISE(ABORT, 'more copies claimed than are coming');
END;
