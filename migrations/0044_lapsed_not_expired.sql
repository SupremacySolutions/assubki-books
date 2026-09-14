-- A hold that runs out stops cancelling the order and starts asking the owner.
--
-- The forty-eight hour hold existed to answer one question - when do these
-- copies go back on the shelf - and it answered it by cancelling the order
-- outright. That was right while an order was a slip of paper. It stopped being
-- right once an order carried a conversation: ASB-BWS8 was amended by the owner
-- at 15:13 and swept away at 16:00, thirty-two minutes later, with a thread of
-- messages on it and the customer waiting in La Réunion for a reply. Nothing
-- malfunctioned. The rule simply could not see that somebody was working on it.
--
-- So the sweep stops deciding and starts pointing. The deadline still passes,
-- and the owner is still told - but the order stays exactly where it is, in
-- `requested`, with its copies still held and its messages still open, until a
-- person says what should happen to it.
--
-- Deliberately *not* a new `status` value. `orders.status` carries
-- CHECK (status IN ('requested','awaiting_payment','paid','dispatched',
-- 'completed','cancelled','expired')) from the table's own definition, SQLite
-- cannot alter a CHECK constraint, and rebuilding `orders` - which eight tables
-- reference - is far too much risk for a flag. It is also the wrong shape: a
-- lapsed order is not in a different state, it is in the same state and late.
-- Every query that already asks about `requested` should go on matching it.
ALTER TABLE orders ADD COLUMN lapsed_at INTEGER;

-- The portal asks one question of this column - "which orders are waiting on
-- me" - and the answer is a handful of rows against every order ever placed.
-- Partial for the same reason as idx_books_deleted in 0042.
CREATE INDEX idx_orders_lapsed ON orders(lapsed_at) WHERE lapsed_at IS NOT NULL;

-- `expired` is not retired, and this is worth stating so it is not tidied away
-- later. It remains the resting place for a reservation that was never paid for
-- after its shipment landed - `pay_by`, not `expires_at` - where the deadline is
-- a promise to somebody else in the queue rather than a guess at how long the
-- owner needs. Two deadlines that meant different things had been sharing one
-- ending; now they do not.
