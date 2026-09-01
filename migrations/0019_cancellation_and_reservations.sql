-- Customer cancellation, and reserving copies from a delivery that is coming.

-- ---------------------------------------------------------------- cancelling
--
-- The customer's reason is not the owner's note. `cancel_note` already means
-- "why the shop cancelled this", and it is printed on the customer's page as
-- the shop speaking. Reusing it would put the customer's words in the shop's
-- mouth on the admin timeline, so their reason gets a column of its own.
ALTER TABLE orders ADD COLUMN customer_cancel_note TEXT;

-- Set when a customer asks to cancel an order that has gone too far to cancel
-- outright. The order stays exactly as it was until the owner answers - this
-- records that they are waiting, nothing more.
ALTER TABLE orders ADD COLUMN cancel_requested_at INTEGER;

-- ------------------------------------------------------------- reservations
--
-- Copies on their way to the shop, and how many of them are already claimed.
--
-- A claim cannot use `reserved`: that counts copies held out of `stock`, and
-- `CHECK (reserved <= stock)` forbids holding one that is not there yet. A
-- delivery is a different kind of promise and gets its own pair of numbers.
--
--   available to buy now  = stock - reserved            (unchanged)
--   free to reserve       = incoming - reserved_incoming
--
-- The cross-column rule (reserved_incoming <= incoming) cannot be added to an
-- existing table in SQLite without rebuilding it, so it is enforced where the
-- claim is made, the way the set pool already enforces its own arithmetic.
ALTER TABLE books ADD COLUMN incoming INTEGER NOT NULL DEFAULT 0 CHECK (incoming >= 0);
ALTER TABLE books ADD COLUMN reserved_incoming INTEGER NOT NULL DEFAULT 0 CHECK (reserved_incoming >= 0);

-- When it is expected, deliberately not a date.
--
-- Two parts, because the owner picks them from two selects: a vagueness word
-- and a month. A shop that promises the 14th and delivers on the 20th has
-- broken a promise; one that says "mid-October" and arrives on the 12th has
-- kept it. Deliveries slip, so the shop is given no way to be precise.
ALTER TABLE books ADD COLUMN incoming_vague TEXT;   -- early | mid | late | sometime
ALTER TABLE books ADD COLUMN incoming_month TEXT;   -- 'YYYY-MM'

-- Which lines of an order are claims on a delivery rather than copies in hand.
-- The whole order waits for the last of these to arrive, so the order page,
-- the release on cancellation and the owner's queue all need to know.
ALTER TABLE order_items ADD COLUMN from_incoming INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_books_incoming ON books(incoming) WHERE incoming > 0;
CREATE INDEX idx_orders_cancel_requested ON orders(cancel_requested_at) WHERE cancel_requested_at IS NOT NULL;
