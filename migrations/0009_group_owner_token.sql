-- One token granted two different powers.
--
-- The share link carried the only token a group basket had, so every
-- participant held the key that sends the order - "only the organiser can send
-- it" was a rule the page followed and the server did not. And the organiser's
-- own role lived nowhere but their browser, so clearing it, or opening the
-- basket on another device, stranded the basket: rejoining through the share
-- link made them an ordinary member of their own group, and nobody could send
-- it at all.
--
-- Two tokens. The share link adds; the owner token sends, and the server
-- checks it. The owner token goes to the organiser by email, so losing the
-- page is no worse than losing an order confirmation - the link is in their
-- inbox.

ALTER TABLE group_baskets ADD COLUMN owner_token TEXT NOT NULL DEFAULT '';
ALTER TABLE group_baskets ADD COLUMN organiser_email TEXT;

-- Any basket made before this had one token doing both jobs, so whoever held
-- that link was the organiser. Say so, rather than inventing an owner token
-- nobody has ever seen: that silently locked the only existing basket, whose
-- organiser was then a member of their own group with no way to send it and no
-- email to recover from. These rows keep the old, weaker arrangement until they
-- expire; every basket made from here on gets two real keys.
UPDATE group_baskets SET owner_token = token WHERE owner_token = '';
