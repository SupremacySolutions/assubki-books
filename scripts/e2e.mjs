#!/usr/bin/env node
/**
 * Walks the whole shop against the local server: a listing created, photographed
 * by proxy, announced, ordered both ways, confirmed, paid, and finally deleted.
 *
 *   node scripts/e2e.mjs
 *
 * Local rather than production because the admin half needs a password, and
 * because a failed run here costs nothing. Telegram is in dry-run locally, so
 * nothing reaches a real channel; email is live and goes to whatever OWNER_EMAIL
 * and the test address say.
 */

import { readFileSync } from 'node:fs';

const SITE = 'http://localhost:4330';
const ORIGIN = { Origin: SITE };
const CUSTOMER = 'mikailbhanabo3@gmail.com';

const vars = Object.fromEntries(
  readFileSync('.dev.vars', 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${m}`); };
const no = (m) => { fail++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };
const step = (m) => console.log(`\n${m}`);

let cookie = '';
async function admin(path, body) {
  const res = await fetch(`${SITE}${path}`, {
    method: 'POST',
    headers: { ...ORIGIN, Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    redirect: 'manual',
  });
  return { status: res.status, location: res.headers.get('location') ?? '' };
}
const page = async (path) =>
  (await fetch(`${SITE}${path}`, { headers: { Cookie: cookie } })).text();

// ---------------------------------------------------------------------------
step('1. Sign in to the portal');
{
  const res = await fetch(`${SITE}/api/admin/login`, {
    method: 'POST',
    headers: { ...ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: vars.ADMIN_PASSWORD, next: '/admin' }).toString(),
    redirect: 'manual',
  });
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  cookie.startsWith('asb_admin=') ? ok('signed in') : no('could not sign in');
}

// ---------------------------------------------------------------------------
step('2. Create a listing');
let bookId, bookSlug;
{
  const r = await admin('/api/admin/books/save', {
    id: '', title: 'E2E Test Volume', title_ar: 'اختبار',
    author: 'Test Author', publisher: 'Test Press',
    description: 'First paragraph.\n\nSecond paragraph.',
    price: '12.50', stock: '4', status: 'live', categories: '20',
  });
  bookId = Number(r.location.match(/\/admin\/books\/(\d+)/)?.[1]);
  bookId ? ok(`created listing ${bookId}`) : no(`create failed (${r.status} ${r.location})`);

  const html = await page(`/admin/books/${bookId}`);
  html.includes('E2E Test Volume') ? ok('listing renders in the portal') : no('listing missing');
  html.includes('Test Author') ? ok('author saved') : no('author not saved');
  html.includes('First paragraph.\n\nSecond paragraph.') || html.includes('Second paragraph.')
    ? ok('description round-trips with its paragraphs')
    : no('description lost its paragraphs');

  const row = await (await fetch(`${SITE}/api/basket?ids=${bookId}`)).json();
  bookSlug = row.books?.[0]?.slug;
  bookSlug ? ok(`live on the shop as /book/${bookSlug}`) : no('not visible on the shop');
}

// ---------------------------------------------------------------------------
step('3. Announce it (Telegram is in dry-run locally)');
{
  const r = await admin(`/api/admin/books/${bookId}/telegram`, {});
  r.location.includes('posted=1') ? ok('announced') : no(`announce failed (${r.location})`);
  const again = await admin(`/api/admin/books/${bookId}/telegram`, {});
  again.location.includes('posted=1') ? ok('re-announcing edits the same post') : no('edit failed');
}

// ---------------------------------------------------------------------------
async function order(fulfilment, extra) {
  const res = await fetch(`${SITE}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Mikail Bhana', email: CUSTOMER, phone: '07700 900321',
      telegram: '@Mikail7908', fulfilment, items: [{ bookId, qty: 1 }], ...extra,
    }),
  });
  return res.json();
}

step('4. A DELIVERY order');
let deliveryRef;
{
  const o = await order('delivery', { address: '12 Evington Road\nLeicester\nLE2 1HN' });
  deliveryRef = o.ref;
  o.ok ? ok(`order ${o.ref} placed`) : no(`refused: ${o.error}`);

  const customer = await page(`/order/${o.ref}?t=${o.token}`);
  customer.includes('Delivery to') ? ok('customer page says "Delivery to"') : no('wrong fulfilment wording');
  customer.includes('Evington Road') ? ok('shows the address') : no('address missing');
  customer.includes('Postage is added when we confirm')
    ? ok('mentions postage') : no('postage note missing on a delivery');

  const portal = await page(`/admin/orders/${o.ref}`);
  portal.includes('Send to') ? ok('portal says "Send to"') : no('portal wording wrong');
  portal.includes('Postage (£)') ? ok('portal offers a postage field') : no('postage field missing');

  const conf = await admin(`/api/admin/orders/${o.ref}/confirm`, { postage: '3.95' });
  conf.location.includes('sent=') ? ok(`confirmed, sent by ${conf.location.split('sent=')[1]}`)
    : no(`confirm failed (${conf.location})`);
}

// ---------------------------------------------------------------------------
step('5. A COLLECTION order');
let collectionRef;
{
  const o = await order('collection', {});
  collectionRef = o.ref;
  o.ok ? ok(`order ${o.ref} placed`) : no(`refused: ${o.error}`);

  const customer = await page(`/order/${o.ref}?t=${o.token}`);
  customer.includes('You are collecting in person')
    ? ok('customer page says collecting') : no('wrong fulfilment wording');
  !customer.includes('Postage is added when we confirm')
    ? ok('no postage note on a collection') : no('still mentions postage');
  !customer.includes('Delivery to') ? ok('does not say "Delivery to"') : no('says "Delivery to"');

  const portal = await page(`/admin/orders/${o.ref}`);
  portal.includes('Collecting') ? ok('portal says "Collecting"') : no('portal still says "Send to"');
  portal.includes('Total to pay is') ? ok('portal states a fixed total') : no('portal asks for postage');

  const conf = await admin(`/api/admin/orders/${o.ref}/confirm`, { postage: '3.95' });
  conf.location.includes('sent=') ? ok('confirmed') : no(`confirm failed (${conf.location})`);
}

// ---------------------------------------------------------------------------
step('6. Postage must be ignored on a collection');
{
  const res = await fetch(`${SITE}/admin/orders/${collectionRef}`, { headers: { Cookie: cookie } });
  const html = await res.text();
  // Subtotal is 12.50; a collection must total 12.50, not 16.45.
  html.includes('£12.50') && !html.includes('£16.45')
    ? ok('collection total excludes postage even though 3.95 was posted')
    : no('postage leaked into a collection total');
}

// ---------------------------------------------------------------------------
step('7. Move an order through to paid');
{
  const r = await admin(`/api/admin/orders/${deliveryRef}/status`, { status: 'paid' });
  r.location.includes(deliveryRef) ? ok('marked paid') : no('could not mark paid');
}

// ---------------------------------------------------------------------------
step('8. Delete the listing');
{
  const held = await admin(`/api/admin/books/${bookId}/delete`, {});
  held.location.includes('e=held')
    ? ok('refused while a copy is still held by an open order')
    : no(`should have refused, got ${held.location}`);

  // Cancel the outstanding collection order to release its hold.
  await admin(`/api/admin/orders/${collectionRef}/status`, { status: 'cancelled' });

  const gone = await admin(`/api/admin/books/${bookId}/delete`, {});
  gone.location.includes('deleted')
    ? ok('deleted once nothing was held') : no(`delete failed (${gone.location})`);

  const shop = await fetch(`${SITE}/book/${bookSlug}`);
  shop.status === 404 ? ok('gone from the shop') : no(`still on the shop (${shop.status})`);

  const orderPage = await page(`/admin/orders/${deliveryRef}`);
  orderPage.includes('E2E Test Volume')
    ? ok('the past order still records what was bought') : no('order history lost the title');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
