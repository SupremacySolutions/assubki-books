-- Where each side has read up to, so acknowledgements cannot go backwards.
--
-- The unread counter was recalculated from whichever message id the last
-- acknowledgement happened to carry. Two polls overlapping - or two tabs - can
-- finish in the wrong order: acknowledge through message B, then let an older
-- request acknowledge through A, and the recount puts the badge back to one for
-- a message that has already been read.
--
-- A cursor that only ever moves forward removes the ordering problem entirely.
-- The counter stays derived, so it still repairs itself, but it is derived from
-- the furthest point read rather than the most recent request to arrive.
--
-- Nought is the safe start for existing rows: nothing has been acknowledged, so
-- every message counts, which is exactly what the current counters already say.
ALTER TABLE orders ADD COLUMN read_cursor_customer INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN read_cursor_owner    INTEGER NOT NULL DEFAULT 0;
