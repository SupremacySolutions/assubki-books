# As-Subkī Books — how the codebase works

An Islamic bookshop in Leicester. Around 225 titles, mostly classical Arabic
texts and madrasah syllabus sets, sold to students who usually arrive knowing
the exact book they want.

The single most important thing to understand: **no money moves through this
site.** An order is a *request to buy*. The customer sends it, the shop replies
with a total and payment details over email or Telegram, and payment is
arranged directly. Nothing here takes a card. Almost every design decision
downstream follows from that.

---

## The stack

| | |
|---|---|
| Framework | Astro 7, server-rendered (`output: 'server'`) |
| Runtime | Cloudflare Workers, via `@astrojs/cloudflare` |
| Database | Cloudflare D1 (SQLite) |
| Images | Cloudflare R2, served through a Worker route |
| Styling | Tailwind v4, one `@theme` block in `src/styles/global.css` |
| Fonts | Self-hosted via `@fontsource` — Spectral, IBM Plex Sans, Noto Naskh Arabic |
| Email | Resend |
| Messaging | A Telegram bot, for both customers and the owner |

A **second Worker** (`workers/expire-holds/`) exists only to run a cron trigger:
the Astro adapter owns the main Worker's entrypoint and gives no way to add a
`scheduled` handler to it.

**Roughly**: 24 pages, 32 API routes, 26 library modules, 11 components,
20 migrations, and one end-to-end suite of 437 assertions.

---

## The shape of it

```
src/
  pages/            routes — .astro renders, .ts is an API endpoint
    index catalogue book basket checkout order   (customer)
    admin/…                                       (portal, guarded)
    api/…                                         (JSON and form endpoints)
    img/[...key].ts                               (R2, resized on the fly)
  lib/              everything with a rule in it
  components/       shared markup
  scripts/          client-side TypeScript, bundled by Astro
  layouts/          Base.astro (shop) and Admin.astro (portal)
  middleware.ts     the single guard point
migrations/         hand-applied, NNNN_snake_case.sql
scripts/e2e.mjs     the test suite
workers/            the cron Worker
```

**`src/lib` is where the rules live.** If a decision could be made two
different ways in two different places, it belongs in `lib` so it cannot be.
`order-status.ts` is the clearest example: the customer page, the emails, the
Telegram messages and the portal all read their wording from it, because they
once drifted and a collection order was described as "posted" in three places
out of four.

---

## The data model

Fourteen tables. The ones that matter:

**`books`** — a listing. `stock` is what is physically held; `reserved` is what
open orders have spoken for. **Availability is always `stock - reserved`**, and
`CHECK (reserved <= stock)` is what makes two people racing for the last copy
safe. Not the read before it — the constraint. The read exists to produce a
readable error message.

**`stock_ledger`** — every movement, with a reason. `field` is `'stock'` or
`'reserved'`, `delta` is signed. The invariant the suite asserts is that
`books.reserved` equals `SUM(delta) WHERE field='reserved'` for every book. Any
code that moves one without the other is a bug, which is why releasing a hold
goes through one shared helper (`lib/stock-release.ts`) rather than the four
hand-written copies it used to be.

**`orders`** / **`order_items`** — an order and its lines. `access_token` is a
16-byte random hex string; it is the customer's entire authority over their own
order, compared in constant time. There is no customer login anywhere.

**`categories`** — shelves, nested by a `path` string (`hadith/hadith-works`).
Each has a three-letter **classmark** derived from the discipline's Arabic name
(NHW for naḥw, TSW for taṣawwuf), because that is how a madrasah student
actually navigates.

**`book_sets`** / **`book_set_stock`** — a set sellable whole *or* in named
parts. Each part is an ordinary `books` row sharing one **per-volume** pool.
Per-volume rather than a single "sets in stock" because after selling volumes
1–2 out of three sets you hold two complete sets *and* three of volumes 3–4,
and no single number says both.

**`settings`** — key/value. Payment message drafts, the collection address, the
maintenance flag, the owner's Telegram chat id, the admin session epoch, and
health markers like `last_email_error`.

---

## Three kinds of stock

This is the part most likely to trip someone up.

| | what it means | where it lives |
|---|---|---|
| **On the shelf** | a copy you can have today | `stock - reserved` |
| **Set pool** | volumes shared between a set and its parts | `book_set_stock.have`, minus what siblings hold |
| **Coming** | a delivery not yet arrived | `incoming - reserved_incoming` |

They are **never added together.** A card that summed them would be telling a
customer they can have two, one of which is imaginary.

A claim on a delivery cannot use `reserved`, because that column counts copies
held out of `stock` and there is nothing on the shelf to hold. The equivalent
guard needed a trigger (`books_incoming_not_oversold`) since SQLite cannot add
a cross-column CHECK to an existing table without rebuilding it.

**A reservation never expires.** The 48-hour sweep releases anything still
`requested` *with an expiry*; a reservation is given none, because the customer
cannot be asked to complete an order for books that do not exist yet.

---

## The order lifecycle

```
requested ─→ awaiting_payment ─→ paid ─→ dispatched ─→ completed
    │               │              │          │
    └─── cancelled / expired ──────┴──────────┘
```

- **`requested`** — copies held for 48 hours. Two things sweep them: an inline
  call at the top of `createOrder`, and the cron Worker. Both, deliberately —
  whether a customer can buy the last copy must not depend on when a scheduled
  job last fired.
- **`awaiting_payment`** — the owner has quoted a total and sent payment
  details. This is the line that governs cancellation.
- **`paid`** — the hold becomes a sale: `reserved` down, `stock` down, both
  ledgered.
- Cash orders are their own path throughout, because nothing is owed until the
  books change hands.

**Customer cancellation** turns on that middle line. Before payment details go
out the customer cancels outright and the copies return immediately. After, it
becomes a request the owner answers; the order does not move until they do. The
customer's stated reason and the owner's note are separate columns and are
never shown as one voice.

---

## Notifications

`lib/notify.ts` fans out to email and Telegram together, via
`Promise.allSettled` — one channel failing must not take the other down. The
wording comes from `lib/order-status.ts` so the page, the email, the Telegram
message and the portal cannot disagree.

Telegram is opt-in through a deep link carrying the order reference and a token
prefix. A customer who has connected once stays reachable for later orders,
carried forward by email address.

**Failures are recorded, not swallowed.** `last_email_error` and
`last_notify_error` are written to `settings` and surfaced on the dashboard,
because a message that never left is invisible otherwise — and once was, for two
days.

---

## The portal

Everything under `/admin` is guarded in `src/middleware.ts`, which is also
where the canonical-host redirect, maintenance mode, the CSP nonce and the
security headers live. One guard point, so there is one place to check.

Sign-in is a shared password with a D1-backed throttle (5 failures per address
per 15 minutes) and an HMAC-signed cookie whose key mixes in a session epoch,
so "sign out everywhere" is one click. The code is written to expect Cloudflare
Access in front of it eventually; the password is the interim.

Pages: **Dashboard** (analytics, cached 60s, one batched query),
**Orders** (the worklist), **Listings**, **Shelves**, **Settings**.

---

## The D1 read budget

The free plan allows **5,000,000 rows read a day**. This has been the recurring
constraint of the project, and one query once ate 95% of it — a category count
that joined `categories` against itself with `OR … LIKE`, costing 34,687 rows
every time anyone loaded any page with a shelf list.

Standing rules:

1. **Measure, do not assume.** `npx wrangler d1 insights assubki-books
   --sort-by reads` names the offenders. `npx wrangler d1 info assubki-books`
   gives the daily totals.
2. **Roll up in JavaScript** rather than joining a table to itself. Both the
   category counts and the shelf list were rewritten this way, from ~34,000 and
   ~23,000 rows to ~1,300 and two flat reads.
3. **Cache anything a page hits on every load** — 60 seconds is the house
   default (`categoryCounts`, `dashboard`, `backInStock`).
4. **Watch out for expression indexes.** `WHERE LOWER(x) = ?` cannot use an
   index on `x`; it needs one on `LOWER(x)`.

Current usage is around **1.1M rows a day, about 22%**, and a fair share of that
is the test suite rather than customers.

---

## Testing

One suite: `npm run test:e2e`, against a local `astro dev`. 437 assertions
across sixteen groups. `npm run test:e2e:prod` runs against the live site and
genuinely sends email and posts to Telegram, because a mock returns success and
proves nothing — the failures that actually happened here were a reserved
character breaking a Telegram message and an unverified domain rejecting every
send.

Fixtures are tracked and removed afterwards, including when a suite throws. If
a run is killed part-way its teardown does not happen, and the leftovers will
fail the ledger and pagination checks on the *next* run — that is the rubbish,
not the code.

**What the suite cannot see**, learned the hard way:

- **It posts to APIs, not through forms.** The set builder was nested inside
  another form for its entire existence — browsers discard a nested `<form>`
  and its button submits the outer one — and every test passed throughout.
  Anything form-shaped needs checking in a real browser.
- **The build does not typecheck.** Astro compiles with esbuild. A reference to
  an undefined variable ships happily and throws at runtime.
- **Production differs.** Astro inlines small script bundles, which cannot
  carry a CSP nonce; locally the only un-nonced script was the dev toolbar, so
  a broken CSP looked clean until it was deployed.

---

## Deploying

```bash
npm run deploy                                          # the site
npx wrangler deploy -c workers/expire-holds/wrangler.jsonc   # the cron Worker
npx wrangler d1 execute assubki-books --remote --file migrations/NNNN_*.sql
```

Migrations are **hand-applied and not tracked by a runner** — apply locally
first, then remote. Images are cached immutably, so a changed file at the same
key never propagates; `IMAGE_VERSION` in the URL is what busts it.

---

## Conventions

- **Comments explain why, never what.** If a line needs saying twice it is
  written once and named well instead.
- **Copy is part of the code.** The wording a customer reads is chosen as
  carefully as the query behind it, and lives in `lib` where it cannot drift.
- **Refuse rather than guess.** A half-filled row in the set builder is
  rejected, not inferred; an unknown category path is a 404, not an empty grid.
- **Say the true thing.** If a delivery might slip, the shop says "mid-October"
  rather than a date it could miss.

---

## Things that will bite

- **`is:inline` + `define:vars` ships verbatim** — no TypeScript syntax in
  those blocks.
- **Forms cannot nest.** This has broken two things already.
- **Two fields can share a name** across different forms on the listing editor
  (`volumes`); `querySelector` picks the first.
- **`RETURNING` is a reserved word**; `AS returning` silently breaks a query.
- **The set pool is not the listing's `stock`.** For a set member, `books.stock`
  is a vestigial number nobody reads for availability. Writing it is both
  ineffective and dangerous.
- **`setOptions` is the shop's view** and filters to live listings. The portal
  wants `setOptionsForOwner`, which does not.
