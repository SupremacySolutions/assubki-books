# Bringing production's schema back in step

**F19 from [the audit](../audit-2026-09-07/REPORT.md), which is the one thing there
that cannot be fixed by a commit.** Everything else the audit found is now in the
code. This is a deployment, and it needs the owner's credentials and the owner's
decision, so what follows is the procedure and the rehearsal, not the act.

The gap was computed from the schema the audit captured read-only on
7 September 2026, and the procedure was rehearsed end to end against a local
replica built from it.

**`0035`–`0039` have since been applied to production**, in the deploy of
7 September 14:03 UTC. What is written below as a six-migration reconciliation
is now a one-migration one. The history is kept because the argument for every
step of it is unchanged, and because `d1_migrations` is still empty, which is
the part that outlives any particular migration.

---

## What is wrong

Production is running the schema that migrations `0001`–`0039` produce.
`0040` has been written since and has not been applied:

| | | |
|---|---|---|
| `0035_split_checkout` | `orders.split_group`, its partial index | **applied** |
| `0036_reservation_integrity` | `delivery_version` on `books` and `shipments`; `deliveries`, `delivery_items`, `delivery_allocations`; rebuilds `shipment_notices` | **applied** |
| `0037_group_member_token` | `group_basket_items.member_token` | **applied** |
| `0038_read_cost` | narrows the FTS trigger, `idx_messages_cursor`, `idx_public_actions_at` | **applied** |
| `0039_read_cursor` | `orders.read_cursor_customer`, `orders.read_cursor_owner` | **applied** |
| `0040_stock_alert_outbox` | delivery state on `stock_alerts`, `idx_alerts_due` | pending |

Concretely, production is missing one object and one definition differs -
`check-schema.mjs --remote`, run against production on 7 September:

```
MISSING          idx_alerts_due

DIFFERS          stock_alerts       + claimed_at, attempts, last_error,
                                      next_attempt_at, lease_until, lease_token
```

**The code on `main` requires it.** Every column above is read by
`src/lib/stock-alerts.ts`, so a Worker carrying the outbox in front of a
`stock_alerts` that has none of it fails on the first back-in-stock claim.

The nine missing objects and eight differences the audit found are recorded in
the git history of this file. What made them dangerous - new code in front of an
old schema - is what makes the remaining one worth doing in the same order.

### Why `wrangler d1 migrations apply` must not be used here

`d1_migrations` exists in production and is **empty**. Wrangler reads that table
to decide what still needs running, so an empty ledger means it would try to
replay `0001` onwards — starting by creating tables that already hold the shop's
229 books and its orders. The first `CREATE TABLE` would fail, and a partial run
against a live database is a far worse position than the one we are in.

The ledger has to be told the truth *after* the missing migrations are applied by
hand. Step 5 does that, and is what makes every future migration ordinary.

---

## The rehearsal, which has been done

Reproducible from a clean checkout. It builds a database with production's exact
shape, reconciles it, and checks the result — touching nothing remote.

```sh
# 1. A replica of production: migrations 0001-0034 only.
mkdir -p /tmp/asb-rehearsal
for f in migrations/00{0,1,2,3}*.sql; do
  case "$(basename "$f")" in 003[5-9]*|004*) continue;; esac
  npx wrangler d1 execute assubki-books --local \
      --persist-to /tmp/asb-rehearsal --file="$f"
done

# 2. The gap, as production would report it.
ASB_PERSIST_TO=/tmp/asb-rehearsal node docs/schema-reconciliation/check-schema.mjs

# 3. Reconcile.
for m in 0035 0036 0037 0038 0039 0040; do
  npx wrangler d1 execute assubki-books --local \
      --persist-to /tmp/asb-rehearsal --file=migrations/${m}_*.sql
done

# 4. And again: expected to print "In step with migrations/."
ASB_PERSIST_TO=/tmp/asb-rehearsal node docs/schema-reconciliation/check-schema.mjs
```

Result: step 2 reports the nine missing objects and eight differences above;
step 4 reports **74 objects live, 74 expected — in step with migrations/**, with
nothing missing, nothing extra and no definition differing. The six migrations
apply cleanly and in order to production's shape, and land exactly on what the
migration set describes.

Step 5's ledger seeding was rehearsed on the same replica: it inserts forty rows,
and running it a second time still leaves forty.

That is what the rehearsal proves. It does not prove anything about production's
*data*, which the replica does not have — which is what steps 2 and 6 below are
for. Nor does it prove Cloudflare will behave as SQLite does: D1 is SQLite, but
the rehearsal runs against a local file, and `0036` is the one statement where
that distinction could matter.

---

## The procedure

Run it in one sitting, with nobody using the portal. Every command is quoted in
full so it can be read before it is run.

### 1. Take a restore point, and write it down

D1 keeps a thirty-day history, and a bookmark taken now is the rollback.

```sh
npx wrangler d1 time-travel info assubki-books
```

Record the bookmark it prints. **Also take a real file, because a bookmark is
Cloudflare's to keep and a file is yours:**

```sh
npx wrangler d1 export assubki-books --remote \
    --output "backup-$(date +%Y%m%d-%H%M).sql"
```

Check the file is not empty and contains `CREATE TABLE books` before going on.

### 2. Record the invariants as they stand

```sh
node docs/audit-2026-09-07/read-live.mjs
```

That runner is restricted to `SELECT`/`EXPLAIN`/`PRAGMA` and writes nothing.
Keep its output. Step 6 compares against it, and a difference in the *counts*
either side of a schema change is the thing you most want to notice.

### 3. Confirm the gap is still the one described above

```sh
node docs/schema-reconciliation/check-schema.mjs --remote
```

If it prints anything not listed in **What is wrong**, stop. Something has
changed since the audit and this procedure no longer describes the database in
front of you.

### 4. Apply what step 3 says is missing, in order, one at a time

Today that is one file:

```sh
npx wrangler d1 execute assubki-books --remote --file=migrations/0040_stock_alert_outbox.sql
```

Separately, and reading each result, rather than in a loop. If a command reports
an error, **stop and go to Rollback** — do not run the next one.

`0040` is six `ADD COLUMN`s and one partial index: additive, so the Worker that
is already deployed keeps working against it untouched. A migration that
*rebuilds* a table is the one to watch — `0036` was that, and it also carried
data fixes for orders told too early.

### 5. Tell the ledger the truth

Every migration is now applied, so all forty names belong in `d1_migrations`.
Until they are there, wrangler still believes none has run.

Generate the statement from the directory rather than typing it. Forty names
copied by hand is forty chances to record a migration under a name that does not
exist, and a name that does not match leaves that migration looking unapplied for
ever.

```sh
node -e "const{readdirSync}=require('node:fs');\
const n=readdirSync('migrations').filter(f=>f.endsWith('.sql')).sort();\
console.log('INSERT OR IGNORE INTO d1_migrations (name) VALUES '+\
n.map(x=>\`('\${x}')\`).join(',')+';')" > /tmp/seed-ledger.sql

cat /tmp/seed-ledger.sql          # read it before you run it
npx wrangler d1 execute assubki-books --remote --file=/tmp/seed-ledger.sql
```

`INSERT OR IGNORE`, so it is safe to run twice, and safe to run again after the
next migration is added.

Check it took:

```sh
npx wrangler d1 execute assubki-books --remote \
    --command "SELECT COUNT(*) AS applied FROM d1_migrations"
```

Expect 40 — the number of files in `migrations/`.

### 6. Check the database is still the shop's database

```sh
node docs/schema-reconciliation/check-schema.mjs --remote   # expect: in step
node docs/audit-2026-09-07/read-live.mjs                    # compare with step 2
```

Every count from step 2 should be unchanged — books, orders, order items,
messages — and every mismatch check should still be zero:
`stock_mismatches`, `incoming_mismatches`, `oversubscribed_volumes`,
`wrong_subtotals`, `total_mismatches`, `outstanding_paid_claims`,
`premature_deadlines`, and `PRAGMA foreign_key_check` returning no rows.

`pending_notices` may legitimately change: `0036` deliberately re-queues notices
for mixed orders that were told after only part of their books arrived. That one
is expected. Nothing else is.

### 7. Only now, deploy

```sh
npm run deploy          # the site
npm run deploy:sweep    # the quarter-hourly worker
```

**Schema first, code second, and not the other way round.** Every change here is
additive apart from the `shipment_notices` rebuild, so the currently deployed
Worker keeps working against the new schema for the minutes between the two —
whereas new code against the old schema fails on the first request that touches
`split_group`. Deploy the sweeper too: `0040` adds an outbox that the sweep is the
only thing that drains.

### 8. Afterwards

```sh
node docs/audit-2026-09-07/live-smoke.mjs
```

Eight read-only public URL checks. `/shipments` answering 200 was the clearest
sign of this the first time round, when it had been answering 404; it should
stay 200.

Then watch the Worker's logs and D1 metrics for an hour or so. The sweep runs
quarter-hourly, so the first drain of the two new outboxes happens within
fifteen minutes of the deploy.

---

## Rollback

**If a migration in step 4 fails**, do not try to repair it by hand and do not
run the remaining ones. Restore to the bookmark from step 1:

```sh
npx wrangler d1 time-travel restore assubki-books --bookmark=<from step 1>
```

Then run `check-schema.mjs --remote` and expect it to report the original gap
again — that is what confirms the restore landed. Nothing needs redeploying,
because step 7 has not happened yet.

**If a problem appears after step 7**, the database is not usually the thing to
undo: the schema is additive and the old code tolerates it. Roll the *code* back
first, in the Cloudflare dashboard or with `wrangler rollback`, and only restore
the database if an invariant in step 6 is genuinely broken — restoring throws
away every order and message taken since the bookmark.

---

## `check-schema.mjs`

```sh
node docs/schema-reconciliation/check-schema.mjs            # local D1
node docs/schema-reconciliation/check-schema.mjs --remote   # production
ASB_PERSIST_TO=/tmp/asb-rehearsal node ...check-schema.mjs  # a rehearsal copy
```

Builds the schema the migrations produce in a temporary SQLite file, reads the
database's own `sqlite_master`, and names the difference. Read-only: the only
statement it sends is a `SELECT`, and the temporary file is deleted on the way
out. Exit code 0 when they agree, 1 when they do not, so it can gate a deploy.

It ignores `_cf_KV`, `d1_migrations`, the `books_fts_*` shadow tables and
`sqlite_sequence` — platform objects that no migration describes — and strips SQL
comments before comparing, because wrangler discards them and `sqlite3` does not,
and every commented table in the repository would otherwise read as a difference.

Needs `sqlite3` on the path, and for `--remote`, a logged-in wrangler. It asks
for `trusted_schema=ON` when replaying the migrations, because the `sqlite3`
macOS ships will not otherwise let a trigger name a virtual table — the FTS
triggers are rejected, the seed's books never land, and the reference the check
compares against is not the schema at all. D1 has no such restriction.
