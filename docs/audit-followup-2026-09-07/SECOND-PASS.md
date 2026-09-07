# Second fix verification — bc74ac2

Checked the next fix commit, `bc74ac2`, using the real application functions and migrated disposable SQLite. No build, dev server, production requests or application edits were made in this pass.

**R02, R03, R06 and R07 now pass the focused verification. The original R01 oversubscription reproduction is also blocked, but the restock transaction has one further failure-path defect described below.** R04, R05, F16 and F20 remain open.

| Finding | Verification |
|---|---|
| R07 product-page member credential | Product caller now includes `memberToken`; the real route accepts the corresponding request and creates the group line. No complete browser walkthrough performed. |
| R03 legacy storage upgrade | A working `getItem`/`setItem` store preserves the same key across reads and writes once. A throwing store preserves the membership. The previous get-only stub could not verify successful persistence and has been replaced in this pass. |
| R02 organiser edits | Selected owner is carried through the data attribute, event handler and request. Updating Alice through the organiser API changes Alice's line without adding an organiser line. Separate editable/ownership flags and unique control IDs are present. |
| R06 redirect | The previously successful same-origin double-slash URL now redirects to `/admin`. The normalised output-path check also covers the described dot-segment shape by inspection. |
| R01 concurrent restock | The previous overlapping-hold case now leaves the pool unchanged. However, R08 below shows that its second write is not conditional on the first succeeding. |
| R04 stale acknowledgement | Still reproduced: an older acknowledgement restores the unread badge. |
| R05 alert durability | Still reproduced: a failed restoration after provider refusal loses the subscriber. |
| F16 malformed parsing | Representative handler still throws on an unsupported/malformed form body. |
| F20 lookup abuse controls | Unchanged by this commit; still outstanding. |

## R08 — rejected restock can still change listing stock

**Priority: High inventory correctness.** Location: `src/pages/api/admin/books/[id]/set.ts`, the second statement in the restock batch.

The pool update checks `roomForClaims`, but the listing update checks only:

```sql
EXISTS (SELECT 1 FROM book_set_stock WHERE set_id = ?2 AND have = ?1)
```

That condition can already be true before the transaction. It does not prove that the pool update succeeded.

Reproduced sequence:

1. Start with a two-volume set and a volume-2 part, both listing stock 2. The physical pool is uneven: volume 1 has 1; volume 2 has 2. Uneven pools are normal after selling parts.
2. A request to set the pool to 1 reads no holds.
3. Before its write, actual checkout calls reserve one full set and one volume-2 part. Those holds fit the existing pool.
4. The guarded pool update correctly refuses: volume 2 has two claims. But volume 1 already has `have=1`, so the second statement changes **both listing stock counts to 1**.
5. The endpoint returns `heldsets`, despite those changes. The volume-2 pool remains 2.
6. After simulating release of the full-set hold, a copy of volume 2 is physically free, but another part checkout fails because its listing has `reserved=1, stock=1`.

**Needed:** make both updates depend on the same atomic admission condition, or on a reliable record of this transaction's successful pool update. A pre-existing matching volume is insufficient. A rejected restock must leave both the pool and listing stocks unchanged. Add an uneven-pool regression with overlapping claims and subsequent cancellation/checkout.

The reproduction uses actual checkout and restock functions for admission and the raced writes; the later full-set hold release is simulated with a fixture SQL update. It does not touch live orders.

## Tests and operational notes

All **26 focused checks passed**. Some intentionally assert outstanding defects, so this is not an all-clear: R04, R05 and R08 were reproduced. Evidence: [second-pass results](evidence/second-pass.txt), [updated harness](verify-second-pass.mjs).

The earlier follow-up report remains a historical review of `d691611`; this note supersedes its status for the five addressed findings. Deployment of `bc74ac2` was not independently checked in this pass.

The memory mutex serialises npm checks that use `run-check.mjs`. It does **not** lock independently started dev servers, direct `astro build` calls or the existing deployment command. It therefore does not, by itself, prevent a build clearing a live dev server's shared Vite cache. Stop the affected dev server before building, or isolate its cache. The reported restart of port 4330 was not independently rechecked here.
