-- One payment draft served two different kinds of order.
--
-- A posted order needs bank details; a collection needs where to come and when.
-- The owner was editing the same box by hand for whichever this order happened
-- to be, every time. Two drafts, chosen by fulfilment. A collection being paid
-- in cash uses a standard line instead - that one is not worth maintaining.
--
-- Both start as whatever the single draft said, so nothing the owner wrote is
-- lost.

INSERT OR IGNORE INTO settings (key, value, updated_at)
  SELECT 'payment_draft_delivery', value, unixepoch()
    FROM settings WHERE key = 'payment_instructions';

INSERT OR IGNORE INTO settings (key, value, updated_at)
  SELECT 'payment_draft_collection', value, unixepoch()
    FROM settings WHERE key = 'payment_instructions';

DELETE FROM settings WHERE key = 'payment_instructions';

-- Postage was a number the owner typed over at confirmation anyway. The box now
-- offers whatever the last posted order used, which needs no maintaining.
DELETE FROM settings WHERE key = 'default_postage_pence';
