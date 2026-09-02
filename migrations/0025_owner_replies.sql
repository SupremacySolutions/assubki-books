-- Which order each notification to the owner was about.
--
-- The owner is told on Telegram when a customer writes, so replying in that
-- same chat is the obvious move - and until now it did nothing but bounce a
-- correction back, because nothing could say which order a reply belonged to.
-- Guessing at "their most recent order" was never acceptable: it would put the
-- shop's words in the wrong customer's thread.
--
-- Telegram answers that question itself. A reply carries
-- `reply_to_message.message_id`, so recording the id of every notification the
-- bot sends turns a reply into an exact lookup rather than a guess.
CREATE TABLE owner_notices (
  -- Telegram's id for the message the bot sent to the owner's chat.
  message_id INTEGER PRIMARY KEY,
  order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  at         INTEGER NOT NULL DEFAULT (unixepoch())
);

-- The cron worker prunes by age; Telegram will not let anybody reply to a
-- message from months ago in practice, and an unbounded table is a liability.
CREATE INDEX idx_owner_notices_at ON owner_notices(at);
