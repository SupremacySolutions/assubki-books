-- Receipts are idempotent events. All receipt lines, allocations and stock
-- movements commit in the same D1 batch, including the ready-order outbox.
ALTER TABLE shipments ADD COLUMN delivery_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE books ADD COLUMN delivery_version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  shipment_id INTEGER REFERENCES shipments(id) ON DELETE SET NULL,
  book_id INTEGER REFERENCES books(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  applied_at INTEGER
);
CREATE TABLE delivery_items (
  delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  qty INTEGER NOT NULL CHECK (qty >= 0),
  PRIMARY KEY (delivery_id, book_id)
);
CREATE TABLE delivery_allocations (
  delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  qty INTEGER NOT NULL CHECK (qty > 0),
  paid INTEGER NOT NULL CHECK (paid IN (0,1)),
  PRIMARY KEY (delivery_id, item_id)
);

-- One ready notice per order, including reservations made from a normal book
-- page. Keep the existing table name and preserve already-delivered notices.
CREATE TABLE ready_notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shipment_id INTEGER REFERENCES shipments(id) ON DELETE SET NULL,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  queued_at INTEGER NOT NULL DEFAULT (unixepoch()),
  sent_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT
);
INSERT INTO ready_notices (shipment_id,order_id,queued_at,sent_at,attempts,last_error)
SELECT MIN(shipment_id),order_id,MIN(queued_at),MAX(sent_at),MAX(attempts),MAX(last_error)
FROM shipment_notices GROUP BY order_id;
DROP TABLE shipment_notices;
ALTER TABLE ready_notices RENAME TO shipment_notices;
CREATE INDEX idx_notices_pending ON shipment_notices(next_attempt_at,id) WHERE sent_at IS NULL;

-- Older mixed orders could be told after only their first title arrived.
-- Wait for the remaining claims, then send their one complete-order notice.
UPDATE shipment_notices SET sent_at=NULL, next_attempt_at=0
WHERE order_id IN (SELECT o.id FROM orders o WHERE o.status IN ('requested','awaiting_payment')
  AND EXISTS (SELECT 1 FROM order_items WHERE order_id=o.id AND from_incoming=1));
UPDATE orders SET pay_by=NULL
WHERE status IN ('requested','awaiting_payment')
  AND EXISTS (SELECT 1 FROM order_items WHERE order_id=orders.id AND from_incoming=1);
INSERT OR IGNORE INTO shipment_notices(shipment_id,order_id)
SELECT shipment_id,id FROM orders WHERE status IN ('requested','awaiting_payment')
  AND pay_by IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM order_items WHERE order_id=orders.id AND from_incoming=1);

-- A stale basket must not acquire claims after receipt closes reservations.
CREATE TRIGGER shipment_claims_open
BEFORE UPDATE OF reserved_incoming ON books
WHEN NEW.reserved_incoming > OLD.reserved_incoming AND NEW.shipment_id IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM shipments WHERE id=NEW.shipment_id AND status='open')
BEGIN SELECT RAISE(ABORT, 'shipment is not open'); END;

-- Keep stale forms and alternate callers from advancing an unfilled order.
CREATE TRIGGER orders_wait_for_arrival
BEFORE UPDATE OF status ON orders
WHEN NEW.status IN ('paid','dispatched','completed') AND NEW.status != OLD.status
 AND EXISTS (SELECT 1 FROM order_items WHERE order_id=NEW.id AND from_incoming=1)
BEGIN SELECT RAISE(ABORT, 'order is still waiting for books'); END;
