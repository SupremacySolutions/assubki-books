-- Two things the owner's dashboard reads, made honest and cheap.
--
-- 1. Who searched, so "Looked for, not found" counts people rather than
--    submissions. One customer retyping a title five times, or reloading the
--    empty results page, was five votes for a book only one person wanted.
--
--    `visitor` is not an identity. It is a hash of the connecting address and
--    browser, salted with a server secret and the date, so the same person on
--    the same day is the same value and nothing else can be learned from it:
--    it cannot be reversed, it cannot be joined to an order, and it changes
--    every day. Rows written before this column existed have none and are
--    each counted as their own person, which is what they were counted as
--    before.
ALTER TABLE searches ADD COLUMN visitor TEXT;

-- 2. The portal's Messages tab carries an unread count on every portal page.
--    A partial index on the rows that have one means that count reads only
--    the orders actually waiting on an answer - usually none - rather than
--    every order the shop has ever taken.
CREATE INDEX IF NOT EXISTS idx_orders_unread_owner
    ON orders(last_message_at) WHERE unread_for_owner > 0;

-- The inbox lists every order that has a conversation, newest first.
CREATE INDEX IF NOT EXISTS idx_orders_last_message
    ON orders(last_message_at) WHERE last_message_id IS NOT NULL;
