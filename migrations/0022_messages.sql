-- A message thread on every order.
--
-- Telegram is excellent for the customers who connect and a dead end for
-- everyone else: a bot cannot open a conversation, so it can only ever reach
-- someone who tapped a link first. The other half were left with email, which
-- lands in a Gmail inbox outside the app with nothing about it attached to the
-- order. This gives every order one conversation that both sides can reach.

CREATE TABLE messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sender     TEXT    NOT NULL CHECK (sender IN ('customer', 'owner')),
  -- "They said it on Telegram" and "they typed it on the site" are different
  -- facts, and the owner should be able to see which door someone came through.
  via        TEXT    NOT NULL CHECK (via IN ('web', 'telegram')),
  body       TEXT,
  -- Under the `proofs/` prefix, which the public /img route deliberately does
  -- not serve. Nulled when the image is swept, leaving the message behind so
  -- the conversation still reads.
  image_key  TEXT,
  -- That there *was* a photo here, which outlives the photo.
  --
  -- Without it a swept row could no longer tell "somebody sent words" from
  -- "somebody sent words and a screenshot that has since been removed", so a
  -- swept message quietly lost half of what it said.
  had_image  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  /*
   * A message is words, a picture, or a picture that has since been swept.
   *
   * The third clause is not decoration. Without it the constraint forbids the
   * one state the sweep has to produce - a photo-only message whose photo is
   * gone - and the sweep would fail on exactly the rows it exists to clear,
   * the first time it ran.
   */
  CHECK (body IS NOT NULL OR image_key IS NOT NULL OR had_image = 1)
);

CREATE INDEX idx_messages_order ON messages(order_id, created_at);

-- The counters are the whole cost story.
--
-- Counting messages per order to draw the portal list would be a query per
-- row - the shape that once ate 95% of the read budget. They are denormalised
-- instead: bumped in the same batch as the insert, zeroed when the thread is
-- opened. `orders.payment_proofs` is already a counter of exactly this kind.
ALTER TABLE orders ADD COLUMN unread_for_owner    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN unread_for_customer INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN last_message_at     INTEGER;

-- When the customer was last told there is a reply waiting.
--
-- Five replies in a row must not be five emails: a full test run is already
-- about 38, which is most of a day's free Resend allowance. Compared against
-- `last_message_at` to decide whether a notification is due.
ALTER TABLE orders ADD COLUMN message_notified_at INTEGER;
