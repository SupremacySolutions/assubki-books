# As-Subkī Books

The shop's catalogue and order-capture site. Astro 7 (SSR) on Cloudflare
Workers, with D1 for data and book covers stored in R2.

Migrated off WordPress + WooCommerce at IONOS. Nothing about WordPress remains.

## The one thing to understand

**No money moves through this site.** An order is a *request to buy*. Submitting
one puts a 48-hour hold on the copies so the owner can arrange payment over
Telegram without someone else taking the same book. Payment is handled entirely
outside the site.

That shapes everything else:

- `books.stock` is copies held; `books.reserved` is copies spoken for by an
  unconfirmed request. **Availability is `stock - reserved`**, and it is computed
  in exactly one place (`src/lib/db.ts`). A page that computes its own
  availability will eventually disagree with checkout.
- `order_items` snapshots the title and price. Payment is agreed days later, so
  an order must show what was agreed, not today's catalogue.
- Every stock movement is appended to `stock_ledger`, so "where did that copy
  go?" is always answerable.

## Running it

Read the [development and test guide](docs/development.md) for managed server
shutdown, isolated E2E runs, production preview and local cover synchronisation.

```bash
npm install
npm run dev
```

For a fresh local D1, apply all migrations through Wrangler so its ledger is
recorded as well as the schema:

```bash
npx wrangler d1 migrations apply assubki-books --local
```

Production was reconciled through migration `0040` on 7 September 2026, and
`0041_order_amendments.sql` was applied on 8 September 2026, with all 41
filenames recorded in `d1_migrations`. For new migrations, inspect what
is pending, back up production, test locally, and apply remotely before deploying
code that requires the new schema. Follow the
[schema and backup guide](docs/schema-reconciliation/README.md#current-status--verified-7-september-2026).
Do not replay an old migration file or seed the ledger for unapplied migrations.
A local database created by the former manual SQL loop needs its own ledger
reconciliation before using `migrations apply`.

Do not delete `.wrangler/state` while the dev server is running - miniflare
holds the SQLite file open and every request then fails with an internal error.
Stop the server first.

## Layout

```
migrations/0001_schema.sql   Tables, indexes, FTS5, the stock CHECK constraint
migrations/0002_seed.sql     GENERATED - 226 books, 26 categories, 454 images
scripts/lib/catalogue.mjs    Shared transform: slugs, title splitting, sanitising
scripts/migrate-from-woo.mjs Rebuilds the seed from data/raw/
scripts/fetch-images.mjs     Downloads + re-encodes covers into public/img/
scripts/upload-covers.mjs    Pushes those covers into R2 under their image_key
scripts/resize-covers.mjs    Stores each cover at the sizes the site shows it at
src/lib/db.ts                Every catalogue read
src/lib/orders.ts            Hold, expire, and read orders
src/lib/amend.ts             Taking books off an order already placed
src/lib/notify.ts            Customer + owner email, owner Telegram
src/middleware.ts            301s from the old WooCommerce URLs
workers/expire-holds/        Cron Worker that releases lapsed holds
```

## Re-running the migration

Both scripts are idempotent and read from `data/raw/` (captured from the
WooCommerce Store API - the live WordPress site is never contacted at runtime):

```bash
node scripts/fetch-images.mjs      # skips covers already present
node scripts/migrate-from-woo.mjs  # rewrites migrations/0002_seed.sql
```

## Things that will bite you

- **Every book photo is in R2**, under `books/` (migrated covers) and
  `uploads/` (added through the portal). They used to be split, with `books/`
  as static assets - that made delete half-work, since the files stayed in the
  repo forever. `public/img/books/` is gitignored now; rebuild it locally with
  `scripts/fetch-images.mjs` and push with `scripts/upload-covers.mjs`.
- **Covers are sized ahead of time, not on the way out.** Each display size is
  a separate object beside the original - `1.webp`, `1-card.webp` and so on -
  because Cloudflare Images would do it per request and is neither enabled on
  this account nor free. `scripts/resize-covers.mjs --sample` writes a contact
  sheet without uploading anything; look at it before a real run. The route
  falls back to the original for any size that is missing, so an owner's upload
  and anything predating the pass still work.
- **The photo itself is never altered.** There was a pass that framed every
  cover on the paper colour with the mark in the corner; the owner did not want
  it and it was reverted. If you change what the stored bytes are again, bump
  `IMAGE_VERSION` in src/lib/image-presets.ts - the keys are served `immutable`
  for a year and no purge reaches a browser.
- **A photo is straightened before it is uploaded.** The portal detects the
  book in the shot, warps its corners square and crops the rest, then shows it
  in a dialog with four draggable handles and uploads nothing until the owner
  agrees (src/scripts/cover-clean.ts, src/components/CoverReview.astro).
  `/clean-check` mounts that dialog on its own in dev; `npm run test:covers`
  drives the detector itself against painted fixtures, which is where a
  regression in it will actually be caught - the HTTP suite cannot click and
  the portal needs a password.
- **The detector reads the background twice, and that is load-bearing.** One
  Otsu cut splits a *two-tone* cover rather than splitting the cover from the
  table - the shop's own Fiqh in 40 Days is cream above and near-black navy
  below, and on a dark surface the navy half fell on the background side and
  was thrown away. What was left was still a book-shaped rectangle, so nothing
  refused it and the owner was handed half his cover. `hysteresis` in
  cover-clean.ts keeps a pixel that is only weakly clear of the background when
  it is *joined* to one that is clearly clear of it, and `weakBar` sets that
  lower bar from the border ring's median and deviation. Do not set it from a
  fraction of the cut (the cut sits on top of the background cluster, often at
  0) or from a high percentile of the ring (a frame-filling cover is part of
  the ring). Both were tried; `npm run test:covers` holds them out.
- **What the review pane shows is what gets stored.** The pane runs the same
  `frameToBox` the upload does, so the 5:7 framing - which for a cover narrower
  than the box either continues its outer columns sideways or takes about eight
  percent off its height - is visible before the owner agrees to it. It used to
  show the bare warp and frame afterwards, silently.
- **Background removal is optional and refuses rather than guesses.** U²-Net
  (Apache-2.0; *not* BRIA RMBG, which is non-commercial, and *not* the
  `u2net_portrait` checkpoint, whose training set is not) runs in the browser
  on onnxruntime-web, loaded only when the box is ticked. Two sizes, chosen in
  the dialog: `u2netp` at 4MB and the full `u2net` at 168MB. Its output is
  already 0..1 - do not rescale it. Rescaling a mask from a crop that is all
  book turns noise into a confident mask and paints the cover white;
  `checkMask` refuses instead, and `refineMask` tightens the soft edge that
  otherwise leaves a fringe of background round the cover. The weights live in
  R2 under `models/` and are served by src/pages/model/[...key].ts (which
  honours `Range`, so a 168MB download on a phone can resume); the runtime is
  bundled with the site. It needs `'wasm-unsafe-eval'` in the CSP's
  `script-src`: Chromium refuses to compile any wasm module without it, so
  removing it does not weaken this feature, it deletes it - and only in
  Chromium, which is what made it look intermittent.
- **The shelf crops, and that is load-bearing.** The scans carry a white margin
  of their own - six pixels each side of a 168px hero on most of them - and
  `object-fit: cover` is what removes it. Anything that stops it cropping puts
  that border back on every cover. Cropping is only safe because the strip is
  given upright covers only (see `upright` in src/pages/index.astro); a
  landscape photo or a spine is not offered a slot.
- **A cut-out that came out wrong can be reported** from the dialog. It keeps
  the photo, the result and a note in R2 under `reports/`. That is for working
  out which of the edge handling, the thresholds or the model was at fault -
  not for training: that would need hand-painted correct masks and a GPU, and a
  handful of examples would overfit.
- **A set sold in parts is several ordinary listings, not one clever one.**
  Each way of buying it is its own `books` row linked by `set_id`, so holds,
  the ledger, cancellation and the expiry sweep never learned about sets. Only
  two things know: `applySetAvailability` in lib/db reads it, and the payment
  branch of orders/[ref]/status decrements it.
- **Set stock is a count per volume, not a number of sets.** Sell volumes 1-2
  out of three sets and you hold two complete sets *and three* of volumes 3-4;
  no single number says both. Availability of an option is the smallest count
  among the volumes it covers, minus what any overlapping option is holding.
- **Never roll a category tree up in SQL here.** `categoryCounts` used
  `JOIN categories d ON d.path = c.path OR d.path LIKE c.path || '/%'`, which
  cannot use an index, so it nested-looped categories against categories
  against every book link: ~34,700 rows read per call on the home page and
  every catalogue page. That was **95% of the whole database read budget** and
  put it over D1's 5M rows/day. It reads the 441 links once and rolls them up
  in JS now, cached for a minute; `forgetCategoryCounts()` is called by every
  route that moves a book or a shelf. `npx wrangler d1 insights assubki-books`
  is how this was found and how to check it again.
- **Covers crop sideways, never top to bottom.** `cropsCleanly` in
  lib/cover-fit decides: a cover wider than 3:4 fills the box and is trimmed at
  the sides, where these scans carry ~3.6% of white margin each side; a taller
  one is never trimmed, because that is where a title sits. Its own module with
  no imports so the suite can check it. Each photo on a book page carries its
  own answer in `data-fit` - the main image used to keep whichever fit the
  first one needed.
- **Volume counts are suggested, never assumed.** `scripts/suggest-volumes.mjs`
  reads the books that say how many volumes they are and *prints* the UPDATEs.
  17 of the 38 that mention volumes give a usable number; the rest need reading.
- **Posting is not proof of delivery.** A posted order stays `dispatched` until
  somebody confirms it arrived, through a separate "Confirm delivered" action.
  It briefly worked the other way - `closesOnDispatch` filed a paid order as
  completed the moment it was posted, on the grounds that the second click told
  the portal nothing - and that was wrong: the shop wants to know which parcels
  are still in the post, and a completion timestamp equal to the dispatch one is
  a record of a delivery nobody ever saw. Cash on delivery kept its second step
  throughout, because there the money arrives at the door.
- **Where a collecting customer is told to come** is the first written
  collection draft (`collectionAddress()` in lib/settings). There used to be a
  separate `collection_address` setting as well, so two places said where to
  collect and could disagree.
- **Do not name an R2 binding `IMAGES`.** The Astro Cloudflare adapter treats a
  binding of that name as the Cloudflare Images service and wires itself to it.
  The uploads bucket is `UPLOADS`.
- **Legacy slugs are matched case-insensitively.** WordPress stored
  `%d8%a7`; the URL parser normalises the incoming path to `%D8%A7`. An exact
  match sends every Arabic-slugged legacy link - most of them - to the catalogue
  instead of the book.
- **`/checkout` must not be in the legacy redirect list.** WooCommerce used that
  path too, and redirecting it swallows this site's own checkout route.
- **FTS5 column names must match `books`' column names.** It is an external
  content table, so a column called `description` sends FTS looking for a
  `books.description` that does not exist.
- **Stock quantities are mostly placeholders.** WooCommerce's public API exposes
  a boolean, not a count. 18 books leaked a real number through
  `stock_availability.text` and those were imported; the other 201 in-stock
  titles were seeded at 3 - enough to read "In stock" without claiming a
  scarcity the source never asserted. The owner sets real numbers in the admin.

## The portal

`/admin`, guarded in `src/middleware.ts` rather than per-page, so a new admin
route cannot be added unprotected by forgetting to guard it. Listings, stock,
photo uploads, the order queue, and the confirm step that sets postage and
sends payment details.

Two auth paths, and only ever one active: Cloudflare Access when `ACCESS_AUD`
is set, otherwise a shared password. See SETUP.md.

**A confirmed order only advances if a message actually reached the customer.**
An order marked "awaiting payment" that the customer never heard about looks
handled but is not, so the confirm endpoint keeps it in the queue and says
plainly that nothing went out.

**Books can come off an order without cancelling it.** A customer asked for
three titles to be removed and there was nothing to press: the portal offered
cancelling the whole order or deleting it, so the removal happened in the
messages and nowhere else - the order went on holding copies of books nobody
wanted and quoting a total for them. "Take books off this order", under the
packing list, sets a new quantity per line; the copies go back on the shelf
through the same ledgered release cancelling uses, the figures follow, and the
customer is sent the revised list. Unpaid orders only, never down to nothing -
that is a cancellation - and nothing can be added, which would need an
availability check and a fresh hold. Unlike confirming, the change stands even
if no message could be delivered: the copies are already back on the shelf and
somebody else may have taken them, so the owner is told what did not go out
rather than having the amendment undone underneath them.

**Deleting a listing is two steps a month apart.** It used to be one, and that
one destroyed the cover objects in R2, the Telegram post, and - by cascade - the
book's whole `stock_ledger` history, which is the one thing the ledger exists to
make un-loseable. Deleting now sets `books.deleted_at`, takes the listing off the
shop immediately and does nothing irreversible; `Recently deleted` in the portal
restores it, and the cron Worker destroys it for good after thirty days.
`src/lib/book-deletion.ts` owns all of it. Two consequences worth knowing:

- **Every query that lists books must say `deleted_at IS NULL`.** There is no
  sentinel status doing this quietly - `books.status` is fenced by a CHECK
  constraint from 0001 that SQLite cannot alter without rebuilding a table eight
  others point at - so the clause *is* the defence. A source-level assertion in
  suite 8 reads every `FROM books` in the tree and fails the build if one neither
  carries the filter nor sits on its allowlist with a reason. Two queries filter
  status *negatively* (`!= 'archived'`) and would otherwise have gone on serving
  deleted books: `bookBySlug` and `partCandidates`.
- **The channel post comes down at delete time, not at purge time**, and this is
  forced rather than chosen: a Telegram bot may only delete its own message
  within 48 hours of posting it, so a deferred delete would fail every time and
  fill the channel with adverts for books that no longer exist. Restoring cannot
  bring the post back; the listing page reposts it.

**A bulk edit records its inverse before it runs.** `/admin/books` acts on a
selection - status, shelf, stock, price - and every action writes a `bulk_edits`
row first, which is what the banner's Undo spends. Three rules hold across all of
them: nothing loops (D1 refuses over a hundred bound parameters, so ids travel as
one bound JSON array, as `releaseOrders` does it); nothing is silently skipped (a
listing left alone for holding copies, or for being part of a set, or a stock
figure bent up to the reserved floor, is counted and said out loud); and the
stock ledger row is written **before** the update, because D1 runs a batch in
order and an INSERT that reads `books.stock` afterwards records every delta as
zero - a ledger that looks healthy and says nothing.

**A search that finds nothing can now be answered.** `searches` has always logged
the terms anonymously; `book_requests` is the half with an address attached, left
by the customer on the empty catalogue page. It is portal-only - nothing is ever
sent automatically - which is why there is no `handled_at`: the privacy page
promises the address goes when the owner is done with it, and the only way to
keep that is for "Done with this" to be a DELETE.

## Connections

Email (Resend), the Telegram bot, and portal sign-in are all optional - the
shop takes orders and holds stock without them, logging what it would have
sent. **SETUP.md** covers turning each one on.

The constraint worth knowing: **a Telegram bot cannot open a conversation.** It
can only message someone who messaged it first. That is why an order carries a
`t.me/<bot>?start=<ref>_<token>` deep link and why `/api/telegram/webhook`
exists - tapping it is the moment permission is granted. Email is the fallback
for anyone who never taps.

## Deploying

```bash
npm run deploy
npx wrangler deploy -c workers/expire-holds/wrangler.jsonc
```

The live shop is served at https://assubkibooks.co.uk. Custom-domain routing is
managed in Cloudflare, outside this repository's `wrangler.jsonc`; the absence
of a `routes` array does not mean a deployment leaves the live shop untouched.
Deploy the sweeper as well when changing its shared notification or stock code.
