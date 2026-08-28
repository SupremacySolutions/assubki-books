-- The customer's view of an order, rather than the shop's.
--
-- Status alone says where an order is now; it cannot say when it got there.
-- A customer coming back a week later wants the story: requested on the 3rd,
-- confirmed on the 4th, posted on the 6th with this tracking number. These
-- three columns are what turns a status into a timeline.

ALTER TABLE orders ADD COLUMN paid_at INTEGER;
ALTER TABLE orders ADD COLUMN dispatched_at INTEGER;

-- Only meaningful for a delivery. Free text because carriers differ and the
-- owner is copying whatever the Post Office receipt says.
ALTER TABLE orders ADD COLUMN tracking_number TEXT;
