-- Multi-buy prices: a book that costs less each when you take more.
--
-- The owner sets any number of offers per book, of two kinds - exactly N
-- copies for a total ("20 for £45"), and N or more at a price each ("10+ at
-- £2.50") - and the customer is charged the cheapest combination. The rules
-- live in src/lib/multibuy.ts, which the browser and the server both run.
--
-- A JSON column rather than a table: the catalogue grid is the hottest read in
-- the shop, and it needs to know only whether a book has offers at all. A join
-- or a subquery per card is the shape of thing that once ate the read budget.
-- [{ "kind": "bundle"|"from", "qty": N, "pence": P }], NULL when there are none.
ALTER TABLE books ADD COLUMN multibuy TEXT;

-- What multi-buy took off this line, in pence.
--
-- `price_pence_snapshot` keeps its meaning - the price of one copy, sale
-- applied - and the line's total is `price_pence_snapshot * qty -
-- multibuy_pence`. The saving is stored rather than an averaged unit price
-- because "3 for £10" does not divide into pennies, and the order must add up
-- to exactly what the customer was shown.
--
-- Nought on every line written before this, which is what they were charged.
ALTER TABLE order_items ADD COLUMN multibuy_pence INTEGER NOT NULL DEFAULT 0
  CHECK (multibuy_pence >= 0);
