-- Phase 2: owner portal, order confirmation, and Telegram.
--
-- Three things change:
--
--   1. An order acquires a *confirmation* step. The owner adds postage, which
--      is the first moment a real total exists - until then the customer has
--      only ever seen a subtotal.
--
--   2. An order can be bound to a Telegram chat. A bot cannot open a
--      conversation with someone who has not messaged it first, so the customer
--      taps a deep link and the bot records the chat id here. Without this the
--      only way to reach them is email.
--
--   3. A book remembers the channel post announcing it, so editing a listing
--      updates that post instead of announcing the same book twice.

-- ---------------------------------------------------------------------------
-- Orders
-- ---------------------------------------------------------------------------
ALTER TABLE orders ADD COLUMN postage_pence INTEGER;
ALTER TABLE orders ADD COLUMN total_pence INTEGER;
ALTER TABLE orders ADD COLUMN confirmed_at INTEGER;
ALTER TABLE orders ADD COLUMN payment_sent_at INTEGER;

-- Telegram chat binding. Nullable: a customer who never taps the deep link is
-- reachable by email only, which is the fallback the whole flow is built on.
ALTER TABLE orders ADD COLUMN telegram_chat_id TEXT;
ALTER TABLE orders ADD COLUMN telegram_linked_at INTEGER;

CREATE INDEX idx_orders_chat ON orders(telegram_chat_id);

-- ---------------------------------------------------------------------------
-- Books
-- ---------------------------------------------------------------------------
ALTER TABLE books ADD COLUMN telegram_message_id INTEGER;
ALTER TABLE books ADD COLUMN telegram_posted_at INTEGER;

-- ---------------------------------------------------------------------------
-- Settings - small key/value store the owner edits from the portal.
-- ---------------------------------------------------------------------------
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Payment instructions are content, not code: the owner changes bank details
-- without a deploy. This text is what the customer receives once their order
-- is confirmed.
INSERT INTO settings (key, value) VALUES
  ('payment_instructions',
   'Please send payment by bank transfer, quoting your order reference so we can match it.

Account name:  As-Subkī Books
Sort code:     00-00-00
Account no:    00000000

Once payment reaches us we will confirm and post your books.'),
  ('default_postage_pence', '395'),
  ('collection_address', 'Collection details will be sent with your payment confirmation.');
