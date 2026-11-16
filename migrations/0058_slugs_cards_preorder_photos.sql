-- Addresses that say something, a picture for every shared link, and more
-- than one photo on a pre-order.
--
-- 1. A shipment's address. `/shipments/3` told nobody where the books were
--    coming from or when, which is the one thing a customer shown the link
--    wants to know before they open it. The slug is made from the title by
--    `shipmentSlug` in src/lib/shipments.ts - SQL has no way to fold "Ḥ" to
--    "h" - so existing rows are filled by `ensureShipmentSlugs` the first time
--    anything asks for one, not here. Fixed once the shipment opens: links to
--    it are in the channel by then, and the numbered address keeps working by
--    redirecting to this one.
ALTER TABLE shipments ADD COLUMN slug TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_shipments_slug ON shipments(slug) WHERE slug IS NOT NULL;

--    The picture a shared shipment link shows. Drawn in the portal (canvas,
--    in the owner's browser - nothing on the edge can draw it) and stored in
--    R2 under `uploads/shipments/`. `card_sig` is what it was drawn from, so
--    the portal can tell when the title, date or count has moved under it.
ALTER TABLE shipments ADD COLUMN card_key TEXT;
ALTER TABLE shipments ADD COLUMN card_sig TEXT;

-- 2. A pre-order's own address, for the same reason, and so one book can be
--    shared on its own instead of as a card on a page of five.
ALTER TABLE preorders ADD COLUMN slug TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_preorders_slug ON preorders(slug) WHERE slug IS NOT NULL;

-- 3. A pre-order's photos - the set, the spines, the inside pages - in the
--    order the owner puts them. Shaped like `book_images`, and numbered the
--    same way: 0, 1, 2… with no gaps, and 0 is the cover.
--
--    `preorders.image_key` stays, as a copy of the cover. Every place that
--    shows one picture of a pre-order - the list, the channel post, the
--    emails - goes on reading that column, so none of them gains a join; the
--    code that changes the photos writes both in one batch.
CREATE TABLE IF NOT EXISTS preorder_images (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  preorder_id INTEGER NOT NULL REFERENCES preorders(id) ON DELETE CASCADE,
  image_key   TEXT    NOT NULL,
  width       INTEGER,
  height      INTEGER,
  sort        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_preorder_images ON preorder_images(preorder_id, sort);

-- The cover each pre-order already has becomes its first photo.
INSERT INTO preorder_images (preorder_id, image_key, width, height, sort)
SELECT id, image_key, image_width, image_height, 0
  FROM preorders
 WHERE image_key IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM preorder_images pi WHERE pi.preorder_id = preorders.id);

-- With several photos a pre-order's channel post is an album: one message per
-- photo. Taking it down means deleting every one of them, so their ids are
-- kept (a JSON array) the way a listing's are. NULL for a post of one photo,
-- whose id is `telegram_message_id` alone.
ALTER TABLE preorders ADD COLUMN telegram_album_ids TEXT;
