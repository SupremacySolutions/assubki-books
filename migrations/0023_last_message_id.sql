-- A cursor the poll can actually count on.
--
-- The thread poll asked for "anything newer than `since`", and `since` was a
-- whole-second timestamp. Two messages written inside the same second made that
-- ambiguous in the worst way: the page had rendered the first, so it sent that
-- second as its cursor, and the server's own early-out - `last_message_at >
-- since` - was false. Nothing had moved, as far as it could tell. The second
-- message did not arrive until the customer reloaded, and `markRead` never ran,
-- so the thread stayed unread and the next notification fell back to the
-- half-hour rule instead of going out at once.
--
-- A Telegram media group is the likely way in: several screenshots sent at once
-- reach the webhook as separate updates, comfortably inside one second.
--
-- Message ids are monotonic and unique, which is exactly what a cursor needs
-- and what a second-resolution clock is not. `last_message_at` stays - it is
-- what the retention sweep and the notification debounce read, and both of
-- those genuinely want a time.
ALTER TABLE orders ADD COLUMN last_message_id INTEGER;

-- Existing threads get their cursor, so a page open across the deploy does not
-- have to reload to catch up.
UPDATE orders
   SET last_message_id = (SELECT MAX(id) FROM messages WHERE order_id = orders.id)
 WHERE EXISTS (SELECT 1 FROM messages WHERE order_id = orders.id);
