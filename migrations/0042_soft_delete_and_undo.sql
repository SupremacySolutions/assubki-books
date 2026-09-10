-- Deleting a listing stops being the end of it, and a bulk edit becomes undoable.
--
-- Deleting a listing destroyed three things at once and none of them came back:
-- the cover objects in R2, the announcement in the Telegram channel, and - by
-- cascade - every row that book ever had in `stock_ledger`. The ledger exists so
-- that "where did that copy go?" is always answerable, and deleting the book was
-- the one operation that made it permanently unanswerable. The owner got a
-- confirm() and no second chance.
--
-- That was survivable while every change was one row at a time. It stops being
-- survivable the moment the portal can act on two hundred listings at once,
-- which is what `bulk_edits` below is for. Undo is not a companion to bulk
-- editing here; it is a precondition for it.

-- When the listing was put in the bin. NULL for everything that is really here.
--
-- Deliberately *not* the existing `status = 'archived'`, for three reasons:
--
--   1. `archived` is already load-bearing and means something else. The unsplit
--      branch of api/admin/books/[id]/set.ts archives set-part listings
--      permanently and on purpose, because `order_items` still point at them. If
--      archived also meant "scheduled for destruction", unsplit would be quietly
--      scheduling the destruction of rows that past orders depend on.
--   2. `status` holds one value. Deleting a draft would lose the fact that it
--      was a draft, and restoring it could not put that back. The prior status
--      is recorded in the tombstone instead.
--   3. They are navigated differently. Archived is a shelf state the owner moves
--      listings in and out of; the bin is a waiting room with a clock on it.
--
-- A sentinel `status = 'deleted'` was considered and rejected: `books.status`
-- carries CHECK (status IN ('draft','live','archived')) from 0001, SQLite cannot
-- alter a CHECK constraint, and rebuilding `books` - referenced by eight tables'
-- foreign keys and the source of the books_fts external-content index - is far
-- too much risk for what was only a second line of defence. Every query that
-- lists books filters `deleted_at` explicitly instead, and a source-level test
-- in the E2E suite is what keeps that true as queries are added.
ALTER TABLE books ADD COLUMN deleted_at INTEGER;

-- Partial, because a row in the bin is a rounding error against the catalogue
-- and is never the answer to any other question. The same reasoning as
-- idx_alerts_due in 0040.
CREATE INDEX idx_books_deleted ON books(deleted_at) WHERE deleted_at IS NOT NULL;

-- "I posted this in the channel myself, stop listing it as unannounced."
--
-- The portal's "Not announced" filter asks `telegram_message_id IS NULL`, which
-- is the right question only while the channel post is always made by the shop's
-- own bot. Marking a batch as announced by hand cannot set that column - there is
-- no message id, because the shop never sent the message - and it must not post
-- to Telegram either: a bulk action that makes one outbound call per selected
-- listing is exactly the shape the arrival-notice sweep is written to avoid.
--
-- So the filter learns a second way for a listing to be announced, and the bulk
-- action writes this instead.
ALTER TABLE books ADD COLUMN announced_by_hand INTEGER;

-- What a portal action did, in enough detail to do the opposite of it.
--
-- One table for two things that look different to the owner and are the same
-- underneath: the "Undo" on a bulk edit's banner, and the "Restore" on a listing
-- in the bin. A single-row delete records itself here with action = 'delete' and
-- a one-element `inverse`. Keeping them together means one expiry rule, one
-- idempotency rule, and one set of words for the ways an undo can fail - rather
-- than a tombstone table and an undo table that drift apart.
--
--   token     What the banner carries. Not the id: the id is guessable, and this
--             ends up in a URL the browser keeps in history.
--   summary   The owner-facing sentence, written when the action happened and
--             stored, not rebuilt at undo time. What was true then is what the
--             owner should be shown now - and it is also the ledger reason, so
--             a reversal reads as "undo: put 12 listings back on Fiqh".
--   actor     locals.admin.email. Nullable: the shared-password path has no
--             individual identity to record and says so rather than inventing one.
--   inverse   JSON: [{ "id": …, prior values }]. Per book, because a bulk edit
--             does not land uniformly - stock clamps at the reserved floor, a set
--             member is skipped - so "what it was before" cannot be one number.
--   undone_at Set by the claim itself, which is what makes replaying an undo a
--             no-op rather than a second application. Same trick leaseAlert uses.
CREATE TABLE bulk_edits (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  token     TEXT    NOT NULL UNIQUE,
  action    TEXT    NOT NULL,
  summary   TEXT    NOT NULL,
  actor     TEXT,
  affected  INTEGER NOT NULL,
  inverse   TEXT    NOT NULL,
  at        INTEGER NOT NULL DEFAULT (unixepoch()),
  undone_at INTEGER
);

-- Both sweeps read by age: the undo offer expires after a day, the audit row is
-- pruned after a week.
CREATE INDEX idx_bulk_edits_at ON bulk_edits(at);
