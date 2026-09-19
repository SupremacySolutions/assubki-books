-- What the channel post last said about stock.
--
-- Two things hang on it. A post is kept in step with the shop as copies sell,
-- and the column is what makes that cheap: only a book whose post says
-- something other than what is free now gets an edit, so the same sync can be
-- asked for after every checkout, cancellation and stock change, and again by
-- the sweep, without touching Telegram when nothing moved.
--
-- And it is how the portal knows a book has come back. A post showing nought
-- on a book with copies again is one the channel has scrolled past, so the
-- owner is offered a fresh post at the bottom rather than an edit to one
-- nobody will scroll up to.
--
-- NULL for everything already posted: nobody recorded what those said. The
-- sync treats that as out of step and edits once, which also brings every
-- older post up to the wording that says "View listing" at nought.
ALTER TABLE books ADD COLUMN telegram_shown_available INTEGER;

-- When the post went to nought, and NULL while it shows copies.
--
-- The line between "sold out a moment" and "sold out a month". A hold that
-- lapses gives its copy back within two days, and the post it emptied should
-- simply come back to life where it is. A book that has sat at nought for
-- weeks and then been restocked is a different thing: its post is far up the
-- channel, and editing it there tells nobody. Past that line the sync leaves
-- the post saying out of stock and the owner is offered a fresh one.
ALTER TABLE books ADD COLUMN telegram_sold_out_at INTEGER;

-- The sweep asks "which posted listings are out of step?" every quarter of an
-- hour. Posted listings are a fraction of the catalogue, so it reads those and
-- not the rest.
CREATE INDEX idx_books_channel_posted ON books(telegram_message_id)
  WHERE telegram_message_id IS NOT NULL AND deleted_at IS NULL;
