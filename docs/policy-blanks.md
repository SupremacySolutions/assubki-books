# Shop policy details

The privacy, returns, delivery and terms pages were completed from the shop's
answers on 28 September 2026. There are no policy placeholders remaining.

- Public name: As-Subkī Books / مكتبة السبكي. No personal proprietor name or
  supplier relationship is published.
- Business and return address: 2 Atkinson Street, Leicester, LE5 3QA, United Kingdom.
  Collection is by arrangement. The site identifies an Organization with this
  postal address, without claiming a public walk-in BookStore.
- Contact: configured OWNER_EMAIL, with Telegram contact options on /contact.
- Order requests are submitted on the site. The total is confirmed separately,
  and payment is made offsite by bank transfer or agreed cash arrangement.
- All books are new. ISBNs are submitted only where recorded in the catalogue.
- Completed website orders are deleted two calendar years after completed_at
  (updated_at for legacy completed rows without that timestamp). The existing
  quarter-hour worker runs a bounded cleanup after image cleanup. Orders with
  remaining private-image pointers wait until the image sweep succeeds. Linked
  submitted group baskets are removed in the same transaction; order children
  cascade. Stock history remains with a null order_id and stock is not released.
  This is a website retention rule, not a statement about external records.
- Other order states retain their existing manual deletion behavior. Unsubmitted
  shared baskets expire after seven days, personal baskets after 48 hours of
  inactivity, book requests/searches after 90 days, and unfulfilled stock alerts
  after 183 days. Uploaded order images are swept 183 days after closure.
- Change-of-mind returns: notify within 14 days, send back within a further 14.
  Customer pays return postage; the shop covers necessary postage for confirmed
  faults or mistakes. Collection does not automatically remove distance-sale rights.
- UK postage is charged at carrier cost. InPost/Royal Mail for small parcels;
  DHL Premier 24 for heavier/higher-value orders. Typical DHL box cost £7–£8,
  not a universal maximum. Dispatch Monday–Thursday; Friday–Sunday requests
  processed from Monday. No invented confirmation or dispatch deadline.
- International delivery is subject to carrier coverage; duty responsibility is
  confirmed with the selected service before the customer accepts the quote.

Deploy the website and workers/expire-holds together for the policy and cleanup
behavior to match. No new database migration is required.

## Merchant Center limits still to resolve

Google permits invoicing but explicitly excludes quote-only websites. The current
request-then-quote flow is retained at the owner's instruction. A confirmed shipping
cap/table and handling times are still needed for accurate Merchant shipping rates;
£7–£8 for a typical DHL box is not a universal UK maximum.

Reference: https://support.google.com/merchants/answer/10249082
