-- A basket holding both kinds becomes two orders, and they have to find
-- each other.
--
-- One is packable this afternoon and carries a 48-hour hold; the other cannot
-- be packed until a box arrives and carries no clock at all. Kept as a single
-- order, the shelf half was held indefinitely - nothing could release it,
-- because neither sweep could see an order missing its column. Split, each
-- half gets the promise that is actually true of it.
--
-- The link is a shared token rather than a pointer to a sibling, because a
-- basket spanning two shipments makes three orders, not two.
ALTER TABLE orders ADD COLUMN split_group TEXT;

CREATE INDEX idx_orders_split ON orders(split_group) WHERE split_group IS NOT NULL;
