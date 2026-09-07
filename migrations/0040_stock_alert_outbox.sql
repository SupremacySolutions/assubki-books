-- Back-in-stock alerts get the delivery state the shipment notices already have.
--
-- The row was deleted at the moment it was read, which is what stopped two
-- admin actions at the same instant telling one person twice. The cost was that
-- a provider refusing - a rate limit, a bad minute, a timeout - threw the
-- subscriber away along with the attempt, and the count returned said they had
-- been told. A later pass put the failures back, but that restore is itself a
-- write that can fail, and when it does the person waiting is gone with no
-- trace that they ever asked.
--
-- The fix is the one the audit named: the row is not the queue *and* the
-- receipt. It stays until a send actually succeeds, and it carries why it has
-- not.
--
--   claimed_at      NULL while the book is out of stock and nothing is owed.
--                   Set when stock settles above zero, which is what makes the
--                   row due. Cleared again if the book sells out before the
--                   message goes - telling somebody a title is back when it is
--                   not is worse than telling them late.
--   attempts        How many sends have been tried, for the backoff and for
--                   anybody looking at why this has not moved.
--   last_error      What the last one said. Truncated at the call site.
--   next_attempt_at Earliest the next try may happen. Exponential, capped at a
--                   day, exactly as shipment_notices does it.
--   lease_until     Held briefly by whoever is sending, so the quarter-hourly
--   lease_token     sweep and an admin stock edit racing each other cannot both
--                   send the same message. The token makes the release safe: a
--                   lease that expired mid-send cannot have its result written
--                   by the worker that lost it.
--
-- Deleting on success is kept deliberately. "We do not keep your address once
-- it has been used" is written on the book page and in the message itself, and
-- it stays true: the row's whole life is the promise being outstanding.
ALTER TABLE stock_alerts ADD COLUMN claimed_at      INTEGER;
ALTER TABLE stock_alerts ADD COLUMN attempts        INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stock_alerts ADD COLUMN last_error      TEXT;
ALTER TABLE stock_alerts ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stock_alerts ADD COLUMN lease_until     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stock_alerts ADD COLUMN lease_token     TEXT;

-- The sweep asks one question - "what is owed and ready to try?" - and this is
-- the index for exactly that question. Partial, because a row with no
-- claimed_at is the overwhelming majority and is never an answer to it.
CREATE INDEX idx_alerts_due ON stock_alerts(next_attempt_at, id) WHERE claimed_at IS NOT NULL;
