-- Shelf pages get words of their own, and keep their old addresses.
--
-- `blurb` is the owner's paragraph about a shelf. It is drawn under the shelf's
-- heading and used as the page's meta description - the line under the result
-- in Google. Until now every shelf page said only "91 Hadith titles at
-- As-Subkī Books", which gives a search engine nothing to match "hadith books"
-- against beyond the heading. Nullable: an empty one falls back to a generated
-- sentence, so nothing changes for a shelf until the owner writes something.
--
-- `shelf_redirects` remembers the paths a shelf used to have. Renaming a shelf
-- re-slugs it, and moving one changes the path of everything underneath, so
-- every link to the old address - a Telegram post, a bookmark, Google's index -
-- used to land on a 404. Now the shelf page looks an unknown path up here and
-- answers 301 to wherever that shelf lives now. Keyed by shelf id rather than
-- by new path, so a shelf renamed twice still sends both old names to its
-- current one; deleting the shelf deletes its history with it.
--
-- `categories` already moves the catalogue version (0051), so the new column
-- needs nothing more. `shelf_redirects` is read only by src/lib/shelves.ts on
-- the 404 path, outside the version-keyed cache, so it needs no triggers.
ALTER TABLE categories ADD COLUMN blurb TEXT;

CREATE TABLE shelf_redirects (
  old_path    TEXT    PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX shelf_redirects_category ON shelf_redirects (category_id);
