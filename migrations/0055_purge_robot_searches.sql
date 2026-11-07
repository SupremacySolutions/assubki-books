-- Takes the robots out of "Looked for, not found".
--
-- From here on only a search a person made from the shop's own search box is
-- recorded (`isHumanSearch` in src/lib/searches.ts). This removes what got in
-- before that rule existed, so the owner's panel starts clean rather than
-- waiting ninety days for the prune:
--
-- - "search term string": the placeholder in the home page's search-box
--   description for Google, fetched literally by crawlers. A third of the log.
-- - A security scanner's probes. It posted markup ('"><asdf alt="">...f3f3')
--   in every encoding it had - plain, percent-escaped, double-escaped, \x
--   escapes, HTML entities, raw hex - and the normaliser turned each into a
--   row of letters and digits. Every variant carries its marker "asdf" or
--   "f3f3", or survives only as a long run of mixed hex.
-- - "test" and "zzzznotathing": the shop being tried out, by the owner or by
--   whoever was building it, before the portal session excluded them.
--
-- Only rows matching those shapes are touched. Everything else - every search
-- a customer typed - is left exactly as it was.
DELETE FROM searches
 WHERE terms IN ('search term string', 'test', 'zzzznotathing')
    OR terms LIKE '%asdf%'
    OR terms LIKE '%f3f3%'
    -- Nothing but hex digits and spaces, letters and digits mixed, and long:
    -- an encoded probe, not an ISBN (digits alone) and not a word.
    OR (terms NOT GLOB '*[^0-9a-f ]*'
        AND terms GLOB '*[a-f]*'
        AND terms GLOB '*[0-9]*'
        AND LENGTH(REPLACE(terms, ' ', '')) >= 12);
