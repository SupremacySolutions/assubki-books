-- Add cash_payment flag for collection orders.
--
-- Collection orders can be paid in cash on pickup. The owner ticks this to
-- show different wording on the customer's order page, and the collection
-- address message is phrased accordingly.

ALTER TABLE orders ADD COLUMN cash_payment INTEGER NOT NULL DEFAULT 0;
