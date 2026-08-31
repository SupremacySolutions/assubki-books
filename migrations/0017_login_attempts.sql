-- Sign-in attempts on the portal.
--
-- There was no limit at all: the shared password could be guessed as fast as
-- the network allowed, against a portal that can read every customer's name,
-- address and phone number.
--
-- In D1 rather than in memory because Workers isolates are ephemeral and there
-- are many of them at once - a counter held in a module variable resets
-- constantly and protects nothing. This is one row per attempt, pruned as it
-- is read, so it never becomes a table worth worrying about.
--
-- The address is what is throttled, not the account. Throttling "the owner"
-- would let anyone lock the owner out of their own shop by failing on purpose.
CREATE TABLE login_attempts (
  id  INTEGER PRIMARY KEY AUTOINCREMENT,
  ip  TEXT    NOT NULL,
  at  INTEGER NOT NULL DEFAULT (unixepoch()),
  ok  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_login_attempts ON login_attempts(ip, at);
