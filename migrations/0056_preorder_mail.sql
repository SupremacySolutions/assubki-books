-- Writing to everyone on a pre-order list, from the shop's own address.
--
-- The portal offered a `mailto:?bcc=` link: it opened the owner's own mail app
-- with every address in the blind-copy line, so the message went from their
-- personal Gmail rather than orders@assubkibooks.co.uk, looked like a mass
-- mailing, and left no record of who had been told. Now the owner writes the
-- message once and the shop sends one email per person, in its own letterhead.
--
-- Queued, like the arrival notices, rather than sent in the request: a list can
-- be longer than one handler may make requests for, and longer than what is
-- left of the day's mail allowance. The admin action sends the first few at
-- once; the quarter-hourly sweep sends the rest and retries any refusal.

CREATE TABLE preorder_mailings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  preorder_id INTEGER NOT NULL REFERENCES preorders(id) ON DELETE CASCADE,
  subject     TEXT    NOT NULL,
  message     TEXT    NOT NULL,
  -- Where the button goes, if anywhere. Only ever a page on the shop's own
  -- site; the route checks that before it is stored.
  link        TEXT,
  -- How many it was addressed to, and how many have gone. Kept as numbers on
  -- the mailing so the history still reads right after the names behind it are
  -- deleted - by the owner, or by the ninety-day prune.
  recipients  INTEGER NOT NULL,
  sent        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_preorder_mailings ON preorder_mailings(preorder_id, created_at);

-- One row per person per mailing. The name and address are read from
-- `preorder_interest` at send time rather than copied here, so taking somebody
-- off the list - or the prune - also takes back a message not yet sent to them.
CREATE TABLE preorder_mail_queue (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  mailing_id      INTEGER NOT NULL REFERENCES preorder_mailings(id) ON DELETE CASCADE,
  interest_id     INTEGER NOT NULL REFERENCES preorder_interest(id) ON DELETE CASCADE,
  sent_at         INTEGER,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  lease_token     TEXT,
  lease_until     INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  UNIQUE (mailing_id, interest_id)
);

CREATE INDEX idx_preorder_mail_due ON preorder_mail_queue(sent_at, next_attempt_at);
