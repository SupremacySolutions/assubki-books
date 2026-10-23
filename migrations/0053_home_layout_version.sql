-- The front page's layout moves the catalogue's version.
--
-- The owner now chooses which sections the front page shows and in what order,
-- and that choice is kept in `settings` under 'home_layout'. The front page
-- reads it through the same versioned cache as the rest of the catalogue
-- (src/lib/read-cache.ts), so a change to it has to move the version just as a
-- change to a book does - otherwise a reordered page would wait hours for the
-- old answer to expire.
--
-- Only that one key. Everything else in `settings` is the portal's business -
-- error notes, quota counts, the session epoch - and some of it is written on
-- every email sent. Bumping the version for those would throw the whole
-- catalogue cache away for nothing several times an hour. If db.ts ever reads
-- another key, add it to the WHEN clauses here.
CREATE TRIGGER catalogue_version_settings_insert AFTER INSERT ON settings
WHEN NEW.key = 'home_layout'
BEGIN
  UPDATE catalogue_version SET n = n + 1 WHERE id = 1;
END;
CREATE TRIGGER catalogue_version_settings_update AFTER UPDATE ON settings
WHEN NEW.key = 'home_layout' OR OLD.key = 'home_layout'
BEGIN
  UPDATE catalogue_version SET n = n + 1 WHERE id = 1;
END;
CREATE TRIGGER catalogue_version_settings_delete AFTER DELETE ON settings
WHEN OLD.key = 'home_layout'
BEGIN
  UPDATE catalogue_version SET n = n + 1 WHERE id = 1;
END;
