-- One draft per journey was not enough.
--
-- A large order goes to a different account; a regular customer has a different
-- arrangement; a collection may be paid in advance or on the day. The owner was
-- rewriting the box by hand every time. Now there are several per journey, each
-- with a label they choose, picked at the moment of confirming.
--
-- The cash-on-collection line moves in here too. It used to be fixed in the
-- source, so half of what a customer could receive was not visible in Settings.
-- It is still applied automatically when the tick is on - it is simply editable
-- now.
--
-- Whatever the owner has already written becomes the first slot of its journey,
-- and the rest start empty. An empty slot stays out of the picker until it is
-- filled in, so nothing appears half-built.

INSERT OR IGNORE INTO settings (key, value, updated_at)
  SELECT 'payment_draft_delivery_1', value, unixepoch()
    FROM settings WHERE key = 'payment_draft_delivery';

INSERT OR IGNORE INTO settings (key, value, updated_at)
  SELECT 'payment_draft_collection_1', value, unixepoch()
    FROM settings WHERE key = 'payment_draft_collection';

-- The wording that was previously hardcoded, now the owner's to change.
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  ('payment_draft_collection_cash',
   'No payment is needed now. Your books are set aside - message us to agree a time, and you can pay in cash when you collect.',
   unixepoch());

-- Starting labels. The owner renames these; they only ever appear in the portal.
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  ('payment_draft_delivery_1_label',      'Bank transfer',     unixepoch()),
  ('payment_draft_delivery_2_label',      'Second account',    unixepoch()),
  ('payment_draft_delivery_3_label',      'Other',             unixepoch()),
  ('payment_draft_collection_1_label',    'Paying in advance', unixepoch()),
  ('payment_draft_collection_2_label',    'Paying on the day', unixepoch()),
  ('payment_draft_collection_cash_label', 'Cash on collection', unixepoch());

DELETE FROM settings WHERE key IN ('payment_draft_delivery', 'payment_draft_collection');
