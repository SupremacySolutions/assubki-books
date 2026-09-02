# Knowing what people want, and telling them when it arrives

## Context

The shop works. What it cannot do is *see*. There is no analytics tag of any
kind, so nobody knows what customers search for, which shelves they open, or
where they give up. When a customer searches for something the shop does not
stock, that search vanishes — and the owner's own list of 98 wanted titles found
36 missing, which is the same experiment customers are running every day
unobserved.

Two of the four items below are about seeing (analytics, and the searches that
find nothing). One is about being heard (email that authenticates properly). One
is about keeping a promise the site already makes out loud: the book page says
*"Ask us and we will tell you when it is back"*, and today that is kept only by
the owner remembering.

**Ordering.** Item 3 is a single DNS edit with no code and should be done first
because every other email depends on it. Then analytics, because it starts
collecting the moment it ships and everything after is better with a fortnight
of data behind it. Then the search log, then the alerts — those two share a
portal screen and are worth building in that order.

---

## 3. Email that authenticates — one DNS edit, no code

**The finding, which is not what I expected.** The domain is half-migrated:

| | `assubkibooks.co.uk` (apex) | `send.assubkibooks.co.uk` |
|---|---|---|
| Resend DKIM | **present** | missing |
| SPF for Resend | **missing** (authorises IONOS only) | present |
| Feedback MX | — | present |

Mail goes out as `orders@assubkibooks.co.uk`, so it is signed correctly by DKIM
but fails SPF on every single send. Meanwhile a correctly-built `send.`
subdomain sits unused, and cannot be used as it stands because it has no DKIM.

Current apex record: `v=spf1 include:_spf-eu.ionos.com ~all`

**The fix — edit that record to:**

```
v=spf1 include:_spf-eu.ionos.com include:amazonses.com ~all
```

**Edit it. Do not add a second TXT record.** Two `v=spf1` records on one name is
a permanent error and every receiver treats SPF as broken — strictly worse than
today, where it merely fails. The IONOS include must stay: it is what authorises
the owner's own mailbox.

Two lookups is well inside SPF's limit of ten.

**Why not move to the `send.` subdomain instead**, which is Resend's own
recommendation: it would need its DKIM record adding, and it changes the visible
From address to `orders@send.assubkibooks.co.uk`. The apex already has DKIM and
reads better to a customer. Merging the include is one edit against two.

**Afterwards**, either finish the `send.` subdomain or delete its records — a
half-built sending identity is a thing to trip over later.

**Verify:** `dig +short TXT assubkibooks.co.uk` shows one record with both
includes; then send one real message and confirm `spf=pass` and `dkim=pass` in
the received headers (Gmail's *Show original*, or mail-tester.com).

**Then, in a fortnight**, consider moving DMARC from `p=none` to `p=quarantine`.
Not before: `p=none` is what makes the next two weeks of reports safe to read.

Sources: [Resend — Cloudflare DNS](https://resend.com/docs/knowledge-base/cloudflare),
[Resend — what if my domain is not verifying](https://resend.com/docs/knowledge-base/what-if-my-domain-is-not-verifying)

---

## 1. Analytics

**Cloudflare Web Analytics.** Free, no cookies, no fingerprinting, and therefore
**no consent banner** — which matters because the privacy policy is being
written right now and a cookie banner would change what it has to say.

### The one real obstacle

The site's CSP is deliberately tight and admits exactly one third party today.
The beacon needs two additions in `src/middleware.ts`:

```
script-src  … https://static.cloudflareinsights.com
connect-src … https://cloudflareinsights.com
```

This is the second third party ever admitted, and it should be documented the
way the first one was — `api.postcodes.io` carries a comment explaining what
goes out and why it does not change the site's position on cookies. Write the
same for this, honestly: what leaves is a page URL, a referrer and a timing, no
identifier and nothing that names anybody.

### Where it goes

`src/layouts/Base.astro` **only** — never `Admin.astro`. The owner working in
the portal all day would otherwise be the shop's busiest visitor and every
number would be wrong. The token comes from the Cloudflare dashboard
(Web Analytics → add a site) and belongs in `wrangler.jsonc` `vars`, not in the
markup, so it can differ between environments.

### Considered and rejected

Counting page views server-side into D1. It needs no third party and no CSP
change, but it is a write on the hottest path in the shop, it reinvents
sessionisation badly, and the read budget is the constraint this project keeps
running into. Not worth it for numbers Cloudflare gives away.

**Verify:** the beacon loads with no CSP violation in the console (this is
exactly the class of thing that has shipped broken here before — locally the
only un-nonced script is the dev toolbar, so a CSP mistake looks clean until it
is deployed); a visit appears in the dashboard within a minute; `/admin` traffic
does not.

---

## 2. The searches that find nothing

### The table

```sql
-- migrations/00NN_searches.sql
CREATE TABLE searches (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  terms TEXT NOT NULL,       -- normalised: trimmed, lower-cased, spaces collapsed
  at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_searches_at ON searches(at);
```

Only searches that **found nothing** are recorded. Every search would be a write
on the catalogue's hottest path for a signal the owner cannot act on; a search
that failed is the whole of what is actionable, and it is rare.

Normalising on the way in is what makes the panel readable — otherwise
`Nur al Idah`, `nur al-idah` and `  Nur Al Idah ` are three separate rows saying
one thing.

### Where it is written

In `src/pages/catalogue/[...path].astro`, when `result.total === 0`, guarded by:

- `page === 1` — a pager walking an empty result must not log five times;
- terms between 2 and 80 characters;
- fired through `ctx.waitUntil`, never awaited, so a slow write cannot delay the
  page. `notifyOrderPlaced` already uses that pattern in `api/orders.ts`.

Worth accepting up front: **some of this will be robots.** A scraper walking
query strings will appear in the list. That is tolerable for a signal the owner
reads with their own judgement, and it is not worth building bot detection for.
If it becomes noisy, the same IP throttle as `src/lib/login-throttle.ts` is the
tool — counted in D1 for the same reason, because Workers isolates are plural.

### Where it is read

A **"Looked for, not found"** panel on the portal dashboard, top 15 over 30
days with a count each. `src/lib/dashboard.ts:56` already fetches everything in
one `env.DB.batch([...])` — this query joins that batch, so the panel costs no
extra round trip and inherits the existing 60-second cache.

### Two things not to forget

- **Prune.** Delete rows older than 90 days in the cron Worker
  (`workers/expire-holds/`), beside the hold sweep. A log nobody trims is a
  liability, not an asset.
- **Say so in the privacy policy.** A search box is free text and people
  occasionally type things into it that identify them. The policy being written
  this week should say searches are recorded, why, and for how long — that is a
  one-line change while the document is open, and an awkward retrofit later.

---

## 5. Tell me when it is back

The book page already promises this. `src/pages/book/[slug].astro:378`:

> This title is out of stock. **Ask us** and we will tell you when it is back.

Today that opens a Telegram or email dialog and relies on the owner remembering.
This makes the promise real, and produces demand data as a side effect — the
same signal as item 2, from people who wanted a book the shop *does* list.

### The table

```sql
CREATE TABLE stock_alerts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id    INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (book_id, email)
);
CREATE INDEX idx_alerts_book ON stock_alerts(book_id);
```

`UNIQUE (book_id, email)` so asking twice is asking once.

### How it behaves

- A plain form on the book page, in the branch quoted above — **it must work
  with JavaScript off**, like every other customer action here, and it must not
  be nested inside another form. That has broken this codebase twice.
- **No double opt-in.** It halves the number of people who complete it, and it
  would mean a second kind of token to build and guard. This is a single
  low-stakes message, not a subscription.
- **The row is deleted the moment the email is sent.** The address is held only
  until it has been used, which is the honest answer to "how long do you keep
  this" and matches the thinking behind the screenshot retention. There is
  nothing to unsubscribe from because nothing persists.
- Rate-limited per address, so the form cannot be used to post mail at somebody.

### What fires it

Availability rising above zero. Two places do that today —
`setStock` in `src/lib/admin-db.ts` and `src/pages/api/admin/books/[id]/arrived.ts`
— so the notify step belongs in **one shared helper** that both call, exactly as
`src/lib/stock-release.ts` was extracted when four copies of the release logic
had drifted apart. Wording goes in `src/lib/order-status.ts` with everything
else the shop says.

### The caveat that decides when this is worth building

**No book in the shop is currently out of stock.** All 225 are set to 10, so
this feature would ship invisible and stay invisible until real stock numbers
exist. It is genuinely useful — but it is worth doing *after* a stocktake, or it
is a feature built for a state the shop cannot currently reach.

---

## Verification, across all four

- `npm run test:e2e` — 526 must stay green. New assertions: a zero-result search
  writes exactly one row and a successful one writes none; the pager does not
  log twice; an alert row is created, fires once when stock rises, and is gone
  afterwards; the dashboard panel counts what the table holds.
- **In a browser**, with **JavaScript disabled**, for the alert form — the
  house rule for every customer action.
- **No CSP violations in the console on production**, checked after deploy, not
  before.
- `npx wrangler d1 insights assubki-books --sort-by reads` afterwards. Both new
  tables are small, but the search write sits on the catalogue path and the
  dashboard panel on the portal's, and this project has lost its read budget to
  a front-page query once already.

## Watch out for

- **Two SPF records is worse than one wrong one.** Edit, never add.
- **The build does not typecheck** — an undefined name ships and throws.
- **Forms cannot nest**, and the alert form goes on a page that already has one.
- **`is:inline` + `define:vars` ships verbatim** — plain JS only.
- **Astro's `checkOrigin`** refuses cross-site form posts; the alert form is
  same-origin so it needs no token, for the same reason `api/orders/cancel.ts`
  has none.
