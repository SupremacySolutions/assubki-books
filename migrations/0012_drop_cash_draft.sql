-- The cash-on-collection draft was a slot too many.
--
-- It existed so a cash order would not open with bank details in the box, but
-- it did that by being a third collection draft the owner had to maintain for a
-- case the picker already covers. Ticking "paying in cash" now asks them which
-- of their own two wordings to send, which is the same safeguard without the
-- extra box.
--
-- Its wording was worth keeping, so it becomes the second collection draft -
-- which also gives the picker two things to offer straight away rather than
-- one. The conditional upsert covers both shapes the second slot can be in: no
-- row at all, or a row saved as empty. Guarding on the row merely existing
-- would throw the wording away in the second case.

INSERT INTO settings (key, value, updated_at)
  SELECT 'payment_draft_collection_2', value, unixepoch()
    FROM settings WHERE key = 'payment_draft_collection_cash' AND TRIM(value) <> ''
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()
   WHERE TRIM(settings.value) = '';

UPDATE settings
   SET value = 'Paying on the day', updated_at = unixepoch()
 WHERE key = 'payment_draft_collection_2_label'
   AND TRIM(value) = '';

DELETE FROM settings
 WHERE key IN ('payment_draft_collection_cash', 'payment_draft_collection_cash_label');
