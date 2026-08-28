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
  suite, report, db, one, signIn, admin, get, html, json,
  created, makeBook, placeOrder, teardown,
} from './lib/e2e-helpers.mjs';

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
  const cases = [
    [{ name: '', email: CUSTOMER_EMAIL, fulfilment: 'collection' }, 'a missing name'],
    [{ name: 'A B', email: 'not-an-email', fulfilment: 'collection' }, 'an invalid email'],
    [{ name: 'A B', email: CUSTOMER_EMAIL, fulfilment: 'delivery' }, 'delivery without an address'],
  ];
  for (const [payload, label] of cases) {
    const r = await json('/api/orders', { ...payload, items: [{ bookId: book.id, qty: 1 }] });
    t.ok(r.status === 400, `refuses ${label}`);
  }
  const empty = await json('/api/orders', {
    name: 'A B', email: CUSTOMER_EMAIL, fulfilment: 'collection', items: [],
  });
  t.ok(empty.status === 400, 'refuses an empty basket');

  const tooMany = await json('/api/orders', {
    name: 'A B', email: CUSTOMER_EMAIL, fulfilment: 'collection',
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
        name: 'Racer', email: CUSTOMER_EMAIL, fulfilment: 'collection',
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
async function integrity() {
  const t = suite('12. Data integrity');
  const bad = await db(
    `SELECT b.id FROM books b WHERE (b.stock - b.reserved) < 0`,
  );
  t.ok(bad.length === 0, 'no book has negative availability');

  const dupes = await db(`SELECT slug FROM books GROUP BY slug HAVING COUNT(*) > 1`);
  t.ok(dupes.length === 0, 'no duplicate slugs');

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
// The third field says whether the suite needs a signed-in portal session.
// Everything that builds a fixture listing does; the public pages and the
// checks that admin routes stay shut do not.
const SUITES = [
  ['catalogue', publicCatalogue, false], ['legacy', legacyUrls, false],
  ['validation', validation, true], ['stock', stockAndHolds, true],
  ['fulfilment', fulfilment, true], ['lookup', orderPageAndLookup, true],
  ['auth', adminAuth, false], ['listings', listings, true],
  ['shelves', shelves, true], ['orders', portalOrders, true],
  ['notifications', notifications, true], ['integrity', integrity, false],
];

console.log(`\nRunning against ${PROD ? `\x1b[33m${SITE} (REAL)\x1b[0m` : SITE}`);
if (PROD) console.log(`  channel ${prodVars.TELEGRAM_CHANNEL_ID}  ·  owner ${prodVars.OWNER_EMAIL}`);

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
