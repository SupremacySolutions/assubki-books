/** Shared helpers for the owned, disposable local E2E environment. */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify, parseEnv } from 'node:util';

const execFileAsync = promisify(execFile);

// This suite changes catalogue rows, settings and holds. It is only safe in
// the fresh environment owned by run-e2e, never a developer or live database.
if (process.argv.includes('--prod') || !process.env.ASSUBKI_E2E_ROOT ||
    resolve(process.env.ASSUBKI_E2E_ROOT) !== process.cwd() ||
    readFileSync('.e2e-owned', 'utf8') !== process.env.ASSUBKI_E2E_TOKEN) {
  throw new Error('Run npm run test:e2e; direct or production mutation runs are disabled.');
}
export const PROD = false;
export const SITE = process.env.E2E_SITE;
if (!SITE || new URL(SITE).hostname !== '127.0.0.1' || new URL(SITE).protocol !== 'http:') throw new Error('E2E requires its owned loopback server.');
export const ORIGIN = { Origin: SITE };
export const vars = parseEnv(readFileSync('.dev.vars', 'utf8'));
if (vars.EMAIL_DRY_RUN !== '1' || vars.TELEGRAM_DRY_RUN !== '1') throw new Error('Both notification dry-run flags are required.');

// Bound all requests, including direct fetch calls in e2e.mjs. Do not retry
// mutations: a server can commit a write before returning a failed response.
const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, init = {}) => nativeFetch(url, {
  ...init, signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
});

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

/**
 * The local D1 file miniflare keeps, found once.
 *
 * One `.sqlite` in that directory is the database and the other is miniflare's
 * own metadata; the database is the one that is not called `metadata`.
 */
let localDbPath;
function localDb() {
  if (localDbPath) return localDbPath;
  const dir = '.wrangler/state/v3/d1/miniflare-D1DatabaseObject';
  const files = readdirSync(dir).filter((f) => f.endsWith('.sqlite') && !f.startsWith('metadata'));
  if (files.length !== 1) throw new Error(`Expected one owned D1 database, found ${files.length}`);
  const file = files[0];
  if (!file) throw new Error(`no local D1 database under ${dir} - has the dev server ever run?`);
  localDbPath = join(dir, file);
  return localDbPath;
}

/*
 * Three pragmas, all needed, none of them printing anything.
 *
 * `foreign_keys=ON` because the sqlite3 CLI leaves them **off** and D1 does
 * not. Without it `ON DELETE CASCADE` silently does nothing: deleting an order
 * leaves its messages, deleting a set leaves its per-volume stock, and the next
 * run trips over rows that should not exist. Getting this wrong does not fail
 * loudly - it fails one run later, somewhere else.
 *
 * `trusted_schema=ON` because this schema has FTS triggers on `books`: with it
 * off - which is the default in the system sqlite3 on macOS - any write to
 * `books` fails with "unsafe use of virtual table books_fts", and the suite
 * cannot create so much as a fixture listing.
 *
 * `.timeout` rather than `PRAGMA busy_timeout`, because the pragma returns a
 * row and would land in the middle of the results. The dev server is writing
 * to the same file, so waiting rather than failing is the whole point.
 */
/**
 * The wrangler binary, not `npx wrangler`.
 *
 * npx re-resolves the package on every invocation - about 0.7s of the 2.7s a
 * call used to take, spent proving again what it proved a moment ago. The
 * binary is right there in node_modules.
 */
const WRANGLER_BIN = new URL('../../node_modules/.bin/wrangler', import.meta.url).pathname;

const SQLITE_FLAGS = [
  '-readonly', '-json',
  '-cmd', 'PRAGMA foreign_keys=ON',
  '-cmd', 'PRAGMA trusted_schema=ON',
  '-cmd', '.timeout 8000',
];

/**
 * Runs SQL against whichever database this mode is testing.
 *
 * Locally this talks to the SQLite file directly. It used to shell out to
 * `npx wrangler d1 execute` for every query - a node launch, an npx resolve
 * and a miniflare boot, about a second and a half each, hundreds of times a
 * run. Worse than slow, it was unreliable: one launch failing took a whole
 * suite down with "Command failed: npx wrangler d1 execute" and no reason,
 * and the fixtures it had made were then left behind to fail the *next* run
 * on rubbish rather than code. The same failure reproduced on commits that
 * predate any of this year's features, so it was never anybody's bug - just
 * the cost of the approach.
 *
 * The file is WAL, so reading and writing beside a running dev server is
 * exactly what SQLite is built for.
 *
 * Production still goes through wrangler, because there is no file to open -
 * and keeps the retry, since that path is a network call.
 */
/**
 * Whether a statement wants the write lock.
 *
 * Reads and writes are treated differently below, and getting this wrong in the
 * safe direction only costs speed, so anything that is not plainly a SELECT is
 * assumed to write.
 */
const READ_ONLY = /^\s*(SELECT|PRAGMA|EXPLAIN)\b/i;

export async function db(sql) {
  if (PROD) return viaWrangler(sql, '--remote');

  // Read-only SQLite connections are cheap for assertions. Mutations use
  // Wrangler's local D1 interface; it is a separate runtime, not the server's
  // transaction queue, so any concurrency failure must remain visible.
  if (READ_ONLY.test(sql)) {
    try {
      const { stdout } = await execFileAsync('sqlite3', [...SQLITE_FLAGS, localDb(), sql], {
        timeout: 60000, maxBuffer: 40 * 1024 * 1024,
      });
      return parseSqlite(stdout);
    } catch (err) {
      // sqlite3 says exactly what was wrong on stderr. Passing that on is the
      // difference between "Command failed" and "UNIQUE constraint failed".
      const why = (err.stderr || err.stdout || '').trim().split('\n')[0];
      throw new Error(`${why || err.message.split('\n')[0]}\n       in: ${sql.replace(/\s+/g, ' ').slice(0, 160)}`);
    }
  }

  return viaWrangler(sql, '--local');
}

// Do not replay multi-statement mutations after an ambiguous failure: some
// statements may already have committed. Keep the failure visible to the suite.
async function viaWrangler(sql, where) {
  const { stdout } = await execFileAsync(WRANGLER_BIN, [
    'd1', 'execute', 'assubki-books', where, '--json', '--command', sql,
  ], { timeout: 60000, maxBuffer: 40 * 1024 * 1024 });
  const parsed = JSON.parse(stdout);
  if (!Array.isArray(parsed) || parsed.some(r => r.success === false)) throw new Error('D1 fixture query failed');
  return parsed.flatMap(r => r.results ?? []);
}

/**
 * `sqlite3 -json` prints one array per statement that returned rows, so a
 * two-statement command prints two arrays back to back and the whole thing is
 * not valid JSON. Statements that return nothing print nothing at all.
 *
 * Flattened, to match what the wrangler path returns.
 */
function parseSqlite(stdout) {
  const text = stdout.trim();
  if (!text) return [];
  /*
   * A query plan is drawn, not returned.
   *
   * `EXPLAIN QUERY PLAN` is the one read whose output ignores `-json`: the
   * shell renders it as a tree whatever mode it is in. Handing those lines
   * back as `{ detail }` is the shape wrangler already returns for the same
   * query, so a test that asserts on a plan reads the same locally and
   * against production.
   */
  if (text.startsWith('QUERY PLAN')) {
    return text
      .split('\n')
      .slice(1)
      .map((line) => ({ detail: line.replace(/^[\s|`+-]*/, '').trim() }))
      .filter((row) => row.detail);
  }
  try {
    return JSON.parse(text);
  } catch {
    const rows = [];
    for (const chunk of text.split(/\]\s*\[/)) {
      const json = chunk.startsWith('[') ? chunk : `[${chunk}`;
      rows.push(...JSON.parse(json.endsWith(']') ? json : `${json}]`));
    }
    return rows;
  }
}

export const one = async (sql) => (await db(sql))[0] ?? {};

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

let cookie = '';

export async function signIn() {
  // ADMIN_PASSWORD_PROD lets local and production differ; when only one
  // password is kept, ADMIN_PASSWORD is it. A wrong guess just fails sign-in
  // and the run stops, so falling back costs nothing.
  const password = PROD
    ? (vars.ADMIN_PASSWORD_PROD ?? vars.ADMIN_PASSWORD)
    : vars.ADMIN_PASSWORD;
  if (!password) throw new Error('no ADMIN_PASSWORD in .dev.vars');

  const res = await fetch(`${SITE}/api/admin/login`, {
    method: 'POST',
    headers: { ...ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password, next: '/admin' }).toString(),
    redirect: 'manual',
  });
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  return cookie.startsWith('asb_admin=');
}

/**
 * The signed-in cookie, for a request this file cannot shape for you.
 *
 * `admin()` builds its body from an object, which cannot express a repeated
 * field - and a form with one row per book sends `row` many times. Rather than
 * widen that helper for one caller, this exposes the cookie so a suite can
 * build its own body and still be signed in.
 */
export const adminCookie = () => cookie;

// Failed HTTP responses are evidence. Never replay a write to hide a 500.
const fetchSettling = (url, init) => fetch(url, init);

export async function admin(path, body = {}) {
  const res = await fetchSettling(`${SITE}${path}`, {
    method: 'POST',
    headers: { ...ORIGIN, Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    redirect: 'manual',
  });
  return { status: res.status, location: res.headers.get('location') ?? '' };
}

/**
 * A multipart POST to the portal, for endpoints that take a file. `admin()`
 * url-encodes its body, which cannot carry one.
 */
export async function adminUpload(path, form) {
  const res = await fetchSettling(`${SITE}${path}`, {
    method: 'POST',
    headers: { ...ORIGIN, Cookie: cookie },
    body: form,
    redirect: 'manual',
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

export async function get(path, opts = {}) {
  return fetchSettling(`${SITE}${path}`, { headers: { Cookie: cookie }, redirect: 'manual', ...opts });
}

export const html = async (path) => (await get(path, { redirect: 'follow' })).text();

/**
 * Just the words a person would read.
 *
 * Sweeping raw HTML for forbidden wording matches the stylesheet - Tailwind
 * ships a `--tracking-tight` custom property, so a search for "tracking" hits
 * every page ever served. Style and script blocks go first, then the tags.
 */
export const visibleText = (markup) =>
  markup
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ');

export async function json(path, body) {
  const res = await fetchSettling(`${SITE}${path}`, {
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

/**
 * The last id in the real catalogue. Anything above it was made by a test.
 *
 * The number was already hard-coded in two places; naming it once means the
 * sweep and the "fixtures left" count cannot drift apart.
 */
export const REAL_CATALOGUE = 226;

export const created = { books: [], orders: [], shelves: [], groups: [] };

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
    fulfilment,
    ...(fulfilment === 'delivery'
      ? { line1: '12 Evington Road', city: 'Leicester', postcode: 'LE2 1HN', country: 'GB' }
      : {}),
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
/**
 * Removes one object from the bucket.
 *
 * For fixtures that deliberately imitate something the shop would have done -
 * the retention sweep, say - and so have to do the other half of it too.
 */
export async function deleteObject(key) {
  await execFileAsync(WRANGLER_BIN, [
    'r2', 'object', 'delete', `assubki-books-uploads/${key}`,
    PROD ? '--remote' : '--local',
  ]).catch(() => {});
}

export async function teardown() {
  const orphans = [];

  for (const ref of created.orders) {
    await admin(`/api/admin/orders/${ref}/delete`).catch(() => {});
  }

  // Group baskets hold no stock, so they only have to stop existing - but they
  // point at books, and a fixture cannot be deleted while a line still refers
  // to it. Hence before the books, not after.
  for (const code of created.groups) {
    await db(
      `DELETE FROM group_basket_items WHERE group_id IN (SELECT id FROM group_baskets WHERE code = '${code}');
       DELETE FROM group_baskets WHERE code = '${code}';`,
    ).catch(() => {});
  }

  for (const id of created.books) {
    const messageId = (await one(`SELECT telegram_message_id AS m FROM books WHERE id = ${id}`)).m;
    const r = await admin(`/api/admin/books/${id}/delete`).catch(() => ({ location: '' }));
    if (r.location?.includes('deleted-orphan') && messageId) {
      orphans.push(messageId);
    }
    // The bulk fixture sweep below handles any refused deletions in one D1
    // invocation, rather than booting Wrangler again for every fixture.
  }

  for (const id of created.shelves) {
    await admin('/api/admin/shelves/delete', { id }).catch(() => {});
    await db(`DELETE FROM categories WHERE id = ${id}`).catch(() => {});
  }

  /*
   * The sweep, which does not depend on anything having been tracked.
   *
   * Everything above only removes what `created` knows about. Suites that build
   * fixtures in SQL - split-set pools, sales - never appear there, and a suite
   * that throws half way leaves rows it had not registered yet. Those survived
   * the run and then failed the *next* one's counts, which is the contamination
   * that made a whole run untrustworthy rather than one assertion.
   *
   * IDs above the fixed seed belong to fixtures ONLY in this disposable
   * database. The module's ownership guard must stay ahead of every mutation.
   */
  await db(
    `DELETE FROM order_items WHERE order_id NOT IN (SELECT id FROM orders);
     DELETE FROM orders WHERE id IN (
       SELECT o.id FROM orders o JOIN order_items oi ON oi.order_id = o.id
        WHERE oi.book_id > ${REAL_CATALOGUE}
     );
     DELETE FROM sale_items WHERE book_id > ${REAL_CATALOGUE};
     DELETE FROM books WHERE id > ${REAL_CATALOGUE};
     /* Attribution on a surviving line would hold a fixture sale hostage:
        order_items.sale_id references sales(id), so the sale cannot go while
        anything points at it. */
     UPDATE order_items SET sale_id = NULL
      WHERE sale_id IN (SELECT id FROM sales WHERE name LIKE 'E2E %');
     DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE name LIKE 'E2E %');
     DELETE FROM sales WHERE name LIKE 'E2E %';
     DELETE FROM book_set_stock WHERE set_id NOT IN (SELECT id FROM book_sets);`,
  ).catch(() => {});

  /*
   * And put `reserved` back to what the live orders actually account for.
   *
   * A fixture that reserved a copy of a *real* listing - a split-set probe, an
   * interrupted checkout - left that copy held for ever, because the reset only
   * ever touched fixture ids. Recomputing from the orders that remain is both
   * the correct number and self-healing, so a run that died half way does not
   * quietly take a book off the shop.
   */
  await db(
    `UPDATE books SET reserved = (
       SELECT COALESCE(SUM(oi.qty), 0)
         FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE oi.book_id = books.id AND oi.from_incoming = 0
          AND o.status IN ('requested','awaiting_payment','paid','dispatched')
     )
     WHERE reserved <> (
       SELECT COALESCE(SUM(oi.qty), 0)
         FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE oi.book_id = books.id AND oi.from_incoming = 0
          AND o.status IN ('requested','awaiting_payment','paid','dispatched')
     );`,
  ).catch(() => {});

  return orphans;
}
