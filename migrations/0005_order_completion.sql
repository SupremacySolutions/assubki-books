-- An order used to end at 'dispatched' and stop there, which left the owner
-- with no way to say a delivery had arrived or a collection had been picked up.
-- This adds a 'completed' status, and the postage detail the owner records when
-- payment and posting happen in one action.
--
-- Adding a value to a CHECK constraint means rebuilding the table: SQLite has no
-- ALTER for it. The complication is that order_items and stock_ledger both point
-- at orders(id), and DROP TABLE performs an implicit DELETE FROM which fires
-- ON DELETE CASCADE - so a naive rebuild would silently erase the record of what
-- every past order contained.
--
-- PRAGMA defer_foreign_keys defers constraint *violations*; it does not stop a
-- cascade *action*. So the children are copied out by hand and put back
-- afterwards, which depends on no pragma behaviour at all.

-- 1. Hold the children somewhere the cascade cannot reach.
CREATE TABLE _order_items_backup AS SELECT * FROM order_items;
CREATE TABLE _ledger_orders_backup AS
  SELECT id AS ledger_id, order_id FROM stock_ledger WHERE order_id IS NOT NULL;

-- 2. The table as it should now be. Identical to the old one but for the status
--    CHECK and the four new columns at the end.
CREATE TABLE orders_rebuild (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ref            TEXT    NOT NULL UNIQUE,
  access_token   TEXT    NOT NULL,

  customer_name  TEXT    NOT NULL,
  email          TEXT    NOT NULL,
  phone          TEXT,
  telegram       TEXT,

  fulfilment     TEXT    NOT NULL DEFAULT 'delivery'
                   CHECK (fulfilment IN ('delivery', 'collection')),
  address        TEXT,
  notes          TEXT,

  -- 'completed' is new: delivered for a posted order, collected for one picked
  -- up in person. 'dispatched' is now delivery-only, enforced in the endpoint.
  status         TEXT    NOT NULL DEFAULT 'requested'
                   CHECK (status IN ('requested', 'awaiting_payment', 'paid',
                                     'dispatched', 'completed', 'cancelled',
                                     'expired')),

  subtotal_pence INTEGER NOT NULL CHECK (subtotal_pence >= 0),

  created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at     INTEGER,
  notified_at    INTEGER,

  postage_pence      INTEGER,
  total_pence        INTEGER,
  confirmed_at       INTEGER,
  payment_sent_at    INTEGER,
  telegram_chat_id   TEXT,
  telegram_linked_at INTEGER,
  paid_at            INTEGER,
  dispatched_at      INTEGER,
  tracking_number    TEXT,

  -- When the delivery arrived, or the books were collected.
  completed_at     INTEGER,
  -- Who carried it, so the tracking number can be linked to the right site
  -- rather than always assuming Royal Mail.
  postage_provider TEXT,
  postage_service  TEXT,
  -- What the owner actually sent this customer. Held per order because
  -- different orders are paid into different accounts, so a single template in
  -- settings could not cover it.
  payment_message  TEXT,
  -- How many payment screenshots the customer has sent through the bot. Capped,
  -- so a linked chat cannot use the shop as an image relay.
  payment_proofs   INTEGER NOT NULL DEFAULT 0
);

INSERT INTO orders_rebuild (
  id, ref, access_token, customer_name, email, phone, telegram,
  fulfilment, address, notes, status, subtotal_pence,
  created_at, updated_at, expires_at, notified_at,
  postage_pence, total_pence, confirmed_at, payment_sent_at,
  telegram_chat_id, telegram_linked_at, paid_at, dispatched_at, tracking_number
)
SELECT
  id, ref, access_token, customer_name, email, phone, telegram,
  fulfilment, address, notes, status, subtotal_pence,
  created_at, updated_at, expires_at, notified_at,
  postage_pence, total_pence, confirmed_at, payment_sent_at,
  telegram_chat_id, telegram_linked_at, paid_at, dispatched_at, tracking_number
FROM orders;

-- 3. Swap. The cascade empties order_items here; step 4 puts it back.
DROP TABLE orders;
ALTER TABLE orders_rebuild RENAME TO orders;

CREATE INDEX idx_orders_status  ON orders(status);
CREATE INDEX idx_orders_expiry  ON orders(status, expires_at);
CREATE INDEX idx_orders_created ON orders(created_at DESC);
CREATE INDEX idx_orders_email   ON orders(email);
CREATE INDEX idx_orders_chat    ON orders(telegram_chat_id);

-- 4. Restore the children.
DELETE FROM order_items;
INSERT INTO order_items SELECT * FROM _order_items_backup;

UPDATE stock_ledger
   SET order_id = (SELECT order_id FROM _ledger_orders_backup b WHERE b.ledger_id = stock_ledger.id)
 WHERE id IN (SELECT ledger_id FROM _ledger_orders_backup);

DROP TABLE _order_items_backup;
DROP TABLE _ledger_orders_backup;

-- 5. Existing rows the new model considers impossible.
--
-- Collection orders were being marked 'dispatched' because that was the only
-- way to close them, which is why a customer collecting in person was told
-- their books had been posted. There is nothing to post, so those are orders
-- that were handed over: 'completed' is what the owner meant.
UPDATE orders
   SET status = 'completed',
       completed_at = COALESCE(dispatched_at, updated_at),
       dispatched_at = NULL
 WHERE fulfilment = 'collection' AND status = 'dispatched';
