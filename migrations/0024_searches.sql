-- What people looked for and did not find.
--
-- The shop has no way to see what it is being asked for. A customer who
-- searches for a title that is not stocked is making a purchase request, and
-- today that request vanishes the moment the results page renders empty. The
-- owner's own list of 98 wanted titles turned up 36 the shop does not carry -
-- which is the same experiment customers are running daily, unobserved.
--
-- **Only searches that found nothing are recorded.** Logging every search would
-- put a write on the catalogue's hottest path for a signal nobody can act on;
-- an empty result is the whole of what is actionable, and it is rare.
CREATE TABLE searches (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Normalised on the way in - trimmed, lower-cased, spaces collapsed - so
  -- "Nur al Idah", "nur al-idah" and "  Nur Al Idah " are one row saying one
  -- thing rather than three saying it separately.
  terms TEXT    NOT NULL,
  at    INTEGER NOT NULL DEFAULT (unixepoch())
);

-- The panel reads a window, and the cron worker prunes by the same column.
CREATE INDEX idx_searches_at ON searches(at);
