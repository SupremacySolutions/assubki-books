-- The whole channel post, the owner's to rewrite.
--
-- 0032 gave him a note that was added to a caption the shop still wrote. That
-- was the wrong reading of what he asked for: he wants the post itself - to
-- move a line, open with something of his own, say it differently. So the
-- note becomes the caption, and when it is set the shop sends it as written.
--
-- Left NULL until he touches it. That is the difference between "he has not
-- written one" and "he has written one and it happens to look like ours": an
-- untouched listing keeps generating its post, so the price and what is left
-- go on being right by themselves, and only a listing he has actually taken
-- over stops tracking the row. Clearing the box hands it back.
--
-- The trade is real and belongs to him: a post he has written is a post the
-- shop can no longer keep true. The portal warns when a custom caption no
-- longer matches the price or the stock it was written against, which is the
-- honest half of giving him the pen.
ALTER TABLE books ADD COLUMN telegram_caption TEXT;

-- 0032's field, gone the day after it arrived. It was never released to the
-- owner and holds nothing: the one value written to it was a test of mine,
-- cleared before this ran.
ALTER TABLE books DROP COLUMN telegram_note;
