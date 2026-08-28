/**
 * Shared machinery for the end-to-end suite.
 *
 * The same code runs locally and against production; only the base URL, the
 * database flag and the admin password differ. A suite that behaved
 * differently from the thing it tests is how regressions get through, so the
 * mode changes as little as possible.
 */

import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const PROD = process.argv.includes('--prod');
export const SITE = PROD ? 'https://assubkibooks.co.uk' : 'http://localhost:4330';
export const ORIGIN = { Origin: SITE };

export const vars = Object.fromEntries(
  readFileSync('.dev.vars', 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);

export const prodVars = JSON.parse(
  readFileSync('wrangler.jsonc', 'utf8').replace(/^\s*\/\/.*$/gm, ''),
).vars ?? {};

/** The owner's own chat, so the real payment DM has somewhere to land. */
export const TEST_CHAT = vars.TEST_TELEGRAM_CHAT_ID ?? '5253230054';

export const CUSTOMER_EMAIL = vars.TEST_CUSTOMER_EMAIL ?? 'mikailbhanabo3@gmail.com';

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', OFF = '\x1b[0m';
export const results = [];

export function suite(name) {
  const record = { name, pass: 0, fail: 0, failures: [] };
  results.push(record);
  console.log(`\n${name}`);
  return {
    ok(condition, message, detail) {
      if (condition) {
        record.pass++;
        console.log(`  ${GREEN}PASS${OFF} ${message}`);
      } else {
        record.fail++;
        record.failures.push(message);
        console.log(`  ${RED}FAIL${OFF} ${message}${detail ? `\n       ${DIM}${detail}${OFF}` : ''}`);
      }
    },
    note(message) {
      console.log(`  ${DIM}····${OFF} ${message}`);
    },
  };
}

export function report() {
  const pass = results.reduce((n, r) => n + r.pass, 0);
  const fail = results.reduce((n, r) => n + r.fail, 0);
  console.log(`\n${'─'.repeat(58)}`);
  for (const r of results) {
    const mark = r.fail ? `${RED}${r.fail} failed${OFF}` : `${GREEN}ok${OFF}`;
    console.log(`  ${r.name.padEnd(34)} ${String(r.pass).padStart(3)} passed   ${mark}`);
  }
  console.log(`${'─'.repeat(58)}\n  ${pass} passed, ${fail} failed  (${PROD ? 'PRODUCTION' : 'local'})\n`);
  return fail;
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

/** Runs SQL against whichever database this mode is testing. */
export async function db(sql) {
  const { stdout } = await execFileAsync('npx', [
    'wrangler', 'd1', 'execute', 'assubki-books',
    PROD ? '--remote' : '--local', '--json', '--command', sql,
  ], { maxBuffer: 20 * 1024 * 1024 });

  const parsed = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new Error(parsed.error?.text ?? 'query failed');
  return parsed.flatMap((r) => r.results ?? []);
}

export const one = async (sql) => (await db(sql))[0] ?? {};

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

let cookie = '';

export async function signIn() {
  const password = PROD ? vars.ADMIN_PASSWORD_PROD : vars.ADMIN_PASSWORD;
  if (!password) throw new Error(`no ${PROD ? 'ADMIN_PASSWORD_PROD' : 'ADMIN_PASSWORD'} in .dev.vars`);

  const res = await fetch(`${SITE}/api/admin/login`, {
    method: 'POST',
    headers: { ...ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password, next: '/admin' }).toString(),
    redirect: 'manual',
  });
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  return cookie.startsWith('asb_admin=');
}

/** A form POST to the portal, as a browser would send it. */
export async function admin(path, body = {}) {
  const res = await fetch(`${SITE}${path}`, {
    method: 'POST',
    headers: { ...ORIGIN, Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    redirect: 'manual',
  });
  return { status: res.status, location: res.headers.get('location') ?? '' };
}

export async function get(path, opts = {}) {
  return fetch(`${SITE}${path}`, { headers: { Cookie: cookie }, redirect: 'manual', ...opts });
}

export const html = async (path) => (await get(path, { redirect: 'follow' })).text();

export async function json(path, body) {
  const res = await fetch(`${SITE}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// ---------------------------------------------------------------------------
// Fixtures
//
// Nothing here touches the 226 real listings. Everything the run creates is
// tracked so it can be removed again, including on failure.
// ---------------------------------------------------------------------------

export const created = { books: [], orders: [], shelves: [] };

export async function makeBook(overrides = {}) {
  const fields = {
    id: '',
    title: `E2E ${Math.random().toString(36).slice(2, 7)}`,
    title_ar: 'اختبار',
    author: 'Test Author',
    publisher: 'Test Press',
    description: 'First paragraph.\n\nSecond paragraph.',
    price: '12.50',
    stock: '4',
    status: 'live',
    categories: '20',
    ...overrides,
  };
  const r = await admin('/api/admin/books/save', fields);
  const id = Number(r.location.match(/\/admin\/books\/(\d+)/)?.[1]);
  if (id) created.books.push(id);
  return { id, title: fields.title };
}

export async function placeOrder(bookId, fulfilment = 'delivery', extra = {}) {
  const { body } = await json('/api/orders', {
    name: 'Mikail Bhana',
    email: CUSTOMER_EMAIL,
    phone: '07700 900321',
    telegram: '@Mikail7908',
    fulfilment,
    ...(fulfilment === 'delivery' ? { address: '12 Evington Road\nLeicester\nLE2 1HN' } : {}),
    items: [{ bookId, qty: 1 }],
    ...extra,
  });
  if (body.ref) created.orders.push(body.ref);
  return body;
}

/**
 * Removes everything the run made.
 *
 * Orders go first so their holds are released before the books they point at
 * disappear. Channel messages are removed through the delete endpoint, which
 * is also the thing being tested; anything it could not remove is named rather
 * than left silently in the channel.
 */
export async function teardown() {
  const orphans = [];

  for (const ref of created.orders) {
    await admin(`/api/admin/orders/${ref}/delete`).catch(() => {});
  }

  for (const id of created.books) {
    const messageId = (await one(`SELECT telegram_message_id AS m FROM books WHERE id = ${id}`)).m;
    const r = await admin(`/api/admin/books/${id}/delete`).catch(() => ({ location: '' }));
    if (r.location?.includes('deleted-orphan') && messageId) {
      orphans.push(messageId);
    }
    // Belt and braces: if the endpoint refused for any reason, the fixture must
    // still not survive the run.
    await db(`DELETE FROM books WHERE id = ${id}`).catch(() => {});
  }

  for (const id of created.shelves) {
    await admin('/api/admin/shelves/delete', { id }).catch(() => {});
    await db(`DELETE FROM categories WHERE id = ${id}`).catch(() => {});
  }

  await db(
    `DELETE FROM order_items WHERE order_id NOT IN (SELECT id FROM orders);
     UPDATE books SET reserved = 0 WHERE reserved > 0 AND id > 226;`,
  ).catch(() => {});

  return orphans;
}
