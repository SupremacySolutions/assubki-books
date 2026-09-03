-- What a sale actually gave away, written down at the time.
--
-- Sale reporting recomputed each line's discount as "the book's price today
-- minus what was charged", and decided which orders counted by comparing dates
-- against the sale's window. Both are guesses about the past made from the
-- present: repricing a book rewrote the value of a sale that finished months
-- ago, and any unrelated discount inside the window was credited to the sale.
--
-- These two columns are the facts, recorded when the order is placed and never
-- touched again.
ALTER TABLE order_items ADD COLUMN sale_id INTEGER REFERENCES sales(id);
-- The ordinary price this line was reduced from. `price_pence_snapshot` is
-- what was charged; without its counterpart there is nothing to subtract from
-- except today's price.
ALTER TABLE order_items ADD COLUMN full_price_pence INTEGER;

-- Reporting reads by sale.
CREATE INDEX idx_order_items_sale ON order_items(sale_id) WHERE sale_id IS NOT NULL;
