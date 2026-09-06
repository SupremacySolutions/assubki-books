# Reservation review and fixes

Reviewed against commit `8acffcc` on 6 September 2026.

## Changes

- Checkout creates the shelf order and each incoming shipment order in one database transaction. A failed parcel rolls back all orders and holds. The basket discount is calculated once, then distributed across the orders without losing pennies.
- Ordinary and group baskets retain incoming copies, use shipment links, and explain separate orders and postage. Checkout no longer promises a 48-hour hold for incoming books.
- Receiving records the actual quantities, including missing titles and partial claims. Stock, claims, order lines, deadlines, shipment status and notification records commit together. The form's receipt key prevents duplicate stock on retry; its version rejects a stale second receipt.
- Partial claims keep their original queue position and price snapshots. An order becomes payable only after all its incoming lines are filled. Existing paid claims are consumed directly when received. Set receipts also update the shared physical volume stock.
- Payment, cancellation and expiry recheck eligibility inside their transaction. A concurrent payment or deadline extension cannot be overwritten by expiry or release someone else's stock.
- Arrival notices are unique per order, wait for every title, use a lease to coordinate sweep workers, and retry failures with backoff. Unsent notices prevent automatic reservation expiry. Sending a delayed notice grants at least a full week to respond.
- Open shipment rows now have a working save form. Stale forms cannot delete titles referenced by orders. Titles with outstanding deliveries remain on the shipment until receipt is complete.
- Import, editing, receipt and expiry use bounded SQL parameters instead of one parameter or query per affected customer/title.
- Type errors in the affected application and existing browser/markup code were corrected; the application typecheck now passes.

## Before deployment

Apply all existing migrations through `0035`, then apply `migrations/0036_reservation_integrity.sql` once. Deploy both the website and `workers/expire-holds` together after the migration. The updated code requires the new receipt and notification columns; the old sweep does not provide the new expiry protection.

The migration preserves completed notice history, resets premature notices for unpaid orders still waiting on books, and queues ready orders that already have a reply deadline but no notice. It does not guess physical stock or rewrite historical sales. Any stock already corrupted by an earlier failed receipt needs reconciliation against the books actually held.

No production database or deployment was changed during this review.

## Verification

`npm run test:reservations` bundles the real functions and routes with a disposable SQLite database built from every migration. It requires `sqlite3`, blocks outbound network calls and removes its temporary files. It checks rollback, partial receipts, replay, stale versions, payment/expiry races, cancellation, large shipments, set stock, legacy mixed orders, notification retry/leases and both basket types.

Also run `npm run typecheck` and `npm run build`. Shipment and lifecycle HTTP suites were run against an isolated Wrangler database with email and Telegram dry runs. Browser inspection verified a reserved title appears in both the basket and checkout with its shipment link and reservation explanation.

## Operational limits

Notification delivery is at least once: a process failure after an external provider accepts a message but before the database records success can cause a repeat on retry. The lease prevents ordinary concurrent duplicates. Monitor pending notices and sweep errors; failed notices retain their stock until delivered or the order is explicitly cancelled.

A short delivery keeps outstanding claims waiting. If missing copies will never arrive, contact the customer and cancel the affected reservation rather than recording copies that were not received.
