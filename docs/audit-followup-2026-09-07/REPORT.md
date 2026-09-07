# Audit fix review — 7 September 2026

> **Updated:** [Second-pass verification of bc74ac2](SECOND-PASS.md) supersedes the status of the five subsequent fixes below.

Reviewed **`d691611decff5194692442d940ab60753c58df2e`**, covering the five fix commits after the original audit at `cde261f`.

**Most fixes are substantive, and the production schema gap has been addressed. Further work is still needed. The most immediate regression is that adding a book to a group from its product page omits the new member credential. The production JavaScript contains this omission; the current API rejects that request.** There are also remaining restock and redirect vulnerabilities, broken organiser editing, and incomplete notification/read-state handling.

This was a review, not another fix pass. Application source and production data were not changed. The uncommitted test-memory wrapper, `package.json` edits and memory guide from the earlier conversation were preserved.

## What is in production

Read-only Cloudflare inspection found:

| Item | Observed state |
|---|---|
| Website | Version `fcdf927b-d6db-4b89-b825-72c73a3b3752`, 100% traffic, deployed **7 September 14:03:59 UTC** |
| Scheduled worker | Version `d7070192-02bc-4053-825e-af8aef57f289`, 100% traffic, deployed **7 September 14:04:26 UTC** |
| Split checkout / receipt schema | `orders.split_group` and the delivery tables are now present |
| Group ownership migration 0037 | `group_basket_items.member_token` is present |
| Read-cost migration 0038 | Narrowed FTS update trigger, `idx_messages_cursor` and `idx_public_actions_at` are present |
| Migration history | **Still empty: zero records in `d1_migrations`** |
| Public smoke | Homepage, catalogue, search, shipments, basket and admin login all returned 200 |
| Group frontend | Production basket bundle contains member-token support; production book-page request still omits it |
| Aggregate integrity | Foreign-key check clean; zero oversubscribed set volumes at sampling |
| Data volume | 229 books, 3 orders, no shipments, deliveries, groups or stock alerts |

The previous `/shipments` 404 is resolved. No production mutation tests, login attempts, customer messages or notifications were sent. All recorded D1 checks report zero rows written and `changed_db=false`.

Deployment metadata does not name a Git SHA, so I cannot certify a byte-for-byte match between deployed server code and this commit. The live schema and public bundles confirm the changes described above. In particular, the product-page omission is visible in the deployed bundle; the API rejection was reproduced against the current source in isolation.

Evidence: [website deployment](evidence/site-deployment.json), [worker deployment](evidence/sweeper-deployment.json), [schema](evidence/live-schema.json), [aggregates](evidence/live-invariants.json), [public smoke](evidence/live-smoke.json), [production product script excerpt](evidence/live-product.json).

## Remaining work, in priority order

### R07 — High: product-page additions to a group are broken

**Location:** `src/pages/book/[slug].astro:588–591`; `src/pages/api/group/line.ts:19`.

The route now requires `memberToken`, but `addToGroup()` still sends only `code`, `token`, `name`, `bookId` and `qty`. The real handler returns 400 and adds no line. The product page then displays “That group basket is no longer taking books”, which misdiagnoses a valid group.

The deployed product script has this exact request shape. The updated E2E group tests explicitly supply the credential themselves, so passing those API tests does not validate the product-page caller.

**Needed:** send the persisted membership credential from every caller, surface the server's actual error, and add a browser-flow regression: join group → open book → add → confirm the group contains the line. Cover both organiser and member. Refresh compatibility for tabs opened before deployment should also be considered.

### R01 — High: restock can still fall below concurrent claims

**Location:** `src/pages/api/admin/books/[id]/set.ts:96,123–125`.

The ordinary pre-existing-hold case is fixed, but the pooled minimum is read before the write transaction. The per-listing `reserved <= stock` constraint does **not** protect the sum of overlapping sibling listings.

Reproduction: create a full set and an overlapping part with pool 2. Let the restock check see no holds, then simulate one reservation on each listing before its batch runs. Restock to 1 succeeds: each listing has `reserved=1, stock=1`, while volume 1 has two claims against one physical copy. The existing reservation trigger guards increases to `reserved`, not decreases to the pool.

**Needed:** enforce the aggregate per-volume condition atomically with the pool update, ideally with a database invariant covering every pool writer. Test the interleaving with full-set and overlapping-part checkouts, not only one listing. No live mismatch was present in the sampled data.

### R02 — Medium: organiser controls edit the wrong person's line

**Location:** `src/pages/basket.astro:365–378,396–403,428–430`.

All member lines are now editable for the organiser, but controls identify only `bookId`, and `setGroupQty()` always submits `name: member.name`.

Changing Alice's quantity to two creates/changes the organiser's line instead of Alice's. Setting Alice's quantity to zero deletes the organiser's matching line or does nothing. The API correctly permits an organiser to edit Alice when Alice's name is supplied; the UI never supplies it. The shared `mine` flag also labels other people's lines “(you)” and produces duplicate input IDs when several people order the same book.

**Needed:** carry the selected line identity through the input/event/request, separate “editable” from “belongs to me”, and use unique control IDs. Test two people ordering the same title through the actual organiser UI.

### R06 / F17 — Low security severity: open redirect remains through another payload

**Location:** `src/pages/api/admin/login.ts:27–28`.

The original backslash payload is addressed. However, `next=https://example.invalid//evil.invalid` passes an origin check against `https://example.invalid`. The code then strips the origin and returns **`Location: //evil.invalid`**, which the browser resolves externally. The real login handler reproduced this using a fake local password/session configuration.

**Needed:** emit the validated absolute same-origin URL, or revalidate the emitted relative destination and reject network-path references. Include same-origin absolute URLs with double-slash paths and dot-segment variants in regression coverage. No credentials are automatically leaked by this finding; it is a post-login redirect/phishing weakness.

### R03 — Medium: upgrading an existing group membership does not persist its new key

**Location:** `src/scripts/group.ts:38–54`; `src/pages/basket.astro:312–320`.

`readGroup()` generates a member credential for old localStorage data but never saves it. Two reads of the same legacy membership return different credentials. `fetchGroup()` saves membership only when role/share-token metadata changes, which need not happen for an ordinary member.

Once a legacy membership creates a token-owned line, a later reload can lose the credential needed to edit it. Fixing R07 makes persistence particularly important for customers already holding group state from before this deployment.

**Needed:** persist the upgrade once, then reuse that credential on every page and reload. Test old storage → add a line → reload → change the same line. The inability to edit pre-migration tokenless lines is an explicitly documented design choice; repeatedly losing newly created ownership is not.

### R05 / F02 — Medium: stock alerts still need durable retry handling

**Location:** `src/lib/notify.ts:992,1044`; `src/lib/stock-alerts.ts:83,115`.

A provider 429 now restores subscribers and returns zero sent: that part is fixed. But subscriptions are still deleted before sending. If the restore write fails, or execution stops between claim and restore, the subscriber is lost. The targeted test reproduces a provider rejection followed by a failed restoration and finds zero subscriber rows.

Restoration alone is also not scheduled delivery retry: another relevant notification trigger is needed. The scheduled worker prunes old alerts; it does not drain a retryable stock-alert outbox.

**Needed:** durable pending/leased/sent state, bounded scheduled retries/backoff, failure visibility, and idempotency. Keep subscribers durable until acknowledgement. Test interruption and restoration failure as well as a normal 429 response.

### R04 / F06 — Low: out-of-order acknowledgements can resurrect unread badges

**Location:** `src/lib/messages.ts:199–214`.

The original arrival-between-fetch-and-acknowledgement defect is fixed. A different interleaving remains: acknowledge through message B, then let an older request acknowledge through A. The second recount sets the badge back to one even though B was already read. This can occur with overlapping polls or multiple tabs.

**Needed:** store a monotonic read cursor per side and acknowledge through `MAX(existing_cursor, returned_cursor)`. Recalculate counters from that cursor. Test reversed completion order and multiple tabs.

### F16 — Low: malformed form requests still produce internal errors

The common body-parsing fix was not implemented. The current order lookup handler still throws on a malformed JSON body passed to `request.formData()`. Its error boundary has not changed since the original 29-handler HTTP sweep.

**Needed:** shared content-type/body parsing with 400/415 responses and tests covering all affected form routes. This follow-up rechecked the representative handler; it did not repeat all 62 HTTP boundary probes, so the original count of 29 is historical, not a newly measured total.

### F20 — Medium hardening: order recovery remains unthrottled

`src/pages/api/orders/lookup.ts` is unchanged. Matching reference and email still immediately return the order bearer token, without route-level throttling.

**Needed:** atomic abuse limits and preferably email-delivered recovery links, retaining generic responses. No unauthorised production recovery was attempted or demonstrated.

### F19 — Operational follow-up: migration tracking remains untrustworthy

The missing schema is now installed, so the previous immediate deployment blocker is resolved. However, `d1_migrations` still has no records even though tables/columns from migrations through 0038 exist.

**Needed:** establish and document a baseline matching the actual schema, then use one consistent tracked migration procedure. Do not blindly run all migrations against production: `ALTER TABLE ... ADD COLUMN` and existing index creation can fail when replayed. Verify a backup/restore procedure and site/worker compatibility before the next schema change.

## Original finding disposition

“Fixed” below means supported by source review and the focused checks described here, not a guarantee against every possible failure.

| Original ID | Current status |
|---|---|
| F01 arrival-email button | Fixed; rendered URL checked, permanent regression added |
| F02 stock-alert loss | Partial; normal provider rejection handled, durable retry still absent (R05) |
| F03 restock listing/pool mismatch | Fixed; a depleted/restocked set completes a new checkout |
| F04 reduce pool below holds | Partial; ordinary refusal works, concurrent aggregate race remains (R01) |
| F05 orphan set header | Fixed for injected creation failure; header and attachment roll back |
| F06 unread acknowledgement race | Original case fixed; older acknowledgements can restore unread counts (R04) |
| F07 group cleanup bind ceiling | Fixed; 101 groups deleted successfully |
| F08 proof cleanup bind ceiling | Fixed; 101 object deletions and metadata clear succeed |
| F09 member impersonation | Backend ownership enforced; frontend integration needs R02/R03/R07 |
| F10 group-name HTML injection | Escaping added to basket/checkout; helper and call sites checked |
| F11 idle poll extra query | Fixed; customer idle poll measured at one statement; admin also uses narrow projection |
| F12 absent webhook secret | Fixed; actual handler returns 503 before processing |
| F13 shipment date partial commit | Fixed; injected child failure rolls back the parent |
| F14 message cap race | Fixed; 25 concurrent admissions commit 20 messages and 20 unread increments |
| F15 shipment-opening validation race | Fixed; invalid concurrent draft change prevents opening |
| F16 malformed request 500s | Outstanding |
| F17 login redirect | Partial; alternative external redirect reproduced (R06) |
| F18 malformed cookie | Fixed; undecodable cookie is treated as absent |
| F19 production schema gap | Required schema now present; migration ledger baseline outstanding |
| F20 order-lookup hardening | Outstanding |

The scheduled worker now isolates independent stages so one failure does not prevent all subsequent cleanup. The proof sweep also preserves failed-object pointers for retry. Those are useful improvements beyond merely avoiding a bind limit.

## D1 optimisation review

The narrower FTS trigger correctly lists the searchable text columns; stock-only updates no longer require that trigger's index rebuild. Both recommended indexes are installed in production. Catalogue pagination now chooses IDs before loading expensive card projections, and explicitly includes sale joins for price/saving sorts. This addresses the identified query shape.

I did not remeasure production read totals over an equivalent traffic window, so the other agent's claimed 57% local VM-step improvement should not be read as a verified 57% production cost reduction. Remaining optimisation work includes category/facet caching and invalidation, avoiding no-op writes, and measuring rows read per catalogue request after the release. The read-cursor correctness change above should be designed alongside polling costs.

Cloudflare's documented [D1 bind limit](https://developers.cloudflare.com/d1/platform/limits/) remains relevant to bulk operations; the updated cleanup avoids a bind per ID by using predicates/JSON lists.

## Verification and limitations

- **19 reservation regression tests passed.**
- **Typecheck: zero errors across 167 files.**
- **24 focused checks passed**, covering corrected behaviours, unchanged malformed parsing and seven remaining/new cases. “PASS Rxx” means that outstanding problem was reproduced.
- The original defect harness was also run, and its output was reviewed rather than interpreted by exit status. Its F09 result is invalid for the changed signature: no member token means the setup creates no line, so an empty result is a false positive. F10 likewise cannot establish a fix when setup fails. The new harness uses valid credentials and positive assertions.
- The original 300-title acceptance check still passed on this revision.
- Production checks were read-only; all injected failures and mutations used temporary migrated SQLite with outbound notifications stubbed.

To respect the reported memory pressure, checks ran sequentially. No additional dev server was started, and I did not rerun the full E2E suite or build during this follow-up. The other agent's commit records report full-suite runs, but those are author-reported results rather than an independent rerun. No full browser automation was performed; frontend findings combine inspected caller code/deployed bundles with isolated real-handler tests.

The next verification pass should prioritise real group UI workflows, overlapping set reservations/restock, redirect variants and out-of-order polling, then run the complete suite once those corrections are in place. Most product ideas in the original improvement roadmap remain future work; these five commits focus on defect correction and selected D1 savings.

[Focused harness](verify.mjs) · [Results](evidence/verification.txt) · [Reservation log](evidence/reservations.txt) · [Typecheck log](evidence/typecheck.txt)
