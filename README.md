# As-Subkī Books

The shop's catalogue and order-capture site. Astro 7 (SSR) on Cloudflare
Workers, with D1 for data and the book covers shipped as static assets.

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

```bash
npm install
npm run dev
```

The local D1 needs seeding once. Every migration, in order - the schema and the
seed alone leave out the portal and everything the order lifecycle added, and
the first page that reads a missing column just fails:

```bash
for f in ./migrations/*.sql; do npx wrangler d1 execute assubki-books --local --file="$f"; done
```

A new migration is applied the same way, to local and then to production:

```bash
npx wrangler d1 execute assubki-books --local --file=./migrations/0006_cash_payment.sql
npx wrangler d1 execute assubki-books --remote --file=./migrations/0006_cash_payment.sql
```

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
src/lib/db.ts                Every catalogue read
src/lib/orders.ts            Hold, expire, and read orders
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

## Connections

Email (Resend), the Telegram bot, and portal sign-in are all optional - the
shop takes orders and holds stock without them, logging what it would have
sent. **SETUP.md** covers turning each one on.

The constraint worth knowing: **a Telegram bot cannot open a conversation.** It
can only message someone who messaged it first. That is why an order carries a
`t.me/<bot>?start=<ref>_<token>` deep link and why `/api/telegram/webhook`
exists - tapping it is the moment permission is granted. Email is the fallback
for anyone who never taps.

## Not built yet

The domain cutover. See the cutover plan - the domain carries the owner's IONOS
email, and moving nameservers without recreating the MX records first will
silently kill their mail.

## Deploying

```bash
npm run deploy
npx wrangler deploy -c workers/expire-holds/wrangler.jsonc
```

The site has no `routes` in `wrangler.jsonc`, so it deploys to
`assubki-books.<subdomain>.workers.dev`. The live domain still points at
WordPress and is untouched. See the cutover plan before changing that - the
domain carries the owner's IONOS email, and moving nameservers without
recreating the MX records first will silently kill their mail.
