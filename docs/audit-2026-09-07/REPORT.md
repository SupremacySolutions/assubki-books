# As-Subkī Books — website, API, D1 and security audit

**7 September 2026 · Audited commit `cde261f4ea56d30a22e929fc2f9c1cd8b4efc9d1`**

The normal workflows have strong regression coverage: **830 end-to-end assertions passed, 18 reservation regression tests passed, typechecking found zero errors across 167 files, and the production build succeeded**. Additional failure and concurrency tests nevertheless exposed inventory, notification and messaging defects. The highest priorities are set-stock consistency and safely aligning the production schema with the intended release.

This deliverable implements the audit plan. It does not implement the proposed application fixes. Production checks were read-only; mutations, malformed requests and injected failures used disposable local data and fake notification credentials. Privacy-policy content is excluded.

## Decision and priorities

Do not treat a green existing test suite as release clearance. Before releasing this revision:

1. Fix **F03/F04** so a restocked set is purchasable and stock cannot be reduced below existing claims.
2. Resolve **F19**, the production schema/version gap, using a reviewed migration procedure and rollback plan.
3. Fix **F01/F02** notification failures and **F10** unsafe group-name rendering.
4. Address atomicity and concurrency defects **F05/F06/F13/F14/F15**, then scheduled cleanup limits **F07/F08**.
5. Harden endpoint parsing, redirects, cookie handling and conditional webhook configuration; prioritise D1 work using measured production query totals.

No critical exploit or historical intrusion was established. This is an application audit, not a forensic determination that the site has never been breached.

## Scope, environment and evidence

Recent changes examined include admin thread polling (`cde261f`), unsaved set splitting (`c0879a6`), the listing wizard (`369f3e6`), large-shipment pagination (`8bc2dbe`), related-order postage hints (`27bfe4c`), Arabic-title search (`a10e645`), and reservation fixes (`ab044bb`). The rest of the route inventory, shared data functions, scheduled worker and website workflows were included.

The isolated environment used this commit, migrations through `0036`, local D1/SQLite, dry-run email/Telegram and a separate Vite cache. Live sampling used public GET requests, schema and aggregate SELECT/EXPLAIN queries, deployment metadata and D1 metrics. No customer message bodies, payment images or secret values were required.

| Check | Result | Evidence |
|---|---|---|
| Typecheck | 0 errors, 167 files | [Log](evidence/typecheck.txt) |
| Production build | Passed | [Log](evidence/build.txt) |
| Existing reservation regressions | 18 passed | [Log](evidence/reservations.txt) |
| Full local end-to-end suite | 830 passed, 0 failed | [Log](evidence/e2e-full.txt) |
| Targeted fault/race harness | F01–F15 reproduced; F11 is a performance observation | [Harness](reproduce.mjs), [log](evidence/reproductions.txt) |
| Large shipment | 300-title import, opening and complete receipt passed | S01 in the same harness/log |
| HTTP boundary sweep | All 62 exported route/method pairs checked | [Matrix](endpoints.csv), [raw observations](evidence/http-probes.json) |
| Extra HTTP cases | Cookie error and redirect flaw reproduced; proof-path probes rejected | [Evidence](evidence/http-extra.json) |
| Dependency advisories | npm audit reported 0 known vulnerabilities | [JSON](evidence/dependencies.json) |
| D1 | Schema, 15 read-only queries, aggregate integrity and local query benchmarks | [Live checks](evidence/live-checks.json), [benchmarks](evidence/query-benchmarks.json) |
| Public production smoke | Seven paths returned 200; `/shipments` returned 404 | [Evidence](evidence/live-smoke.json) |

An initial E2E run was invalidated by a concurrent build clearing shared Vite dependencies. Its failures are **not website findings**; `e2e-invalid-cache-run.txt` is retained only for provenance. The clean rerun above is authoritative.

## Confirmed findings and recommended corrections

Severity reflects customer/business impact; confidence distinguishes executed reproductions from source-only review. `PASS Fxx` in the harness means **the defect was reproduced**, not that the behaviour is correct. Each F01–F15 test resets a migrated disposable database and contains the exact trigger and assertions.

| ID | Severity / confidence | Error, trigger and impact | Location | Correction and acceptance check |
|---|---|---|---|---|
| F01 | Medium / reproduced | Arrival email calls the button helper with reversed arguments. Captured HTML contains `href="See your order"`; the main action does not open the order. Text/Telegram links are separate. | `src/lib/shipment-notify.ts:61`; helper `src/lib/email.ts:243` | Pass URL then label. Assert the rendered anchor target is the actual order URL. |
| F02 | Medium / reproduced | Back-in-stock subscribers are deleted before delivery. A simulated provider 429 removes the subscriber and still counts it as notified. The customer silently loses their alert. | `src/lib/notify.ts:991`, `src/lib/stock-alerts.ts` | Use a retryable outbox with delivery state; acknowledge only successful delivery. Test 429, timeout, retry and duplicate workers. |
| F03 | **High / reproduced** | Sell the original full set, then restock its volume pool to two. Public availability becomes two while the listing's stock remains zero; checkout fails its stock constraint. | `src/pages/api/admin/books/[id]/set.ts:78` | Define one consistent stock model for set listings and per-volume claims. Atomically reconcile restock with checkout accounting. Test full-set and partial-set checkout after depletion/restock. |
| F04 | **High / reproduced** | The same restock action accepts pool `have=0` while one copy is reserved. It creates inventory below committed claims. | `src/pages/api/admin/books/[id]/set.ts:81` | Guard every volume against outstanding claims in the write transaction; reject conflicting edits. Payment must not hide corruption by clamping counts. |
| F05 | Medium / reproduced | Inject failure while creating set parts: a `book_sets` header survives without its expected pool/attachments. Header creation is outside the later batch. | `src/pages/api/admin/books/[id]/set.ts:136,230` | Commit header, pool and listing attachments together. Assert complete rollback on each intermediate failure. |
| F06 | Medium / reproduced | A new message arrives after the thread is fetched but before `markRead`. The unread counter is cleared although the response excludes that message. Both sides use the vulnerable acknowledgement pattern. | `src/lib/messages.ts:154`; admin/customer thread handlers | Acknowledge through the last returned message ID, preserving newer unread messages. Test an arrival precisely between fetch and acknowledgement. |
| F07 | Medium / reproduced | Expiring 101 abandoned group baskets exceeds the 100-bind limit in the generated `IN` statement. Cleanup fails and subsequent scheduled work can be skipped. | `workers/expire-holds/index.ts:70,181` | Bounded batches or a subquery/JSON list; isolate independent scheduled stages. Test 0, 100, 101 and 1,000 groups. |
| F08 | Medium / reproduced | Proof cleanup selects up to 200 records. At 101, the fake bucket records all deletions before the metadata update exceeds the bind limit; rows retain pointers to deleted objects. | `workers/expire-holds/index.ts:110,130` | Chunk database updates below the bind limit and make delete/retry bookkeeping idempotent. Test partial R2 failure and restart. No production images were touched. |
| F09 | Medium / reproduced | A group participant can submit another participant's display name and change/delete their line. The share token authorises group access, but names are used as member identity despite the UI presenting own-line editing. | `src/lib/group.ts`, `src/pages/api/group/line.ts` | Issue a separate opaque participant credential; enforce ownership on the server. Alternatively explicitly design and label fully collaborative editing. Test cross-member mutation rejection. |
| F10 | Medium / reproduced data path | A name such as `<b id=audit-injection>Injected</b>` survives validation and reaches HTML interpolation in basket and checkout. This is stored HTML injection within an invited group. **Executable XSS was not demonstrated**; CSP constrains inline scripts. | `src/pages/basket.astro:335,383`; `src/pages/checkout.astro:164` | Render participant names with `textContent` or guaranteed HTML escaping. Add a browser test asserting markup appears as text, never as an element. |
| F11 | Low / measured | An idle customer poll executes two queries, including loading order items, despite the one-query comment. Repeated polling reads data unnecessary for token validation/message cursors. | `src/pages/api/orders/status.ts`, `src/lib/orders.ts` | Use a narrow order/authentication projection and fetch items only when needed. Assert idle poll query count and response equivalence. |
| F12 | Medium conditional / reproduced | If the Telegram webhook secret is absent, the conditional secret check accepts a forged update. A fixture update bound a chat without the header. **The live secret was present**, so this is not a demonstrated live bypass. | `src/pages/api/telegram/webhook.ts` | Return 503 when configuration is missing; require a valid header otherwise. Test absent, wrong and correct secrets. |
| F13 | Medium / reproduced | Shipment date update commits the parent and then updates book dates separately. Injected second-write failure leaves customers and admin seeing different expected dates. | `src/pages/api/admin/shipments/[id]/details.ts:43,63` | Batch both updates transactionally or derive the date from one authoritative source. Test rollback and response on failure. |
| F14 | Medium / reproduced | Twenty-five concurrent customer messages all pass a separate hourly count check and are stored, exceeding the intended cap of twenty. | `src/lib/messages.ts:90`; `src/pages/api/orders/message.ts` | Make rate-limit admission atomic. Test concurrent requests and assert only the allowed number commit; review image limits for the same pattern. |
| F15 | Medium / reproduced | A draft title is changed to zero price between shipment validation and opening. The open operation still succeeds with an invalid title. | `src/lib/shipments.ts:379` | Include validity guards in the atomic transition or use a version check covering draft edits. Test stale admin tabs and concurrent opening. |
| F16 | Low / HTTP reproduced | Malformed JSON submitted to form handlers produces 500 on **29 route/method pairs**, including login, stock alerts and customer messages. Unsupported input becomes an internal error. | Exact routes in [endpoint matrix](endpoints.csv) | Centralise content-type/body parsing; return 400 or 415 with the caller's expected response format. Assert no 500 for invalid input. |
| F17 | Low / HTTP reproduced | Login accepts `next=/\\evil.invalid` and returns it as Location. Browsers normalise the backslash into an external host when resolving this URL. | `src/pages/api/admin/login.ts:10–14` | Parse against the site origin, require same-origin destination, then emit its pathname/search/hash. Test slash/backslash and encoded variants. |
| F18 | Low / HTTP reproduced | Cookie `asb_admin=%` causes `decodeURIComponent` to throw and `/admin` returns 500. | `src/lib/admin-auth.ts:248` | Treat malformed cookies as unauthenticated and clear them. Test broken encoding and oversized/invalid signatures. |
| F19 | **High release risk / live verified** | Live schema lacks `orders.split_group` and the new delivery tables/columns expected by migrations 0035/0036. The migration history table is empty. Deploying current code against this schema is unsafe. | `migrations/0035_split_checkout.sql`, `0036_reservation_integrity.sql`; [live schema](evidence/live-schema.json) | Reconcile actual schema against migrations, back up, apply only missing changes in the correct order, verify invariants and deploy compatible site/sweeper versions. Do not blindly replay every migration. |
| F20 | Medium hardening / source review | Order recovery returns the bearer token to anyone supplying a matching reference and email, with no route-level throttle. Knowing an email lowers the barrier to guessing short references. No successful unauthorised lookup was demonstrated. | `src/pages/api/orders/lookup.ts` | Add atomic throttling and consider sending a recovery link to the email instead of revealing it immediately. Keep responses non-enumerating; test bursts and known/unknown pairs. |

F19 describes a deployment gap, not evidence that the current production release is executing all the newer paths. Production `/shipments` returning 404 corroborates that local and live behaviour differ. Deployment metadata listed website version `cf3a1c0a-bcc1-409f-86b7-1f09720bdc46` at `2026-09-05T23:49:06.225Z` and sweeper version `b8f9cb94-9cc4-4f9c-97a8-f0bf2e60ad96` at `2026-09-06T01:15:44.190Z`. Neither was reliably attributable to a Git commit from the available metadata.

## API and workflow integration

[The complete endpoint matrix](endpoints.csv) records each exported method, access boundary, known caller/source and observed statuses. All 62 pairs received unauthenticated and empty-input requests; mutating methods also received malformed and foreign-Origin requests. Unsupported methods were checked. This is a boundary sweep, not a claim that every parameter combination and provider response was exercised.

Observed foreign-Origin form requests returned 403. Protected admin handlers redirected unauthenticated requests to login. Unsupported methods returned 404; adopting 405 plus `Allow` would make the contract clearer. Some missing-resource polling endpoints return 200 by design; clients should have an explicit documented empty/not-found contract. Public proof-prefix and traversal probes returned 404. The configured local webhook rejected missing secret headers.

| Connected flow | Executed coverage | Remaining concern / limit |
|---|---|---|
| Catalogue → search/suggestions → book → basket | Existing catalogue, language, search, front-end and findability assertions; desktop/mobile visual sample | Real-user performance and complete keyboard/screen-reader coverage not measured |
| Basket → checkout → quote/payment → collection/postage → completion/cancellation | Full lifecycle suite, stock/fulfilment validation, sales and split-set assertions | F03/F04; real bank settlement not tested |
| Shipment import → edit → open → reserve → receive → allocation → notice | 68 shipment/reservation E2E assertions, 18 regression tests, 300-title S01 | F01/F13/F15; production schema gap; local scale test is not a D1 load test |
| Customer thread ↔ admin thread ↔ Telegram/email | Messaging and notification suite; race/cap/provider-failure harness | F06/F12/F14; real provider delivery and webhook retries not exhaustively tested |
| Group invite → member lines → organiser checkout | Group suite and targeted adversarial names/member tests | F09/F10; browser execution of injected scripts was not attempted |
| Admin listing wizard → saves → stock/set actions → catalogue/channel | Listings, stock, language and channel suite; source review of wizard and set actions | Faults F03/F04/F05; full visual walkthrough of every wizard branch remains unverified |
| Sales, shelves, settings, uploads, ISBN/covers | Full subsystem suite plus endpoint boundaries | External book APIs and actual R2 image variants not exhaustively exercised |
| Scheduled expiry → group cleanup → proof cleanup → notices | Existing integrity/reservation tests plus isolated cleanup failures | F07/F08; no destructive live cron test |

## D1 integrity, read cost and write cost

The live sample contained **229 books, 3 orders, 6 order items, 1 message, and no shipments or shipment notices**. Orders comprised one awaiting payment, one cancelled and one completed. Checked invariants found no stock-hold mismatches, incoming-hold mismatches, overclaimed set volumes, subtotal/total mismatches, paid incoming holds, premature deadlines or pending notices. Foreign-key checks returned no violations. This small clean snapshot does not invalidate the reproducible transition defects above.

D1 reported **843,776 bytes, 28 tables, WEUR placement and read replication disabled**. Its sampled rolling 24-hour totals were **5,494 read queries / 1,178,529 rows read** and **6 write queries / 18 rows written**. These are a snapshot, not a forecast or a billed-cost estimate. The 15 audit SQL checks recorded zero rows written and no database changes.

The top-ten read-query insights totalled **1,069,354 rows read** in their sampled day. Catalogue projections, catalogue counts, category/book/language mapping and repeated category lists dominate this list. The leading projection alone read 208,026 rows over 157 runs; facet mapping read 190,491 over 141 runs. Exact time windows can differ between the info and insights requests, so these totals should not be treated as an exact percentage of the same window. [Sanitised metrics](evidence/query-insights-summary.json) omit SQL literals and customer data.

| Priority | Optimisation | Evidence and expected benefit | Trade-off / verification |
|---|---|---|---|
| 1 | Reduce repeated catalogue/facet work | Current production read totals identify this as the largest measured target. Cache stable category/facet metadata; consolidate repeated list/count queries; inspect stock filters and correlated image/category projections. | Invalidate on relevant catalogue changes. Keep live stock/checkout authoritative. Measure rows read per catalogue request before and after; do not cache private pages or bearer-token responses. |
| 2 | Restrict the FTS update trigger to searchable text columns | Live trigger runs after every book update. Local stock-only update caused 9 SQLite total changes; narrowed trigger caused 1. Title changes remained searchable. | SQLite `total_changes` is a write-amplification proxy, not a literal D1 bill. Include every indexed text column, test insert/update/delete and rebuild existing FTS if required. |
| 3 | Add message cursor index `(order_id, id)` | Current live plan uses `(order_id, created_at)` plus a temporary sort. A 10,000-message fixture querying the final 10 rows dropped from ~50,100 to ~100 SQLite VM steps; sampled time 1.464 ms → 0.067 ms. | Local timings are not edge latency. Extra index adds writes; retain/remove the older index only after checking other consumers. |
| 4 | Narrow idle polling reads (F11) | Two SQL statements per idle customer poll, including unnecessary items. | Fetch only identity/status/cursor fields, pause when hidden and back off idle polling. Retain prompt delivery when a conversation is active. |
| 5 | Index/decouple throttle housekeeping | Global `at` cleanup over 10,000 actions used ~30,100 VM steps; an `at` index reduced this to ~300 (0.745 ms → 0.015 ms in one local sample). | Benchmark the actual delete as well as its candidate-selection plan. An extra index costs writes. Batch housekeeping instead of repeating it on every submission where appropriate. |
| 6 | Avoid no-op inventory writes | Broad updates trigger index/FTS work and may add unhelpful stock-ledger entries. | Write only changed values, but preserve meaningful audit events and atomic reservation guards. |
| 7 | Chunk scheduled work and record progress | F07/F08 show a correctness limit before scale becomes a cost issue. | Budget binds for all parameters, retry safely and prevent one failed stage stopping others. |
| 8 | Reconcile inventory periodically | Existing constraints and live checks are valuable, but pool/restock paths can diverge. | Run bounded aggregate checks on a schedule; alert on discrepancies without automatically rewriting stock. |

The local benchmark also seeds 10,000 orders. Results show query-plan direction under synthetic distributions, not a capacity certification. Existing expiry queries already use the covering expiry index; adding more indexes indiscriminately would increase write cost. Read replication is not justified by the small database alone and does not repair inefficient SQL.

Cloudflare documents the [100 bound-parameter limit](https://developers.cloudflare.com/d1/platform/limits/), [index read/write trade-offs](https://developers.cloudflare.com/d1/best-practices/use-indexes/) and [D1 query insights](https://developers.cloudflare.com/d1/observability/query-insights/). Candidate changes remain unapplied.

## Security assessment and limits

Positive evidence: sampled production pages had HSTS, `nosniff`, a restrictive script CSP using nonces, `frame-ancestors 'none'`, `object-src 'none'` and same-origin form actions. Admin access checks and foreign-Origin rejection worked in the isolated HTTP sweep. Proof-path probes were denied. npm audit returned no known advisories. Production Telegram webhook secret presence was confirmed without retrieving its value.

The actionable security issues are F09/F10, F14, F17/F18 and the conditional/missing-control risks F12/F20. None establishes historical compromise. HTML injection should be fixed even where CSP currently prevents a simple inline-script payload. Password fallback is configured; the available secret-name/configuration evidence did not establish a Cloudflare Access policy. The dashboard's Access/WAF policy, account access logs and incident history were not comprehensively inspected.

Further hardening review should cover file-content signatures rather than trusting declared image MIME types, total multipart/request limits before buffering, replay/idempotency for Telegram update IDs, and durable retries for other post-commit notifications. These are follow-up checks, not additional reproduced exploits. No exhaustive secret-history scan, external penetration test, provider outage campaign or production load test was performed. Real email deliverability, Telegram transport, banking and shipping integrations remain outside the isolated assertions.

## Website improvement roadmap

These are product ideas based on the flows and audit observations, not claims that an existing feature is broken. Effort is relative: S = small, M = several connected changes, L = substantial workflow/data work.

| Priority / effort | Idea | Customer or operational benefit | Success measure |
|---|---|---|---|
| Next / S–M | Mobile filter drawer and active-filter chips | At 390 px, language/stock filters sit after the catalogue cards. Put filtering within immediate reach, with clear reset and result count. | Filter use; fewer searches ending without a book view |
| Next / M | Unified owner action inbox | Bring unquoted orders, unread messages, failed notifications, unreceived titles and overdue actions together. | Median time to quote/reply; overdue actions |
| Next / M | Shipment receiving worklist | Search/scan titles, retain selection across pages, show received/remaining totals and preview allocation before committing. | Receipt time per title; corrections after receipt |
| Next / M | Notification health panel | Show queued, sent, retrying and permanently failed messages with safe manual retry. | Oldest pending notice; successful delivery rate |
| Next / M | Consistent set availability display | Explain which volume combinations can actually be purchased and the constraint behind a disabled choice. | Checkout stock errors; set conversion |
| Next / M | Better mixed/split-order summary | Show what ships now, what waits, related references and whether postage is combined, before submission and in admin. | Postage clarification messages; abandoned quotes |
| Next / S–M | Accessible wizard progress and recovery | Preserve draft progress, highlight errors on the relevant step, support keyboard navigation and warn before losing edits. | Listing completion time; abandoned drafts |
| Soon / M | Participant identity and activity history | Give group members stable identity and show who changed a quantity; provide organiser controls. | Disputed/accidental edits; group completion |
| Soon / M | Secure order recovery links | Recover access through the customer's email with clear generic feedback. | Recovery success; support requests; abuse rejection |
| Soon / M | Collection slots and ready-to-collect reminders | Make pickup expectations explicit and reduce coordination messages. | Days from ready to collected; missed collections |
| Soon / M | Search-quality dashboard | Track aggregate zero-result terms, spelling/transliteration gaps and language filters; suggest related titles. | Zero-result rate; search-to-book conversion |
| Soon / M | Inventory reconciliation view | Explain stock, held, incoming and per-volume allocation with a readable event history. | Unexplained discrepancies; time spent investigating |
| Later / M–L | Course/teacher reading lists and curated bundles | Let shoppers buy a coherent study list, including edition and volume compatibility. | Bundle conversion; items per fulfilled order |
| Later / M | Wishlist and demand planning | Turn interest into reorder signals with retryable alerts and clear stock expectations. | Alert-to-order conversion; unmet demand |
| Later / M | Edition comparison and richer book detail | Compare publisher, binding, script, volume coverage, print size and sample pages. | Detail-to-basket conversion; edition-related returns/questions |
| Ongoing / M | Business and reliability dashboard | Separate sales value, cash received, unpaid commitments, shipping collected and shipping cost; report dates appropriate to each metric. | Quote-to-paid rate, time to payment, reservation fulfilment, cancellation reason, margin, D1 rows/request and notification lag |

Desktop and mobile catalogue samples were visually inspected. The mobile sample fit its 390 px viewport without horizontal overflow. Missing local image fixtures and a local font-serving restriction prevent treating those screenshots as a production visual/performance baseline. A full keyboard/screen-reader audit, real-user Core Web Vitals and browser coverage beyond the sampled Chrome view remain follow-up work.

## Fix verification plan

For each correction, convert the relevant defect reproduction into an assertion of the desired outcome. Require rollback tests for multi-write actions, interleaving tests for concurrent edits, exact URL/HTML checks for notifications, and provider-failure retries. Repeat the 62-method boundary sweep after common parser/auth changes. Run typecheck, build, the 18 reservation regressions and full E2E suite sequentially with isolated caches. Re-run query plans and compare D1 rows read/written using equivalent fixtures and traffic windows.

Before deployment, verify schema compatibility on a restored copy, migration idempotency/ordering and site/sweeper compatibility. After an authorised deployment, run read-only smoke/invariant checks and inspect error/notification metrics. Keep production mutation testing separate and explicitly authorised.

[Reproduction and evidence guide](README.md) · [Endpoint matrix](endpoints.csv) · [Query benchmark](benchmark.py)
