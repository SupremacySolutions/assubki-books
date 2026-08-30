#!/usr/bin/env node
/**
 * End-to-end suite for the whole shop.
 *
 *   npm run test:e2e            against a local `astro dev`
 *   npm run test:e2e:prod       against the live site, for real
 *
 * The production run genuinely posts to the Telegram channel and genuinely
 * sends email, because that is the only way to catch the things that have
 * actually broken here: a reserved character rejecting a Telegram message, or
 * an unverified domain rejecting a send. A mock returns success and proves
 * nothing.
 *
 * Nothing touches the 226 real listings. Every fixture is tracked and removed
 * afterwards, including when a suite throws.
 */

import {
  PROD, SITE, ORIGIN, vars, prodVars, TEST_CHAT, CUSTOMER_EMAIL,
  suite, report, db, one, signIn, admin, get, html, json, visibleText,
  created, makeBook, placeOrder, teardown, adminUpload,
} from './lib/e2e-helpers.mjs';

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Every file under a directory, recursively. */
function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

const only = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1];
const wanted = (n) => !only || n.toLowerCase().includes(only.toLowerCase());
const money = (p) => `£${(p / 100).toFixed(2)}`;

// ---------------------------------------------------------------------------
async function publicCatalogue() {
  const t = suite('1. Public catalogue');
  const stats = await one(
    `SELECT COUNT(*) AS titles, SUM(CASE WHEN (stock-reserved)>0 THEN 1 ELSE 0 END) AS live
       FROM books WHERE status='live'`,
  );

  const home = await html('/');
  t.ok(home.includes(`${stats.titles} titles`), 'home page states the real number of titles');

  const cat = await html('/catalogue');
  t.ok(/\d+ titles/.test(cat), 'catalogue reports a count');
  t.ok((await get('/catalogue?page=2')).status === 200, 'pagination serves page two');

  // Both buttons the same width with the label between them, short enough to
  // sit across a phone. The long form stays as the accessible name.
  const paged = await html('/catalogue?page=2');
  t.ok(paged.includes('aria-label="Page 2 of 10"') && />\s*2 of 10\s*</.test(paged),
    'pagination reads "2 of 10" and still announces the long form');
  t.ok((paged.match(/max-w-\[8\.5rem\]/g) ?? []).length === 2,
    'and its two buttons are given the same width');

  // The hero strip used to be decorative only: covers no one could click, on a
  // ninety-second loop no one could skip.
  t.ok(/<a class="shelf-book" href="\/book\//.test(home),
    'the hero shelf covers link to their books');

  /*
   * A t.me link does nothing for someone without Telegram and the page cannot
   * tell, so every route is offered at once behind one tap.
   */
  const contact = await html('/contact');
  t.ok(contact.includes('data-contact-panel'), 'the contact page offers a way through, not just a link');
  t.ok(contact.includes('data:image/png;base64'), 'including a QR code to scan from a phone');
  t.ok(/Not on Telegram at all\?/.test(contact), 'and an email address for anyone who has none');
  // The footer is on every page; a QR on all of them is weight nobody asked for.
  t.ok(!home.includes('data:image/png;base64'), 'the footer offers the same without the QR');
  t.ok(!home.includes('shelf-strip relative overflow-hidden'),
    'and the strip is scrollable rather than clipped');
  t.ok((await get('/catalogue?stock=in')).status === 200, 'in-stock filter responds');
  for (const s of ['title', 'price-asc', 'price-desc', 'newest']) {
    t.ok((await get(`/catalogue?sort=${s}`)).status === 200, `sort by ${s}`);
  }

  // A parent shelf must include what sits beneath it.
  const parent = await html('/catalogue/syllabus');
  const counts = await one(
    `SELECT COUNT(DISTINCT bc.book_id) AS n FROM categories c
       JOIN book_categories bc ON bc.category_id = c.id
       JOIN books b ON b.id = bc.book_id AND b.status='live'
      WHERE c.path='syllabus' OR c.path LIKE 'syllabus/%'`,
  );
  t.ok(parent.includes(`${counts.n} titles`), 'a parent shelf includes its children');

  t.ok((await html('/catalogue?q=nahw')).includes('Results for'), 'search in Latin');
  t.ok((await get('/catalogue?q=%D8%A7%D9%84%D9%86%D8%AD%D9%88')).status === 200, 'search in Arabic');
  t.ok(/[1-9]\d* titles/.test(await html('/catalogue?q=tafsir')), 'search ignores diacritics');
  t.ok((await html('/catalogue?q=zzzzqqq')).includes('Nothing matches'), 'nonsense gives an empty state');

  const book = await html('/book/al-nahw-al-wadih');
  t.ok(book.includes('og:image'), 'book page carries an OG image');
  t.ok(book.includes('application/ld+json'), 'book page carries structured data');
  t.ok(book.includes('On the same shelf'), 'book page shows related titles');

  t.ok((await get('/book/does-not-exist')).status === 404, 'unknown book 404s');
  t.ok((await get('/catalogue/not-a-shelf')).status === 404, 'unknown shelf 404s');
  t.ok((await get('/sitemap.xml')).status === 200, 'sitemap responds');

  const robots = await html('/robots.txt');
  t.ok(robots.includes('Disallow: /admin'), 'robots keeps crawlers out of the portal');
  t.ok(robots.includes('Disallow: /order'), 'robots keeps crawlers off order pages');

  // The emails point at this file by absolute URL. If it stops being served the
  // letterhead silently turns into a blank square in every inbox, and nothing
  // else in the system would notice.
  const mark = await get('/email/mark.png');
  t.ok(mark.status === 200, 'the email mark is served');
  t.ok(
    (mark.headers.get('content-type') ?? '').includes('image/png'),
    'and is served as a PNG',
    mark.headers.get('content-type') ?? '(no content-type)',
  );
}

// ---------------------------------------------------------------------------
async function legacyUrls() {
  const t = suite('2. Legacy WordPress URLs');
  const row = await one(
    `SELECT legacy_slug AS l, slug AS s FROM books WHERE legacy_slug LIKE '%!%%' ESCAPE '!' LIMIT 1`,
  );
  // Sent the way a browser sends it: uppercase percent-escapes, which is what
  // made an exact match miss every Arabic-slugged legacy link.
  const upper = row.l.replace(/%[0-9a-f]{2}/g, (m) => m.toUpperCase());
  const r = await get(`/product/${upper}/`);
  t.ok(r.headers.get('location')?.endsWith(`/book/${row.s}`), 'an Arabic legacy link reaches its book');

  t.ok(
    (await get('/product-category/syllabus/dars-nizami/')).headers.get('location')?.includes('/catalogue/syllabus/dars-nizami'),
    'a legacy category link reaches its shelf',
  );
  t.ok((await get('/shop')).headers.get('location')?.endsWith('/catalogue'), '/shop reaches the catalogue');
  t.ok((await get('/cart')).headers.get('location')?.endsWith('/basket'), '/cart reaches the basket');
  t.ok((await get('/checkout')).status === 200, '/checkout is NOT swallowed by a legacy redirect');
}

// ---------------------------------------------------------------------------
async function validation() {
  const t = suite('3. Basket and order validation');
  const basket = await json('/api/basket?ids=1,999999,abc');
  t.ok(basket.body.books.length === 1, 'basket resolves real ids and ignores nonsense');

  const book = await makeBook({ stock: '2' });
  const phone = '07700 900321';
  const uk = { line1: '12 Evington Road', city: 'Leicester', postcode: 'LE2 1HN', country: 'GB' };

  /*
   * Every rule the checkout applies, applied again here - the page checks first
   * so the customer is not made to wait on a round trip, but a direct POST goes
   * nowhere near the page.
   */
  const cases = [
    [{ name: '', email: CUSTOMER_EMAIL, phone, fulfilment: 'collection' }, 'a missing name'],
    [{ name: 'A B', email: 'not-an-email', phone, fulfilment: 'collection' }, 'an invalid email'],
    [{ name: 'A B', email: CUSTOMER_EMAIL, fulfilment: 'collection' }, 'no phone number'],
    [{ name: 'A B', email: CUSTOMER_EMAIL, phone: 'ring me', fulfilment: 'collection' }, 'a phone number that is not one'],
    [{ name: 'A B', email: CUSTOMER_EMAIL, phone: '123', fulfilment: 'collection' }, 'too few digits to be a phone'],
    // Coerced silently before: anything that was not 'collection' became a
    // delivery, so a typo posted books to nowhere.
    [{ name: 'A B', email: CUSTOMER_EMAIL, phone, fulfilment: 'banana' }, 'a fulfilment that is neither'],
    [{ name: 'A B', email: CUSTOMER_EMAIL, phone, fulfilment: 'delivery' }, 'delivery without an address'],
    [{ name: 'A B', email: CUSTOMER_EMAIL, phone, fulfilment: 'delivery', ...uk, country: '' }, 'delivery without a country'],
    [{ name: 'A B', email: CUSTOMER_EMAIL, phone, fulfilment: 'delivery', ...uk, city: '' }, 'delivery without a town'],
    [{ name: 'A B', email: CUSTOMER_EMAIL, phone, fulfilment: 'delivery', ...uk, postcode: '' }, 'a UK address with no postcode'],
    [{ name: 'A B', email: CUSTOMER_EMAIL, phone, fulfilment: 'delivery', ...uk, postcode: 'NOPE' }, 'a postcode that is not one'],
  ];
  for (const [payload, label] of cases) {
    const r = await json('/api/orders', { ...payload, items: [{ bookId: book.id, qty: 1 }] });
    t.ok(r.status === 400, `refuses ${label}`);
    t.ok(Boolean(r.body.field), `and says which field is wrong for ${label}`);
  }

  // Hong Kong has no postcodes. A required box with no possible answer is how
  // an order from abroad ends.
  const abroad = await json('/api/orders', {
    name: 'A B', email: CUSTOMER_EMAIL, phone: '+852 9123 4567', fulfilment: 'delivery',
    line1: '12 Nathan Road', city: 'Kowloon', country: 'HK',
    items: [{ bookId: book.id, qty: 1 }],
  });
  t.ok(abroad.status === 200, 'accepts an address from a country with no postcodes');
  if (abroad.body.ref) {
    created.orders.push(abroad.body.ref);
    const stored = await one(`SELECT address, address_country AS c FROM orders WHERE ref='${abroad.body.ref}'`);
    t.ok(stored.c === 'HK' && stored.address.includes('Hong Kong'),
      'and names the country on the block that goes on the parcel');
  }
  const empty = await json('/api/orders', {
    name: 'A B', email: CUSTOMER_EMAIL, phone, fulfilment: 'collection', items: [],
  });
  t.ok(empty.status === 400, 'refuses an empty basket');

  const tooMany = await json('/api/orders', {
    name: 'A B', email: CUSTOMER_EMAIL, phone, fulfilment: 'collection',
    items: [{ bookId: book.id, qty: 99 }],
  });
  t.ok(tooMany.status === 409, 'refuses more copies than exist');
  t.ok(tooMany.body.problems?.[0]?.title === book.title, 'and names the title that is short');
}

// ---------------------------------------------------------------------------
async function stockAndHolds() {
  const t = suite('4. Stock and holds');
  const book = await makeBook({ stock: '1' });

  const before = await one(`SELECT stock, reserved FROM books WHERE id=${book.id}`);
  const order = await placeOrder(book.id, 'collection');
  const held = await one(`SELECT stock, reserved FROM books WHERE id=${book.id}`);
  t.ok(held.stock === before.stock, 'ordering does not decrement stock');
  t.ok(held.reserved === 1, 'ordering reserves a copy');

  // Four at once for the last copy: exactly one may win.
  const racers = await Promise.all(
    [1, 2, 3, 4].map(() =>
      json('/api/orders', {
        name: 'Racer', email: CUSTOMER_EMAIL, phone: '07700 900321', fulfilment: 'collection',
        items: [{ bookId: book.id, qty: 1 }],
      }),
    ),
  );
  for (const r of racers) if (r.body.ref) created.orders.push(r.body.ref);
  t.ok(racers.filter((r) => r.body.ok).length === 0, 'no second customer can take the last copy');

  // The hold lapses and the copy comes back.
  await db(`UPDATE orders SET expires_at = unixepoch() - 60 WHERE ref = '${order.ref}'`);
  const spare = await makeBook({ stock: '1' });
  await placeOrder(spare.id, 'collection'); // any order runs the sweep first
  const released = await one(`SELECT reserved FROM books WHERE id=${book.id}`);
  t.ok(released.reserved === 0, 'a lapsed hold releases its copy');
  const expired = await one(`SELECT status FROM orders WHERE ref='${order.ref}'`);
  t.ok(expired.status === 'expired', 'and the order is marked expired');

  const ledger = await one(
    `SELECT COALESCE(SUM(delta),0) AS net FROM stock_ledger
      WHERE book_id=${book.id} AND field='reserved'`,
  );
  t.ok(ledger.net === 0, 'the ledger nets back to zero');
}

// ---------------------------------------------------------------------------
async function fulfilment() {
  const t = suite('5. Delivery and collection');

  const dBook = await makeBook();
  const d = await placeOrder(dBook.id, 'delivery');
  const dPage = await html(`/order?ref=${d.ref}&t=${d.token}`);
  t.ok(dPage.includes('Delivery to'), 'delivery: customer page says Delivery to');
  t.ok(dPage.includes('Evington Road'), 'delivery: shows the address');
  t.ok(dPage.includes('Postage is added'), 'delivery: mentions postage');
  const dPortal = await html(`/admin/orders/${d.ref}`);
  t.ok(/>\s*Send to\s*</.test(dPortal), 'delivery: portal heading says Send to');
  t.ok(dPortal.includes('Postage (£)'), 'delivery: portal offers a postage field');
  const dConf = await admin(`/api/admin/orders/${d.ref}/confirm`, { postage: '3.95' });
  t.ok(dConf.location.includes('sent='), `delivery: confirmed (${dConf.location.split('sent=')[1] ?? '?'})`);
  const dTotals = await one(`SELECT postage_pence p, total_pence tt, subtotal_pence s FROM orders WHERE ref='${d.ref}'`);
  t.ok(dTotals.tt === dTotals.s + 395, `delivery: total includes postage (${money(dTotals.tt)})`);

  const cBook = await makeBook();
  const c = await placeOrder(cBook.id, 'collection');
  const cPage = await html(`/order?ref=${c.ref}&t=${c.token}`);
  t.ok(cPage.includes('collecting in person'), 'collection: customer page says collecting');
  t.ok(!cPage.includes('Postage is added'), 'collection: no postage note');
  t.ok(!cPage.includes('Delivery to'), 'collection: never says Delivery to');
  const cPortal = await html(`/admin/orders/${c.ref}`);
  t.ok(/>\s*Collecting\s*</.test(cPortal), 'collection: portal heading says Collecting');
  t.ok(!/>\s*Send to\s*</.test(cPortal), 'collection: portal heading never says Send to');
  // Postage is posted deliberately; it must be ignored.
  await admin(`/api/admin/orders/${c.ref}/confirm`, { postage: '3.95' });
  const cTotals = await one(`SELECT postage_pence p, total_pence tt, subtotal_pence s FROM orders WHERE ref='${c.ref}'`);
  t.ok(cTotals.p === 0 && cTotals.tt === cTotals.s, 'collection: postage ignored even when sent');
}

// ---------------------------------------------------------------------------
async function orderPageAndLookup() {
  const t = suite('6. Order page and lookup');
  const book = await makeBook();
  const o = await placeOrder(book.id, 'delivery');

  t.ok((await get(`/order?ref=${o.ref}&t=${o.token}`)).status === 200, 'the emailed link resolves');
  const old = await get(`/order/${o.ref}?t=${o.token}`);
  t.ok(old.status === 301 && old.headers.get('location')?.includes(`/order?ref=${o.ref}`),
    'the old URL still works, via a redirect');

  t.ok((await html('/order')).includes('Look up your order'), 'with no query it shows the form');

  const found = await fetch(`${SITE}/api/orders/lookup`, {
    method: 'POST', headers: { ...ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ref: o.ref, email: CUSTOMER_EMAIL }).toString(), redirect: 'manual',
  });
  t.ok(found.headers.get('location')?.includes(`ref=${o.ref}`), 'reference and email find the order');

  const wrongEmail = await fetch(`${SITE}/api/orders/lookup`, {
    method: 'POST', headers: { ...ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ref: o.ref, email: 'stranger@example.com' }).toString(), redirect: 'manual',
  });
  const wrongRef = await fetch(`${SITE}/api/orders/lookup`, {
    method: 'POST', headers: { ...ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ref: 'ASB-ZZZZ', email: CUSTOMER_EMAIL }).toString(), redirect: 'manual',
  });
  t.ok(
    wrongEmail.headers.get('location') === wrongRef.headers.get('location'),
    'a wrong email fails identically to a wrong reference',
  );

  const stale = await html(`/order?ref=${o.ref}&t=deadbeef`);
  t.ok(stale.includes('expired or was incomplete'), 'a stale token offers the form, not a 404');
  t.ok(!stale.includes('Mikail Bhana'), 'and a guessed token never leaks the customer');

  const journey = await html(`/order?ref=${o.ref}&t=${o.token}`);
  t.ok(journey.includes('Request received'), 'the journey shows the first step');
  t.ok(journey.includes('in progress'), 'and marks where the order currently sits');

  // Tracking belongs to a posted order only.
  await admin(`/api/admin/orders/${o.ref}/confirm`, { postage: '3.95' });
  await admin(`/api/admin/orders/${o.ref}/status`, { status: 'paid' });
  await admin(`/api/admin/orders/${o.ref}/status`, { status: 'dispatched', tracking: 'AB123456789GB' });
  const posted = await html(`/order?ref=${o.ref}&t=${o.token}`);
  t.ok(posted.includes('AB123456789GB'), 'a tracking number reaches the customer');

  const cBook = await makeBook();
  const c = await placeOrder(cBook.id, 'collection');
  await admin(`/api/admin/orders/${c.ref}/confirm`, {});
  await admin(`/api/admin/orders/${c.ref}/status`, { status: 'paid' });
  await admin(`/api/admin/orders/${c.ref}/status`, { status: 'dispatched', tracking: 'SHOULD-NOT-SHOW' });
  const collected = await html(`/order?ref=${c.ref}&t=${c.token}`);
  t.ok(!collected.includes('SHOULD-NOT-SHOW'), 'a collection never shows tracking');
  t.ok(collected.includes('Ready to collect'), 'a collection ends with "Ready to collect"');
}

// ---------------------------------------------------------------------------
async function adminAuth() {
  const t = suite('7. Admin authentication');
  const bare = { redirect: 'manual', headers: {} };

  for (const path of ['/admin', '/admin/orders', '/admin/books', '/admin/shelves', '/admin/settings']) {
    const r = await fetch(`${SITE}${path}`, bare);
    t.ok(r.status === 302 || r.status === 403, `${path} is closed to strangers`);
  }
  const apiShut = await fetch(`${SITE}/api/admin/settings`, { method: 'POST', ...bare });
  t.ok(apiShut.status === 302 || apiShut.status === 403, 'portal APIs are closed too');

  const forgedJwt = await fetch(`${SITE}/admin`, {
    redirect: 'manual',
    headers: { 'Cf-Access-Jwt-Assertion': 'eyJhbGciOiJub25lIn0.eyJlbWFpbCI6ImV2aWxAeC5jb20iLCJhdWQiOlsieCJdLCJleHAiOjk5OTk5OTk5OTl9.' },
  });
  t.ok(forgedJwt.status !== 200, 'an unsigned Access token is rejected');

  const forgedCookie = await fetch(`${SITE}/admin`, {
    redirect: 'manual', headers: { Cookie: 'asb_admin=9999999999.deadbeef' },
  });
  t.ok(forgedCookie.status !== 200, 'a forged session cookie is rejected');

  const offSite = await fetch(`${SITE}/api/admin/login`, {
    method: 'POST', headers: { ...ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      password: PROD ? vars.ADMIN_PASSWORD_PROD : vars.ADMIN_PASSWORD,
      next: 'https://evil.example.com',
    }).toString(),
    redirect: 'manual',
  });
  t.ok(!offSite.headers.get('location')?.includes('evil.example.com'), 'sign-in cannot be bounced off-site');

  const wrong = await fetch(`${SITE}/api/admin/login`, {
    method: 'POST', headers: { ...ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: 'nope', next: '/admin' }).toString(), redirect: 'manual',
  });
  t.ok(wrong.headers.get('location')?.includes('e=1'), 'a wrong password is refused');
}

// ---------------------------------------------------------------------------
async function listings() {
  const t = suite('8. Portal: listings');
  const book = await makeBook();
  const page = await html(`/admin/books/${book.id}`);
  t.ok(page.includes('Test Author'), 'author is saved');
  t.ok(page.includes('Test Press'), 'publisher is saved');
  t.ok(page.includes('Second paragraph.'), 'the description keeps its paragraphs');

  const row = await one(`SELECT slug, status FROM books WHERE id=${book.id}`);
  t.ok((await get(`/book/${row.slug}`)).status === 200, 'it appears in the shop');

  // Stock may not drop below what customers are already promised.
  const o = await placeOrder(book.id, 'collection');
  await admin('/api/admin/books/stock', { id: book.id, stock: '0' });
  const floored = await one(`SELECT stock, reserved FROM books WHERE id=${book.id}`);
  t.ok(floored.stock >= floored.reserved, 'stock cannot drop below what is reserved');

  const held = await admin(`/api/admin/books/${book.id}/delete`);
  t.ok(held.location.includes('e=held'), 'delete is refused while a copy is held');

  await admin(`/api/admin/orders/${o.ref}/status`, { status: 'cancelled' });
  const gone = await admin(`/api/admin/books/${book.id}/delete`);
  t.ok(gone.location.includes('deleted'), 'delete succeeds once nothing is held');
  created.books = created.books.filter((id) => id !== book.id);
  t.ok((await get(`/book/${row.slug}`)).status === 404, 'and it leaves the shop');

  const survived = await one(
    `SELECT title_snapshot AS s, book_id FROM order_items
      WHERE order_id = (SELECT id FROM orders WHERE ref='${o.ref}')`,
  );
  t.ok(survived.s === book.title && survived.book_id === null,
    'the past order still names what was bought');

  const counts = await one(
    `SELECT (SELECT COUNT(*) FROM books b WHERE b.status='live'
        AND NOT EXISTS (SELECT 1 FROM book_images WHERE book_id=b.id)) AS n`,
  );
  const filtered = await html('/admin/books?filter=no-photo');
  t.ok(filtered.includes(`of ${counts.n}`), 'a filter count matches the database');
}

// ---------------------------------------------------------------------------
async function shelves() {
  const t = suite('9. Portal: shelves');
  const before = (await db(`SELECT path FROM categories WHERE id IN (50,51,38) ORDER BY path`))
    .map((r) => r.path).join(',');

  await admin('/api/admin/shelves/update', { id: '50', name: 'Course Books', parent: '' });
  const renamed = (await db(`SELECT path FROM categories WHERE id IN (51,38) ORDER BY path`))
    .map((r) => r.path);
  t.ok(renamed.every((p) => p.startsWith('course-books/')), 'renaming a shelf re-paths its children');
  await admin('/api/admin/shelves/update', { id: '50', name: 'Syllabus', parent: '' });
  const restored = (await db(`SELECT path FROM categories WHERE id IN (50,51,38) ORDER BY path`))
    .map((r) => r.path).join(',');
  t.ok(restored === before, 'and renaming back restores the original paths');

  const cycle = await admin('/api/admin/shelves/update', { id: '50', name: 'Syllabus', parent: '51' });
  t.ok(cycle.location.includes('e=cycle'), 'a shelf cannot be moved inside its own child');

  await admin('/api/admin/shelves/create', { name: 'E2E Parent', parent: '' });
  const parent = await one(`SELECT id FROM categories WHERE slug='e2e-parent'`);
  created.shelves.push(parent.id);
  await admin('/api/admin/shelves/create', { name: 'E2E Child', parent: String(parent.id) });
  const child = await one(`SELECT id, path FROM categories WHERE slug='e2e-child'`);
  created.shelves.push(child.id);
  t.ok(child.path === 'e2e-parent/e2e-child', 'a new child nests under its parent');

  await admin('/api/admin/shelves/delete', { id: String(parent.id) });
  const lifted = await one(`SELECT parent_id, path FROM categories WHERE id=${child.id}`);
  t.ok(lifted.parent_id === null && lifted.path === 'e2e-child',
    'deleting a parent lifts its child rather than orphaning it');
  created.shelves = created.shelves.filter((id) => id !== parent.id);
}

// ---------------------------------------------------------------------------
async function portalOrders() {
  const t = suite('10. Portal: orders');
  const book = await makeBook({ stock: '5' });

  const o = await placeOrder(book.id, 'collection');
  const tooFar = await admin(`/api/admin/orders/${o.ref}/status`, { status: 'dispatched' });
  t.ok(tooFar.location.includes('e=state'), 'an order cannot skip straight to dispatched');

  await admin(`/api/admin/orders/${o.ref}/confirm`, {});
  await admin(`/api/admin/orders/${o.ref}/status`, { status: 'paid' });
  const sold = await one(`SELECT stock, reserved FROM books WHERE id=${book.id}`);
  t.ok(sold.stock === 4 && sold.reserved === 0, 'paying converts the hold into a sale');
  const cleared = await one(`SELECT expires_at AS e FROM orders WHERE ref='${o.ref}'`);
  t.ok(cleared.e === null, 'and clears the expiry so the cron cannot double-release');

  // A tidy-up must never sweep away a real sale.
  const cancelled = await placeOrder(book.id, 'collection');
  await admin(`/api/admin/orders/${cancelled.ref}/status`, { status: 'cancelled' });
  await admin('/api/admin/orders/clear', { scope: 'both' });
  const kept = await one(`SELECT COUNT(*) AS n FROM orders WHERE ref='${o.ref}'`);
  const swept = await one(`SELECT COUNT(*) AS n FROM orders WHERE ref='${cancelled.ref}'`);
  t.ok(kept.n === 1, 'clearing keeps a paid order');
  t.ok(swept.n === 0, 'and removes a cancelled one');
  created.orders = created.orders.filter((r) => r !== cancelled.ref);

  // Deleting a completed order must not invent stock that was sold.
  const stockBefore = (await one(`SELECT stock FROM books WHERE id=${book.id}`)).stock;
  await admin(`/api/admin/orders/${o.ref}/delete`);
  const stockAfter = (await one(`SELECT stock FROM books WHERE id=${book.id}`)).stock;
  t.ok(stockAfter === stockBefore, 'deleting a paid order does not restore sold stock');
  created.orders = created.orders.filter((r) => r !== o.ref);

  const holding = await placeOrder(book.id, 'collection');
  await admin(`/api/admin/orders/${holding.ref}/delete`);
  const releasedNow = await one(`SELECT reserved FROM books WHERE id=${book.id}`);
  t.ok(releasedNow.reserved === 0, 'but deleting a held order does release its copies');
  created.orders = created.orders.filter((r) => r !== holding.ref);
}

// ---------------------------------------------------------------------------
async function notifications() {
  const t = suite('11. Notifications, for real');
  const book = await makeBook();

  // Announce, then announce again: the second must edit, not duplicate.
  const first = await admin(`/api/admin/books/${book.id}/telegram`);
  t.ok(first.location.includes('posted=1'), 'a listing reaches the channel');
  const msg = await one(`SELECT telegram_message_id AS m FROM books WHERE id=${book.id}`);
  t.ok(Boolean(msg.m), `and its message id is recorded (${msg.m})`);
  const second = await admin(`/api/admin/books/${book.id}/telegram`);
  const after = await one(`SELECT telegram_message_id AS m FROM books WHERE id=${book.id}`);
  t.ok(second.location.includes('posted=1') && after.m === msg.m,
    'announcing again edits that post rather than adding another');

  // Bind a chat the way a customer's tap does, then confirm for real.
  const o = await placeOrder(book.id, 'delivery');
  const secret = vars.TELEGRAM_WEBHOOK_SECRET;
  const hook = (body, token = secret) =>
    fetch(`${SITE}/api/telegram/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': token },
      body: JSON.stringify(body),
    });

  const badSecret = await hook({ message: { chat: { id: 1 }, text: '/start x' } }, 'wrong');
  t.ok(badSecret.status === 403, 'the webhook refuses a wrong secret');

  await hook({ message: { chat: { id: 424242 }, text: `/start ${o.ref}_deadbeefdeadbeef` } });
  const notBound = await one(`SELECT telegram_chat_id AS c FROM orders WHERE ref='${o.ref}'`);
  t.ok(notBound.c === null, 'a wrong token prefix cannot bind a chat');

  await hook({ message: { chat: { id: Number(TEST_CHAT) }, text: `/start ${o.ref}_${o.token.slice(0, 16)}` } });
  const bound = await one(`SELECT telegram_chat_id AS c FROM orders WHERE ref='${o.ref}'`);
  t.ok(String(bound.c) === String(TEST_CHAT), 'the right payload binds the chat');

  // The message that a reserved character silently broke.
  const conf = await admin(`/api/admin/orders/${o.ref}/confirm`, { postage: '3.95' });
  t.ok(conf.location.includes('telegram'), 'the payment DM was accepted by Telegram');
  t.ok(conf.location.includes('email'), 'and the same details went by email');
  t.note(`check ${CUSTOMER_EMAIL} and the Telegram chat - a provider accepting is not a human receiving`);

  // A customer already reachable is not asked to connect again.
  const second2 = await placeOrder(book.id, 'collection');
  const carried = await one(`SELECT telegram_chat_id AS c FROM orders WHERE ref='${second2.ref}'`);
  t.ok(String(carried.c) === String(TEST_CHAT), 'their chat carries to the next order');
  t.ok(!(await html(`/order?ref=${second2.ref}&t=${second2.token}`)).includes('Connect Telegram'),
    'so the order page stops asking');
}

// ---------------------------------------------------------------------------
async function groupOrders() {
  const t = suite('16. Group orders');

  const post = async (path, body) => {
    const res = await fetch(`${SITE}${path}`, {
      method: 'POST',
      headers: { ...ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const readGroup = async (g, k) =>
    (await (await get(`/api/group?g=${encodeURIComponent(g)}&k=${encodeURIComponent(k)}`)).json());

  // --- a basket two people fill -------------------------------------------
  const bookA = await makeBook();
  const bookB = await makeBook();

  const made = await post('/api/group', { name: 'Yusuf', email: CUSTOMER_EMAIL });
  t.ok(made.status === 200 && made.body.code?.startsWith('GRP-'), 'a group basket can be started');
  const { code, token, ownerToken } = made.body;
  created.groups.push(code);

  t.ok(token && ownerToken && token !== ownerToken,
    'with one key to add and a different one to send');

  t.ok((await post('/api/group', { name: 'A', email: CUSTOMER_EMAIL })).status === 400,
    'and not without a name to put beside the books');
  t.ok((await post('/api/group', { name: 'Yusuf', email: 'not-an-email' })).status === 400,
    'nor without somewhere to send the organiser their own link');

  await post('/api/group/line', { code, token, name: 'Yusuf', bookId: bookA.id, qty: 2 });
  await post('/api/group/line', { code, token, name: 'Aisha', bookId: bookB.id, qty: 1 });

  const shared = await readGroup(code, token);
  t.ok(shared.group.lines.length === 2, 'both people see both lines');
  t.ok(shared.group.people.includes('Yusuf') && shared.group.people.includes('Aisha'),
    'and each line says whose it is');
  t.ok(shared.group.subtotalPence === 3 * 1250, 'the subtotal covers everyone');

  // Two people wanting the same title is six copies and two names, not a
  // disagreement about the number three.
  await post('/api/group/line', { code, token, name: 'Aisha', bookId: bookA.id, qty: 1 });
  const shared2 = await readGroup(code, token);
  t.ok(shared2.group.lines.filter((l) => l.bookId === bookA.id).length === 2,
    'the same title wanted by two people stays two lines');

  // Their own line, not everyone's: zero removes only theirs.
  await post('/api/group/line', { code, token, name: 'Aisha', bookId: bookA.id, qty: 0 });
  const shared3 = await readGroup(code, token);
  t.ok(shared3.group.lines.filter((l) => l.bookId === bookA.id).length === 1,
    'and removing one person\'s line leaves the other alone');

  // --- the link is the permission, and says which one you hold --------------
  const guessed = await (await get(`/api/group?g=${code}&k=${'0'.repeat(32)}`)).json();
  t.ok(guessed.ok === false, 'a guessed token opens nothing');

  const asMember = await readGroup(code, token);
  const asOwner = await readGroup(code, ownerToken);
  t.ok(asMember.group.role === 'member' && asOwner.group.role === 'organiser',
    'the key decides the role, not the browser holding it');
  t.ok(!asMember.group.shareToken && asOwner.group.shareToken === token,
    'and only the organiser is handed the link to pass round');

  /*
   * The share link reaches everyone in the group, so it must not be able to
   * send the order. Enforced here rather than by hiding a button: the organiser
   * owns the address the parcel goes to.
   */
  const asImposter = await json('/api/orders', {
    name: 'Aisha Patel', email: CUSTOMER_EMAIL, phone: '07700 900321', fulfilment: 'collection',
    items: [], groupCode: code, groupToken: token, groupOwnerToken: token,
  });
  t.ok(asImposter.status === 409, 'somebody holding only the share link cannot send the order');

  // --- one basket becomes one order ----------------------------------------
  const sent = await json('/api/orders', {
    name: 'Yusuf Patel',
    email: CUSTOMER_EMAIL,
    phone: '07700 900321',
    fulfilment: 'delivery',
    line1: '12 Evington Road',
    city: 'Leicester',
    postcode: 'LE2 1HN',
    country: 'GB',
    items: [],
    groupCode: code,
    groupOwnerToken: ownerToken,
  });
  t.ok(sent.status === 200 && sent.body.ref, 'the organiser sends it as one order');
  if (sent.body.ref) created.orders.push(sent.body.ref);

  const lines = await db(
    `SELECT oi.qty, oi.title_snapshot AS title FROM order_items oi
       JOIN orders o ON o.id = oi.order_id WHERE o.ref = '${sent.body.ref}'`,
  );
  const totalCopies = lines.reduce((n, l) => n + l.qty, 0);
  t.ok(lines.length === 2 && totalCopies === 3, 'holding everything the group asked for');

  const order = await one(`SELECT notes FROM orders WHERE ref='${sent.body.ref}'`);
  t.ok((order.notes ?? '').includes('Yusuf') && (order.notes ?? '').includes('Aisha'),
    'with a breakdown of whose books are whose');

  // --- and closes behind itself --------------------------------------------
  const afterSend = await post('/api/group/line', { code, token, name: 'Aisha', bookId: bookB.id, qty: 5 });
  t.ok(afterSend.status === 409, 'nobody can add to a group order already sent');

  const again = await json('/api/orders', {
    name: 'Yusuf Patel', email: CUSTOMER_EMAIL, phone: '07700 900321', fulfilment: 'collection',
    items: [], groupCode: code, groupOwnerToken: ownerToken,
  });
  t.ok(again.status === 409, 'and it cannot be sent twice');
}

// ---------------------------------------------------------------------------
async function ownerSettings() {
  const t = suite('15. Settings, drafts and contact');

  // --- the confirm box starts from the right draft --------------------------
  //
  // One draft used to serve each journey, so the owner rewrote the box by hand
  // whenever an order did not suit the single saved text.
  await admin('/api/admin/settings', {
    payment_part_account_1: 'ACCOUNT-ONE bank transfer please.',
    payment_part_account_1_label: 'Main account',
    payment_part_account_2: 'ACCOUNT-TWO the other account.',
    payment_part_account_2_label: 'Second account',
    // Deliberately left empty: an unused slot must not be offered.
    payment_part_account_3: '',
    payment_part_account_3_label: 'Never used',
    payment_part_cash: 'CASH-WORDING nothing to pay now.',
    payment_part_cash_label: 'Cash',
    payment_part_place_1: 'PLACE-ONE the Leicester shop.',
    payment_part_place_1_label: 'Leicester',
    payment_part_place_2: 'PLACE-TWO the Saturday stall.',
    payment_part_place_2_label: 'Saturday stall',
    collection_address: '12 Evington Road, Leicester LE2 1HN - Saturdays 10am to 4pm',
    contact_telegram: '@alsubkibooks',
  });

  // What is *in the box*, not merely somewhere on the page: every draft is
  // carried in a data attribute so the picker can swap between them without a
  // page load, so "on the page" would prove nothing.
  const draftInBox = (markup) =>
    markup.match(/<textarea[^>]*id="payment_message"[^>]*>([\s\S]*?)<\/textarea>/)?.[1] ?? '';

  const dBook = await makeBook();
  const d = await placeOrder(dBook.id, 'delivery');
  const dPortal = await html(`/admin/orders/${d.ref}`);
  t.ok(draftInBox(dPortal).includes('ACCOUNT-ONE'),
    'a posted order opens with the first account');
  t.ok(dPortal.includes('Main account') && dPortal.includes('Second account'),
    'and offers the accounts by the names the owner gave them');
  t.ok(!dPortal.includes('Never used'),
    'an account with nothing written in it is not offered');
  t.ok(!dPortal.includes('data-place-picker'),
    'a posted order is not asked where they collect');

  const cBook = await makeBook();
  const c = await placeOrder(cBook.id, 'collection');
  const cPortalRaw = await html(`/admin/orders/${c.ref}`);
  const cPortal = draftInBox(cPortalRaw);

  /*
   * The point of the restructure: a collection paid by transfer needs the
   * address *and* the account, which no single list of whole messages could
   * offer without a box per combination.
   */
  t.ok(cPortal.includes('PLACE-ONE') && cPortal.includes('ACCOUNT-ONE'),
    'a collection opens with both where they collect and how they pay');
  t.ok(cPortalRaw.includes('data-place-picker') && cPortalRaw.includes('data-draft-picker'),
    'and offers both pickers');
  t.ok(cPortalRaw.includes('Saturday stall'), 'including the second address');

  /*
   * There is no separate cash draft any more - it was a slot to maintain for a
   * case the picker already covers. Ticking cash asks the owner which of their
   * own wordings to send, so the page must carry that prompt and still offer
   * every draft to choose from.
   */
  await admin(`/api/admin/orders/${c.ref}/cash-payment`, { cash_payment: '1' });
  const cashPage = await html(`/admin/orders/${c.ref}`);
  t.ok(cashPage.includes('paying in cash - check the wording'),
    'a cash order asks the owner to check the wording');
  t.ok(draftInBox(cashPage).includes('CASH-WORDING') && !draftInBox(cashPage).includes('ACCOUNT-ONE'),
    'and opens on the cash wording rather than bank details');
  t.ok(draftInBox(cashPage).includes('PLACE-ONE'),
    'while still saying where they collect');

  // --- postage remembers rather than being maintained -----------------------
  //
  // This replaced a "usual postage" setting the owner typed over anyway.
  await admin(`/api/admin/orders/${d.ref}/confirm`, { postage: '4.75', payment_message: 'x' });
  const nextBook = await makeBook();
  const next = await placeOrder(nextBook.id, 'delivery');
  t.ok((await html(`/admin/orders/${next.ref}`)).includes('value="4.75"'),
    'the postage box offers what the last posted order used');

  // --- one handle, set in one place -----------------------------------------
  await admin('/api/admin/settings', { contact_telegram: '@e2econtact' });
  const [home, contact, order] = await Promise.all([
    html('/'),
    html('/contact'),
    html(`/order?ref=${next.ref}&t=${next.token}`),
  ]);
  t.ok(home.includes('t.me/e2econtact'), 'the footer follows the handle in settings');
  t.ok(contact.includes('t.me/e2econtact') && contact.includes('@e2econtact'),
    'the contact page links it and shows it as text');
  t.ok(order.includes('t.me/e2econtact'), 'and the order page points at a person, not the channel');
  t.ok(visibleText(order).includes(vars.OWNER_EMAIL ?? 'subkibooks'),
    'with an address beside it for anyone without Telegram');

  // --- the settings page itself ---------------------------------------------
  const page = visibleText(await html('/admin/settings'));
  t.ok(page.includes('How they pay') && page.includes('Where they collect'),
    'settings keeps how they pay apart from where they collect');
  t.ok(page.includes('Name for this one'),
    'and each one can be named');
  t.ok(!page.includes('Usual postage'),
    'and no longer asks for a postage default the owner types over anyway');

  await admin('/api/admin/settings', { contact_telegram: '@alsubkibooks' });
}

// ---------------------------------------------------------------------------
async function integrity() {
  const t = suite('12. Data integrity');
  const bad = await db(
    `SELECT b.id FROM books b WHERE (b.stock - b.reserved) < 0`,
  );
  t.ok(bad.length === 0, 'no book has negative availability');

  const dupes = await db(`SELECT slug FROM books GROUP BY slug HAVING COUNT(*) > 1`);
  t.ok(dupes.length === 0, 'no duplicate slugs');

  /*
   * Covers are padded into one frame as they are served rather than rewritten,
   * so the presets have to survive the route - and an unknown one has to fall
   * through rather than 404, or a stale link in somebody's inbox becomes a
   * broken image.
   *
   * The migrated covers live in the *remote* bucket, so there is nothing local
   * to fetch. Uploading one through the real endpoint gives this an object to
   * ask for and exercises the upload path at the same time.
   *
   * Note the transform itself cannot run here: the IMAGES binding only exists
   * in the deployed Worker, so what this proves locally is the fallthrough -
   * that every preset serves the image rather than failing.
   */
  const imgBook = await makeBook();
  // A 1×1 PNG, the smallest thing the endpoint will accept.
  const png = Uint8Array.from(atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  ), (ch) => ch.charCodeAt(0));

  const upload = new FormData();
  upload.append('bookId', String(imgBook.id));
  upload.append('photo', new File([png], 'cover.png', { type: 'image/png' }));
  upload.append('width', '600');
  upload.append('height', '800');

  const uploaded = await adminUpload('/api/admin/upload', upload);
  const uploadedBody = uploaded.body;
  t.ok(uploaded.status === 200 && uploadedBody.key, 'a photo can be uploaded');

  if (uploadedBody.key) {
    const key = uploadedBody.key;

    // The dimensions were never recorded before, so nothing could reserve space
    // for an owner's photo and the grid jumped as it loaded.
    const stored = await one(
      `SELECT width AS w, height AS h FROM book_images WHERE image_key = '${key}'`,
    );
    t.ok(stored.w === 600 && stored.h === 800, 'and its size is recorded, so the page can reserve space');

    const plain = await get(`/img/${key}`);
    const framed = await get(`/img/${key}?p=card`);
    const nonsense = await get(`/img/${key}?p=enormous`);
    t.ok(plain.status === 200, 'a cover serves without a preset');
    t.ok(framed.status === 200, 'and with one');
    t.ok(nonsense.status === 200, 'an unknown preset falls through to the original');

    // A preset changes the bytes, so it has to change the etag - otherwise a
    // browser holding the full-size cover is told its copy of the 84px one is
    // still good.
    const plainTag = plain.headers.get('etag');
    const framedTag = framed.headers.get('etag');
    t.ok(Boolean(plainTag) && plainTag !== framedTag, 'each preset has its own etag');
    t.ok(nonsense.headers.get('etag') === plainTag, 'and an unknown one keeps the original etag');

    /*
     * Sizes are stored beside the master rather than transformed on the way
     * out, so a preset whose file was never made has to fall back to the master
     * rather than 404 - an owner's upload has no variants at all, and neither
     * does anything that predates the standardising pass.
     */
    t.ok(framed.headers.get('content-type')?.startsWith('image/'),
      'a preset with no stored variant still returns an image');
  }

  // The home page was serving 800px covers into 84px slots, 28 of them. Every
  // cover anywhere should now ask for the size it is actually shown at.
  const homeImages = [...(await html('/')).matchAll(/<img[^>]+src="([^"]*\/img\/[^"]*)"/g)].map(
    (m) => m[1],
  );
  t.ok(homeImages.length > 0 && homeImages.every((src) => /\?p=(hero|card)$/.test(src)),
    'every cover on the home page asks for the size it is shown at');

  /*
   * Astro compiles an ordinary <script>, but ships an `is:inline` one to the
   * browser exactly as written - and `define:vars` forces inline. A TypeScript
   * generic in such a block parses as a pair of comparisons: no error, no
   * warning, the listener simply never binds. That is how the cash-on-collection
   * checkbox reached production doing nothing at all.
   */
  const inlineTs = [];
  for (const file of walk(new URL('../src/', import.meta.url).pathname)) {
    if (!file.endsWith('.astro')) continue;
    const source = readFileSync(file, 'utf8');
    // `(?![^>]*\/>)` skips self-closing tags - the JSON-LD block is one, and
    // without this the match ran past it and captured the next script's body.
    for (const block of source.matchAll(
      /<script(?![^>]*\/>)[^>]*\bis:inline\b[^>]*>([\s\S]*?)<\/script>/g,
    )) {
      if (/querySelector\s*<|\bas\s+HTML|\)\s*:\s*(string|number|boolean|void)\b/.test(block[1])) {
        inlineTs.push(file.split('/src/')[1]);
      }
    }
  }
  t.ok(inlineTs.length === 0, `no is:inline script carries TypeScript${inlineTs.length ? ` (${inlineTs.join(', ')})` : ''}`);

  /*
   * The hero strip's drift cannot be watched from here - requestAnimationFrame
   * does not run in a headless tab, which reports itself hidden - so the part
   * that would show as a visible jump is checked directly instead: the strip
   * holds every cover twice, and the wrap has to land exactly one copy back.
   */
  const { nextOffset, createDrift } = await import('../src/scripts/shelf.ts');
  t.ok(nextOffset(0, 1000, 1000) === 14, 'the shelf drifts 14px a second');
  t.ok(nextOffset(995, 1000, 1000) === 9, 'and wraps by exactly one copy of the covers');
  t.ok(nextOffset(10, 1000, 0) === 24, 'an unmeasured track still moves rather than sticking');

  /*
   * A browser rounds scrollLeft to whole pixels on read, and this drift moves
   * about a quarter of a pixel per frame. Reading the position back from the
   * element each frame therefore rounded every frame's movement away and the
   * shelf sat perfectly still - which is what the shop's owner saw. The stub
   * rounds the way a browser does, so the test fails if the remainder is ever
   * kept anywhere the browser can round it.
   */
  const rounding = {
    real: 0,
    get scrollLeft() {
      return Math.round(this.real);
    },
    set scrollLeft(v) {
      this.real = v;
    },
  };
  const shelfDrift = createDrift(rounding, () => 1000);
  for (let frame = 0; frame < 60; frame++) shelfDrift.step(16.7);
  t.ok(rounding.scrollLeft >= 13 && rounding.scrollLeft <= 15,
    `a second of frames moves the shelf about 14px (moved ${rounding.scrollLeft})`);

  // The book page has to say when it could not take what was asked for; the
  // basket page always did, and the two disagreeing is the actual complaint.
  const bookSource = readFileSync('src/pages/book/[slug].astro', 'utf8');
  t.ok(bookSource.includes('addChecked') && bookSource.includes('id="addnote"'),
    'the book page adds against live stock and has somewhere to say so');
  t.ok(!readFileSync('src/pages/checkout.astro', 'utf8').includes('Math.max(0, p.available)'),
    'checkout no longer reads "availability unknown" as "none left"');

  const orphans = await one(
    `SELECT COUNT(*) AS n FROM order_items WHERE order_id NOT IN (SELECT id FROM orders)`,
  );
  t.ok(orphans.n === 0, 'no order items orphaned from their order');

  const drift = await db(
    `SELECT b.id FROM books b
      WHERE b.reserved != (SELECT COALESCE(SUM(delta),0) FROM stock_ledger
                            WHERE book_id=b.id AND field='reserved')
        AND b.id > 226`,
  );
  t.ok(drift.length === 0, 'the ledger agrees with reserved on every fixture');
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
async function lifecycle() {
  const t = suite('13. Lifecycle and collection wording');

  // Words that must never reach a collection customer or the owner's view of
  // one. This is the failure the owner actually reported.
  const POSTING = /posted|dispatch|on their way|Send to|Delivery to|tracking/i;

  // --- collection: requested -> awaiting_payment -> paid -> completed -------
  const cBook = await makeBook();
  const c = await placeOrder(cBook.id, 'collection');
  const cUrl = `/order?ref=${c.ref}&t=${c.token}`;

  const seen = [];
  const sweep = async (stage) => {
    const page = await html(cUrl);
    const portal = await html(`/admin/orders/${c.ref}`);
    /*
     * What is being checked is the *shop's* vocabulary, not the owner's. The
     * confirm box now carries their own drafts - a bank account's wording is
     * theirs to write, and may say anything - so it is cut out before the
     * sweep. Leaving it in made this fail on the word "posted" appearing inside
     * somebody's account details.
     */
    const ownWords = (markup) =>
      markup.replace(/<textarea[^>]*id="payment_message"[^>]*>[\s\S]*?<\/textarea>/, '');
    // The portal legitimately contains the word "Delete"; only the delivery
    // vocabulary is forbidden.
    const bad = [page, ownWords(portal)].map(visibleText).some((h) => POSTING.test(h));
    seen.push([stage, bad]);
    return { page, portal };
  };

  await sweep('requested');
  await admin(`/api/admin/orders/${c.ref}/confirm`, { payment_message: 'Pay into the shop account.' });
  await sweep('awaiting_payment');

  const cPaid = await admin(`/api/admin/orders/${c.ref}/status`, { status: 'paid' });
  t.ok(cPaid.status === 302 && !cPaid.location.includes('e=state'), 'collection: payment can be recorded');
  const readied = await sweep('paid');
  t.ok(readied.page.includes('Ready to collect'), 'collection: customer is told the books are ready');
  t.ok(!readied.page.includes('Total to pay'), 'collection: a paid order stops asking to be paid');
  t.ok(readied.page.includes('Total paid'), 'collection: and says what was paid instead');

  // The step the owner said was missing: it used to stop dead here.
  const cDone = await admin(`/api/admin/orders/${c.ref}/status`, { status: 'completed' });
  t.ok(cDone.status === 302 && !cDone.location.includes('e=state'), 'collection: can be marked collected');
  const done = await sweep('completed');
  t.ok(done.page.includes('Collected'), 'collection: final state reads Collected');

  for (const [stage, bad] of seen) {
    t.ok(!bad, `collection: no posting language at ${stage}`);
  }

  // --- cash on collection changes what the customer is told -----------------
  //
  // The owner ticks this on orders being paid in cash at the door. Nothing
  // about the money moves through the site either way; what changes is that the
  // customer is not told to go and pay something first.
  const cashBook = await makeBook();
  const cash = await placeOrder(cashBook.id, 'collection');
  const marked = await admin(`/api/admin/orders/${cash.ref}/cash-payment`, { cash_payment: '1' });
  t.ok(marked.status === 200, 'cash: a collection order can be marked as paying in cash');

  // The tick has to survive a page load, or the owner cannot tell whether it
  // took. It reached the database once while the checkbox that sets it was
  // dead in the browser, so the portal page is checked, not just the endpoint.
  const portalAfter = await html(`/admin/orders/${cash.ref}`);
  t.ok(/toggle-cash-payment[^>]*checked|checked[^>]*toggle-cash-payment/.test(portalAfter),
    'cash: the portal shows the tick after saving it');

  await admin(`/api/admin/orders/${cash.ref}/confirm`, { payment_message: 'Pay when you collect.' });

  // Every status is read as a whole page. The defect this guards against was
  // not a wrong string but two right ones contradicting each other: a heading
  // saying pay on collection above a total saying paid in full.
  const OWES = /Total to pay|Payable in cash when you collect/;
  const PAID_UP = /Total paid|Paid in full/;

  const arranging = visibleText(await html(`/order?ref=${cash.ref}&t=${cash.token}`));
  t.ok(arranging.includes('Ready to arrange collection'),
    'cash: the customer is asked to arrange a time, not to pay');
  t.ok(arranging.includes('We will set them aside and agree a time with you.'),
    'cash: and the timeline agrees, rather than waiting on a payment');
  t.ok(OWES.test(arranging) && !PAID_UP.test(arranging),
    'cash: nothing claims to be paid before they have been');

  await admin(`/api/admin/orders/${cash.ref}/status`, { status: 'paid' });
  const ready = visibleText(await html(`/order?ref=${cash.ref}&t=${cash.token}`));
  t.ok(/pay(ment can be made)? when you collect/i.test(ready),
    'cash: and told they can pay on collection');
  t.ok(ready.includes('Come and collect - you can pay when you arrive.'),
    'cash: the ready step says the money comes at the door');
  t.ok(!PAID_UP.test(ready),
    'cash: books ready is not the same as money received');

  await admin(`/api/admin/orders/${cash.ref}/status`, { status: 'completed' });
  const collected = visibleText(await html(`/order?ref=${cash.ref}&t=${cash.token}`));
  t.ok(collected.includes('Collected') && PAID_UP.test(collected),
    'cash: once collected, the money is real and the page says so');

  // The owner's own view must not chase money that is not late.
  const waitingBook = await makeBook();
  const waiting = await placeOrder(waitingBook.id, 'collection');
  await admin(`/api/admin/orders/${waiting.ref}/cash-payment`, { cash_payment: '1' });
  await admin(`/api/admin/orders/${waiting.ref}/confirm`, { payment_message: 'Cash on the day.' });
  const waitingPortal = visibleText(await html(`/admin/orders/${waiting.ref}`));
  t.ok(waitingPortal.includes('To arrange') && !waitingPortal.includes('Awaiting payment'),
    'cash: the portal calls it To arrange, not Awaiting payment');
  t.ok(waitingPortal.includes('Set aside for collection'),
    'cash: and offers setting the books aside rather than recording a payment');

  /*
   * Cash is no longer collection-only: a posted order marked cash is one handed
   * over in person. What must not happen is a delivery inheriting the
   * collection wording - it would tell somebody to come and collect books that
   * are being sent to them.
   */
  const postBook = await makeBook();
  const posted = await placeOrder(postBook.id, 'delivery');
  const allowed = await admin(`/api/admin/orders/${posted.ref}/cash-payment`, { cash_payment: '1' });
  t.ok(allowed.status === 200, 'cash: a posted order can be marked as paying in cash');

  await admin(`/api/admin/orders/${posted.ref}/confirm`, { postage: '3.95', payment_message: 'x' });
  const postedCash = visibleText(await html(`/order?ref=${posted.ref}&t=${posted.token}`));
  t.ok(/hand(ing)? them over|hand them over/.test(postedCash),
    'cash: a posted order talks about handing over, not collecting');
  t.ok(!/come and collect|Ready to collect|when you collect/i.test(postedCash),
    'cash: and never tells them to come and collect');

  const postedPortal = visibleText(await html(`/admin/orders/${posted.ref}`));
  t.ok(!postedPortal.includes('Payment received and posted'),
    'cash: the owner is not offered a button recording money that has not arrived');

  // An unknown reference is still a 404 - that guard was doing two jobs.
  const missing = await admin('/api/admin/orders/ASB-NOPE/cash-payment', { cash_payment: '1' });
  t.ok(missing.status === 404, 'cash: an unknown reference is still refused');

  /*
   * What the customer asked for at checkout is a request, not a decision: it
   * pre-sets the owner's tick and is shown to them, but the two live in
   * separate columns so a customer's click can never rewrite what the shop
   * actually sends.
   */
  const prefBook = await makeBook();
  const preferred = await placeOrder(prefBook.id, 'collection', { paymentPreference: 'cash' });
  const prefRow = await one(
    `SELECT payment_preference AS p, cash_payment AS c FROM orders WHERE ref='${preferred.ref}'`,
  );
  t.ok(prefRow.p === 'cash', 'the stated payment preference is kept');
  t.ok(prefRow.c === 1, 'and pre-ticks the cash box for the owner');
  t.ok(visibleText(await html(`/admin/orders/${preferred.ref}`)).includes('Asked to pay by'),
    'the owner is told what they asked for');

  const transferBook = await makeBook();
  const byTransfer = await placeOrder(transferBook.id, 'delivery', { paymentPreference: 'transfer' });
  const transferRow = await one(`SELECT cash_payment AS c FROM orders WHERE ref='${byTransfer.ref}'`);
  t.ok(transferRow.c === 0, 'asking to pay by transfer leaves the cash box alone');

  // Saying nothing is a valid answer - it is one more field between somebody
  // and a six pound book otherwise.
  const quietBook = await makeBook();
  const quiet = await placeOrder(quietBook.id, 'delivery');
  const quietRow = await one(`SELECT payment_preference AS p FROM orders WHERE ref='${quiet.ref}'`);
  t.ok(quietRow.p === null, 'saying nothing about payment is allowed');

  const badPref = await json('/api/orders', {
    name: 'A B', email: CUSTOMER_EMAIL, phone: '07700 900321', fulfilment: 'collection',
    paymentPreference: 'gold bars', items: [{ bookId: quietBook.id, qty: 1 }],
  });
  t.ok(badPref.status === 400 && badPref.body.field === 'paymentPreference',
    'but an invented preference is refused');

  // --- collection cannot be dispatched, however it is asked -----------------
  const cb2 = await makeBook();
  const c2 = await placeOrder(cb2.id, 'collection');
  await admin(`/api/admin/orders/${c2.ref}/confirm`, { payment_message: 'x' });
  const forced = await admin(`/api/admin/orders/${c2.ref}/status`, {
    status: 'dispatched',
    tracking: 'SNEAKY123',
  });
  const c2row = await one(`SELECT status, tracking_number AS tn FROM orders WHERE ref='${c2.ref}'`);
  t.ok(forced.location.includes('e=state'), 'collection: a dispatch posted by hand is refused');
  t.ok(c2row.status === 'awaiting_payment' && c2row.tn === null,
    'collection: and no tracking number is stored');

  // --- delivery: the combined payment-and-posted action ---------------------
  const dBook = await makeBook();
  const d = await placeOrder(dBook.id, 'delivery');
  await admin(`/api/admin/orders/${d.ref}/confirm`, { postage: '3.95', payment_message: 'Bank transfer.' });

  const held = await one(`SELECT reserved r, stock s FROM books WHERE id=${dBook.id}`);
  const combined = await admin(`/api/admin/orders/${d.ref}/status`, {
    status: 'dispatched',
    tracking: 'H00123456789',
    postage_provider: 'Evri',
    postage_service: 'Next day',
  });
  t.ok(combined.status === 302 && !combined.location.includes('e=state'),
    'delivery: payment and posting in one action');

  const dRow = await one(
    `SELECT status, paid_at pa, dispatched_at da, postage_provider pp FROM orders WHERE ref='${d.ref}'`,
  );
  t.ok(Boolean(dRow.pa) && Boolean(dRow.da), 'delivery: both timestamps are stamped together');
  t.ok(dRow.pp === 'Evri', 'delivery: the carrier is recorded');

  // The combined action must still take the copies off the shelf - skipping
  // 'paid' cannot mean skipping the sale.
  const sold = await one(`SELECT reserved r, stock s FROM books WHERE id=${dBook.id}`);
  t.ok(sold.s === held.s - 1 && sold.r === held.r - 1,
    'delivery: the combined action still converts the hold into a sale');

  const dPage = await html(`/order?ref=${d.ref}&t=${d.token}`);
  t.ok(dPage.includes('H00123456789'), 'delivery: the tracking number reaches the customer');
  t.ok(dPage.includes('evri.com'), 'delivery: and links to the right carrier, not Royal Mail');

  // DHL, for the orders going abroad.
  const dhlBook = await makeBook();
  const dhl = await placeOrder(dhlBook.id, 'delivery');
  await admin(`/api/admin/orders/${dhl.ref}/confirm`, { postage: '12.50', payment_message: 'x' });
  await admin(`/api/admin/orders/${dhl.ref}/status`, {
    status: 'dispatched', tracking: 'JD0140000012345678', postage_provider: 'DHL',
  });
  const dhlPage = await html(`/order?ref=${dhl.ref}&t=${dhl.token}`);
  t.ok(dhlPage.includes('dhl.com'), 'delivery: DHL is trackable, not just a name');
  // Above the timeline, where somebody comes back to look for it - it used to
  // sit in the quietest card on the page, below five steps.
  t.ok(dhlPage.indexOf('Track this parcel') < dhlPage.indexOf('>Progress<'),
    'delivery: tracking sits above the progress steps');

  // A wrong digit used to be permanent: the fields that capture it vanish with
  // the "mark as posted" action. Correcting it must not re-announce the parcel.
  const before = await one(`SELECT dispatched_at AS d FROM orders WHERE ref='${dhl.ref}'`);
  const fixed = await admin(`/api/admin/orders/${dhl.ref}/tracking`, {
    tracking: 'JD9999999999999999', postage_provider: 'DHL', postage_service: 'Express',
  });
  const after = await one(
    `SELECT tracking_number AS t, dispatched_at AS d FROM orders WHERE ref='${dhl.ref}'`,
  );
  t.ok(fixed.location.includes('saved=tracking'), 'a tracking number can be corrected afterwards');
  t.ok(after.t === 'JD9999999999999999' && after.d === before.d,
    'and the order is not dispatched a second time');

  /*
   * Cancelled orders kept advertising a tracking number they no longer had a
   * parcel for. The state is set directly because the portal will not take a
   * dispatched order to cancelled - it is reachable only on rows that predate
   * that rule, which is exactly why the page has to cope with it.
   */
  await db(`UPDATE orders SET status='cancelled' WHERE ref='${dhl.ref}'`);
  const cancelledPage = await html(`/order?ref=${dhl.ref}&t=${dhl.token}`);
  t.ok(!cancelledPage.includes('Track this parcel'),
    'a cancelled order stops showing tracking');
  t.ok(!cancelledPage.includes('Tracking number'),
    'in the timeline as well as at the top');

  // The picker and the tracking table have to stay in step, so anything not on
  // the list is refused rather than stored as an untrackable string.
  const madeUp = await makeBook();
  const bogus = await placeOrder(madeUp.id, 'delivery');
  await admin(`/api/admin/orders/${bogus.ref}/confirm`, { postage: '3.95', payment_message: 'x' });
  await admin(`/api/admin/orders/${bogus.ref}/status`, {
    status: 'dispatched', tracking: 'X1', postage_provider: 'Pigeon Post',
  });
  const stored = await one(`SELECT postage_provider AS p FROM orders WHERE ref='${bogus.ref}'`);
  t.ok(stored.p === null, 'a carrier that is not on the list is not stored');

  // The picker had no placeholder, so Royal Mail was submitted on every posting
  // whether anyone chose it or not.
  const noCarrierBook = await makeBook();
  const noCarrier = await placeOrder(noCarrierBook.id, 'delivery');
  await admin(`/api/admin/orders/${noCarrier.ref}/confirm`, { postage: '3.95', payment_message: 'x' });
  await admin(`/api/admin/orders/${noCarrier.ref}/status`, {
    status: 'dispatched', tracking: 'NOCARRIER1', postage_provider: '',
  });
  const blank = await one(`SELECT postage_provider AS p FROM orders WHERE ref='${noCarrier.ref}'`);
  t.ok(blank.p === null, 'leaving the carrier unset records no carrier, not Royal Mail');
  t.ok(!dPage.includes('Total to pay'), 'delivery: a paid order stops asking to be paid');

  const dDone = await admin(`/api/admin/orders/${d.ref}/status`, { status: 'completed' });
  t.ok(dDone.status === 302 && !dDone.location.includes('e=state'), 'delivery: can be marked delivered');
  t.ok((await html(`/order?ref=${d.ref}&t=${d.token}`)).includes('Delivered'),
    'delivery: final state reads Delivered');
}

// ---------------------------------------------------------------------------
async function botAndOptIn() {
  const t = suite('14. Telegram opt-in and the bot');

  // --- the Connect button, offered to everyone ------------------------------
  //
  // Checkout no longer asks for a username. It could not be trusted to decide
  // anything - a handle typed as "no thanks" counted as one - and the deep link
  // is the only way the bot may open a chat at all, so the invitation is now
  // shown to whoever has an order still waiting on a reply.
  const book = await makeBook();
  const fresh = () => `e2e-${Math.random().toString(36).slice(2, 8)}@example.com`;

  const invited = await placeOrder(book.id, 'delivery', { email: fresh() });
  t.ok((await html(`/order?ref=${invited.ref}&t=${invited.token}`)).includes('Connect Telegram'),
    'an unanswered order is invited to connect Telegram');

  // --- the invitation gives way to a confirmation ---------------------------
  //
  // Connecting happens inside the Telegram app, so the page has to be able to
  // tell it has happened; the owner reported still being asked to connect after
  // they had.
  // Its own listing: the shared one only stocks four copies and this suite
  // now places five orders.
  const linkBook = await makeBook();
  const link = await placeOrder(linkBook.id, 'collection', { email: fresh() });
  const linkUrl = `/order?ref=${link.ref}&t=${link.token}`;
  const beforeRaw = await html(linkUrl);
  const beforeLink = visibleText(beforeRaw);
  t.ok(beforeLink.includes('Get your payment details on Telegram'), 'before connecting, the invitation is shown');

  // Following the link in place lost the order page for anyone without
  // Telegram on that device, which on a laptop is most people.
  t.ok(/target="_blank"/.test(beforeRaw), 'the Telegram link opens away from the order page');
  // The fallback is a dialog now: closed until they tap Connect, and carrying
  // the QR for anyone whose device did nothing when they did.
  t.ok(/<dialog[^>]*id="connect-telegram"/.test(beforeRaw) && !/id="connect-telegram"[^>]*open/.test(beforeRaw),
    'and a dialog is ready for when nothing opens, closed until they try');
  t.ok(beforeRaw.includes('data:image/png;base64'), 'with a QR code inside it');

  const status = await (await get(`/api/orders/link-status?ref=${link.ref}&t=${link.token}`)).json();
  t.ok(status.linked === false, 'and the page can ask whether it has been connected');

  await fetch(`${SITE}/api/telegram/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': vars.TELEGRAM_WEBHOOK_SECRET },
    body: JSON.stringify({
      message: { message_id: 9, chat: { id: Number(TEST_CHAT) }, text: `/start ${link.ref}_${link.token.slice(0, 16)}` },
    }),
  });

  const afterLink = visibleText(await html(linkUrl));
  t.ok(!afterLink.includes('Get your payment details on Telegram'), 'after connecting, the invitation is gone');
  t.ok(afterLink.includes('Connected to Telegram'), 'and it says the chat is connected');
  const after = await (await get(`/api/orders/link-status?ref=${link.ref}&t=${link.token}`)).json();
  t.ok(after.linked === true, 'and the page would know to refresh');

  const guessed = await (await get(`/api/orders/link-status?ref=${link.ref}&t=deadbeefdeadbeef`)).json();
  t.ok(guessed.linked === false, 'a guessed token learns nothing from that check');

  // --- confirming twice sends once ------------------------------------------
  const race = await placeOrder(book.id, 'collection', { email: fresh() });
  const [a, b] = await Promise.all([
    admin(`/api/admin/orders/${race.ref}/confirm`, { payment_message: 'once' }),
    admin(`/api/admin/orders/${race.ref}/confirm`, { payment_message: 'once' }),
  ]);
  const wins = [a, b].filter((r) => r.location.includes('sent=')).length;
  const states = [a, b].filter((r) => r.location.includes('e=state')).length;
  t.ok(wins === 1 && states === 1, `confirming twice sends once (${wins} sent, ${states} refused)`);

  // --- what the owner actually typed is what gets stored --------------------
  const typed = await one(`SELECT payment_message AS m FROM orders WHERE ref='${race.ref}'`);
  t.ok(typed.m === 'once', 'the per-order payment message is kept on the order');

  // --- the bot ---------------------------------------------------------------
  const secret = vars.TELEGRAM_WEBHOOK_SECRET;
  const hook = (body) =>
    fetch(`${SITE}/api/telegram/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
      body: JSON.stringify(body),
    });

  await admin('/api/admin/settings', { contact_telegram: '@alsubkibooks' });

  // The webhook always returns 200 so Telegram stops retrying, so status tells
  // us nothing. What matters is whether anything was forwarded, which the proof
  // counter records.
  const proofsBefore = (await one('SELECT COALESCE(SUM(payment_proofs),0) AS n FROM orders')).n;

  await hook({ message: { message_id: 1, chat: { id: 999111222 }, text: 'hello?' } });
  await hook({ message: { message_id: 2, chat: { id: 999111222 }, photo: [{ file_id: 'x' }] } });

  const proofsAfterStranger = (await one('SELECT COALESCE(SUM(payment_proofs),0) AS n FROM orders')).n;
  t.ok(proofsAfterStranger === proofsBefore,
    'a stranger cannot pipe photos through the bot to the owner');

  // Bind a chat, then send a screenshot as a paying customer would.
  const shot = await placeOrder(book.id, 'collection', { email: fresh() });
  await hook({
    message: { message_id: 3, chat: { id: Number(TEST_CHAT) }, text: `/start ${shot.ref}_${shot.token.slice(0, 16)}` },
  });
  await admin('/api/admin/settings', { contact_telegram: '@alsubkibooks' });
  await db(`INSERT INTO settings (key, value, updated_at)
            VALUES ('owner_telegram_chat_id', '${TEST_CHAT}', unixepoch())
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`);

  await hook({
    message: {
      message_id: 4,
      chat: { id: Number(TEST_CHAT) },
      photo: [{ file_id: 'proof' }],
      caption: 'paid this morning',
    },
  });
  const proofs = await one(`SELECT COALESCE(payment_proofs,0) AS p FROM orders WHERE ref='${shot.ref}'`);
  t.ok(proofs.p === 1, 'a screenshot from a linked chat is passed to the owner');

  // A chat whose only order is finished has nothing live to attach a payment
  // to, so the bot must not forward for it either.
  await db(`UPDATE orders SET status='completed', completed_at=unixepoch() WHERE ref='${shot.ref}'`);
  await db(`UPDATE orders SET telegram_chat_id = NULL
             WHERE telegram_chat_id = '${TEST_CHAT}' AND ref <> '${shot.ref}'`);
  const beforeFinished = (await one('SELECT COALESCE(SUM(payment_proofs),0) AS n FROM orders')).n;
  await hook({
    message: { message_id: 5, chat: { id: Number(TEST_CHAT) }, photo: [{ file_id: 'late' }] },
  });
  const afterFinished = (await one('SELECT COALESCE(SUM(payment_proofs),0) AS n FROM orders')).n;
  t.ok(afterFinished === beforeFinished, 'a finished order takes no further screenshots');

  await db(`DELETE FROM settings WHERE key='owner_telegram_chat_id'`);
}

// The third field says whether the suite needs a signed-in portal session.
// Everything that builds a fixture listing does; the public pages and the
// checks that admin routes stay shut do not.
const SUITES = [
  ['catalogue', publicCatalogue, false], ['legacy', legacyUrls, false],
  ['validation', validation, true], ['stock', stockAndHolds, true],
  ['fulfilment', fulfilment, true], ['lookup', orderPageAndLookup, true],
  ['auth', adminAuth, false], ['listings', listings, true],
  ['shelves', shelves, true], ['orders', portalOrders, true],
  ['notifications', notifications, true], ['lifecycle', lifecycle, true],
  ['bot', botAndOptIn, true], ['group', groupOrders, true],
  ['settings', ownerSettings, true],
  ['integrity', integrity, false],
];

console.log(`\nRunning against ${PROD ? `\x1b[33m${SITE} (REAL)\x1b[0m` : SITE}`);
if (PROD) console.log(`  channel ${prodVars.TELEGRAM_CHANNEL_ID}  ·  owner ${prodVars.OWNER_EMAIL}`);

/*
 * Email is a metered resource, and a full run is about 38 messages - most of a
 * day's free allowance. Spending it on tests means a real customer's
 * confirmation silently fails, so the cost is stated up front and production
 * has to be asked for explicitly.
 *
 * Locally EMAIL_DRY_RUN=1 makes sends free, and the run refuses to start
 * without it rather than quietly billing the shop for a development loop.
 */
const forReal = process.argv.includes('--send-for-real');

if (!PROD && vars.EMAIL_DRY_RUN !== '1' && !forReal) {
  console.log(
    '\n  \x1b[31mrefusing to run\x1b[0m - a local run would send ~38 real emails.' +
      '\n  Add EMAIL_DRY_RUN=1 to .dev.vars, or pass --send-for-real if you mean it.\n',
  );
  process.exit(1);
}

if (PROD && !only && !forReal) {
  console.log(
    '\n  \x1b[33ma full production run sends ~38 real emails\x1b[0m against a 100/day quota.' +
      '\n  Pass --send-for-real to confirm, or --only=<suite> to test one area.\n',
  );
  process.exit(1);
}

// Without a session the portal suites cannot build their fixtures. Rather than
// abort, run the ones that need no sign-in and say plainly which were skipped -
// a partial run is worth having, as long as it can never be read as a full one.
const signedIn = await signIn();
if (!signedIn) {
  console.log(
    '\n  \x1b[31mnot signed in\x1b[0m - ADMIN_PASSWORD in .dev.vars is not the one ' +
      `${PROD ? 'production' : 'this environment'} expects.\n` +
      '  Running only the suites that need no portal session.',
  );
}

let orphanedMessages = [];
const skipped = [];
try {
  for (const [name, fn, needsAuth] of SUITES) {
    if (!wanted(name)) continue;
    if (needsAuth && !signedIn) {
      skipped.push(name);
      continue;
    }
    try {
      await fn();
    } catch (err) {
      suite(`${name} (crashed)`).ok(false, String(err).split('\n')[0]);
    }
  }
} finally {
  console.log('\nTidying up');
  orphanedMessages = await teardown();
  const left = await one(
    `SELECT (SELECT COUNT(*) FROM books WHERE id > 226) AS fixtures,
            (SELECT COALESCE(SUM(reserved),0) FROM books) AS held`,
  );
  console.log(`  fixtures left: ${left.fixtures}   stock still held: ${left.held}`);
  if (orphanedMessages.length) {
    console.log(`  \x1b[31mchannel messages to delete by hand: ${orphanedMessages.join(', ')}\x1b[0m`);
  }
}

if (skipped.length) {
  console.log(`  \x1b[33mskipped (no portal session): ${skipped.join(', ')}\x1b[0m`);
}

// A run that could not sign in is not a pass, however green the rest looks.
process.exit(report() || skipped.length ? 1 : 0);
