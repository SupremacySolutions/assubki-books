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

The local D1 needs seeding once:

```bash
npx wrangler d1 execute assubki-books --local --file=./migrations/0001_schema.sql
npx wrangler d1 execute assubki-books --local --file=./migrations/0002_seed.sql
```

Do not delete `.wrangler/state` while the dev server is running — miniflare
holds the SQLite file open and every request then fails with an internal error.
Stop the server first.

## Layout

```
migrations/0001_schema.sql   Tables, indexes, FTS5, the stock CHECK constraint
migrations/0002_seed.sql     GENERATED — 226 books, 26 categories, 454 images
scripts/lib/catalogue.mjs    Shared transform: slugs, title splitting, sanitising
scripts/migrate-from-woo.mjs Rebuilds the seed from data/raw/
scripts/fetch-images.mjs     Downloads + re-encodes covers into public/img/
src/lib/db.ts                Every catalogue read
src/lib/orders.ts            Hold, expire, and read orders
src/lib/notify.ts            Customer + owner email, owner Telegram
src/middleware.ts            301s from the old WooCommerce URLs
workers/expire-holds/        Cron Worker that releases lapsed holds
```

## Re-running the migration

Both scripts are idempotent and read from `data/raw/` (captured from the
WooCommerce Store API — the live WordPress site is never contacted at runtime):

```bash
node scripts/fetch-images.mjs      # skips covers already present
node scripts/migrate-from-woo.mjs  # rewrites migrations/0002_seed.sql
```

## Things that will bite you

- **Do not name an R2 binding `IMAGES`.** The Astro Cloudflare adapter treats a
  binding of that name as the Cloudflare Images service and wires itself to it.
  The uploads bucket is `UPLOADS`.
- **Legacy slugs are matched case-insensitively.** WordPress stored
  `%d8%a7`; the URL parser normalises the incoming path to `%D8%A7`. An exact
  match sends every Arabic-slugged legacy link — most of them — to the catalogue
  instead of the book.
- **`/checkout` must not be in the legacy redirect list.** WooCommerce used that
  path too, and redirecting it swallows this site's own checkout route.
- **FTS5 column names must match `books`' column names.** It is an external
  content table, so a column called `description` sends FTS looking for a
  `books.description` that does not exist.
- **Stock quantities are mostly placeholders.** WooCommerce's public API exposes
  a boolean, not a count. 18 books leaked a real number through
  `stock_availability.text` and those were imported; the other 201 in-stock
  titles were seeded at 3 — enough to read "In stock" without claiming a
  scarcity the source never asserted. The owner sets real numbers in the admin.

## Not built yet (phase 2)

The admin panel (`/admin`, behind Cloudflare Access), one-click Telegram
posting, and the domain cutover. `src/lib/notify.ts` already has the Telegram
code path; it needs `TELEGRAM_BOT_TOKEN` and `TELEGRAM_OWNER_CHAT_ID`.

Email needs the Workers Paid plan, a domain onboarded to Cloudflare Email
Sending, a `send_email` binding named `EMAIL`, and an `ORDER_FROM` var. Until
then `sendOrderEmails` logs what it would have sent and the order still
completes.

## Deploying

```bash
npm run deploy
npx wrangler deploy -c workers/expire-holds/wrangler.jsonc
```

The site has no `routes` in `wrangler.jsonc`, so it deploys to
`assubki-books.<subdomain>.workers.dev`. The live domain still points at
WordPress and is untouched. See the cutover plan before changing that — the
domain carries the owner's IONOS email, and moving nameservers without
recreating the MX records first will silently kill their mail.
