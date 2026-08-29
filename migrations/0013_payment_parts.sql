-- A message is built from parts, not chosen whole.
--
-- The three "delivery" drafts turned out to be bank accounts, and the two
-- "collection" drafts collection addresses - and either kind of order might be
-- paid by transfer or in cash. A collection paid by transfer therefore needs an
-- address *and* an account, which no single list of whole messages can hold
-- without a box for every combination of the two.
--
-- So: three accounts, two addresses, and one line for cash shared by both
-- journeys. Everything the owner has written carries over, labels included -
-- they have already renamed these boxes to match how they actually use them.

-- Bank accounts, from the old delivery drafts.
INSERT INTO settings (key, value, updated_at)
  SELECT 'payment_part_account_1', value, unixepoch()
    FROM settings WHERE key = 'payment_draft_delivery_1' AND TRIM(value) <> ''
  ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE TRIM(settings.value) = '';
INSERT INTO settings (key, value, updated_at)
  SELECT 'payment_part_account_2', value, unixepoch()
    FROM settings WHERE key = 'payment_draft_delivery_2' AND TRIM(value) <> ''
  ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE TRIM(settings.value) = '';
INSERT INTO settings (key, value, updated_at)
  SELECT 'payment_part_account_3', value, unixepoch()
    FROM settings WHERE key = 'payment_draft_delivery_3' AND TRIM(value) <> ''
  ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE TRIM(settings.value) = '';

-- Their names, which the owner has already set to the account names.
INSERT INTO settings (key, value, updated_at)
  SELECT 'payment_part_account_1_label', value, unixepoch()
    FROM settings WHERE key = 'payment_draft_delivery_1_label' AND TRIM(value) <> ''
  ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE TRIM(settings.value) = '';
INSERT INTO settings (key, value, updated_at)
  SELECT 'payment_part_account_2_label', value, unixepoch()
    FROM settings WHERE key = 'payment_draft_delivery_2_label' AND TRIM(value) <> ''
  ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE TRIM(settings.value) = '';
INSERT INTO settings (key, value, updated_at)
  SELECT 'payment_part_account_3_label', value, unixepoch()
    FROM settings WHERE key = 'payment_draft_delivery_3_label' AND TRIM(value) <> ''
  ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE TRIM(settings.value) = '';

-- Collection addresses, from the old collection drafts.
INSERT INTO settings (key, value, updated_at)
  SELECT 'payment_part_place_1', value, unixepoch()
    FROM settings WHERE key = 'payment_draft_collection_1' AND TRIM(value) <> ''
  ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE TRIM(settings.value) = '';
INSERT INTO settings (key, value, updated_at)
  SELECT 'payment_part_place_2', value, unixepoch()
    FROM settings WHERE key = 'payment_draft_collection_2' AND TRIM(value) <> ''
  ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE TRIM(settings.value) = '';
INSERT INTO settings (key, value, updated_at)
  SELECT 'payment_part_place_1_label', value, unixepoch()
    FROM settings WHERE key = 'payment_draft_collection_1_label' AND TRIM(value) <> ''
  ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE TRIM(settings.value) = '';
INSERT INTO settings (key, value, updated_at)
  SELECT 'payment_part_place_2_label', value, unixepoch()
    FROM settings WHERE key = 'payment_draft_collection_2_label' AND TRIM(value) <> ''
  ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE TRIM(settings.value) = '';

-- The cash wording, which had no home before: cash was a flag, and its sentence
-- was written into the code.
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  ('payment_part_cash',
   'No payment is needed now. Your books are set aside - we will agree a time with you, and you can pay in cash then.',
   unixepoch()),
  ('payment_part_cash_label', 'Cash', unixepoch());

DELETE FROM settings WHERE key LIKE 'payment_draft_%';

-- What the customer said they would rather do, stated at checkout.
--
-- Deliberately not the same column as cash_payment: one is what they asked for,
-- the other what the owner decided. Collapsing them would let a customer's
-- click rewrite the emails the shop sends.
ALTER TABLE orders ADD COLUMN payment_preference TEXT;
