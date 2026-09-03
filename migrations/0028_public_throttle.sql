-- What an address has been doing on the public endpoints.
--
-- Placing an order and starting a group basket are the two things an anonymous
-- visitor can do that cost the shop something real: they reserve stock, they
-- create work for the owner, and they send email and Telegram traffic. Neither
-- had any limit at all, so a script could hold the catalogue hostage and fill
-- the owner's inbox at the same time.
--
-- Counted in D1 rather than in memory for the same reason the login throttle
-- is: Workers isolates are ephemeral and there are many at once, so a
-- module-level counter resets constantly and protects nothing.
CREATE TABLE public_actions (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 'order' or 'group'. Kept apart so a busy day of ordering cannot lock
  -- somebody out of starting a class list.
  action TEXT    NOT NULL,
  ip     TEXT    NOT NULL,
  at     INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_public_actions ON public_actions(action, ip, at);
