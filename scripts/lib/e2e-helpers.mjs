/**
 * Shared machinery for the end-to-end suite.
 *
 * The same code runs locally and against production; only the base URL, the
 * database flag and the admin password differ. A suite that behaved
 * differently from the thing it tests is how regressions get through, so the
 * mode changes as little as possible.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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
  const file = readdirSync(dir).find((f) => f.endsWith('.sqlite') && !f.startsWith('metadata'));
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
const SQLITE_FLAGS = [
  '-json',
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
const READ_ONLY = /^\s*(SELECT|PRAGMA|EXPLAIN|WITH)\b/i;

export async function db(sql) {
  if (PROD) return viaWrangler(sql, '--remote');

  /*
   * Reads go straight at the file; writes go through wrangler.
   *
   * The file is WAL, and WAL is what makes a reader safe beside the dev
   * server - readers never block and are never blocked. Writers are a
   * different matter: SQLite allows one at a time, and miniflare does not wait
   * for it. When this suite held the write lock, the server's next query came
   * back `SQLITE_BUSY: database is locked`, the request 500'd, and whichever
   * assertion happened to be behind it failed. That is what made a run's
   * failures move around: 578/0, then 537/28, then 515/49, on the same code.
   *
   * So writes are handed to wrangler, which drives the same miniflare the
   * server does and therefore queues behind it properly. Reads - the ones on
   * the hot path of every assertion - keep the direct connection and the speed
   * that came with it.
   */
  if (READ_ONLY.test(sql)) {
    try {
      const { stdout } = await execFileAsync('sqlite3', [...SQLITE_FLAGS, localDb(), sql], {
        maxBuffer: 40 * 1024 * 1024,
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

/** Retried, because a busy database is a wait rather than a failure. */
async function viaWrangler(sql, where) {
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const { stdout } = await execFileAsync('npx', [
        'wrangler', 'd1', 'execute', 'assubki-books',
        where, '--json', '--command', sql,
      ], { maxBuffer: 40 * 1024 * 1024 });

      const parsed = JSON.parse(stdout);
      if (!Array.isArray(parsed)) throw new Error(parsed.error?.text ?? 'query failed');
      return parsed.flatMap((r) => r.results ?? []);
    } catch (err) {
      last = err;
      const detail = [err.stdout, err.stderr].filter(Boolean).join(' ').slice(0, 400);
      if (detail) last = new Error(`${err.message.split('\n')[0]}\n       ${detail.trim()}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
  throw last;
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

/**
 * A multipart POST to the portal, for endpoints that take a file. `admin()`
 * url-encodes its body, which cannot carry one.
 */
export async function adminUpload(path, form) {
  const res = await fetch(`${SITE}${path}`, {
    method: 'POST',
    headers: { ...ORIGIN, Cookie: cookie },
    body: form,
    redirect: 'manual',
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

export async function get(path, opts = {}) {
  return fetch(`${SITE}${path}`, { headers: { Cookie: cookie }, redirect: 'manual', ...opts });
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
  await execFileAsync('npx', [
    'wrangler', 'r2', 'object', 'delete', `assubki-books-uploads/${key}`,
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
    // Belt and braces: if the endpoint refused for any reason, the fixture must
    // still not survive the run.
    await db(`DELETE FROM books WHERE id = ${id}`).catch(() => {});
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
   * Ids above the real catalogue are fixtures by definition, so this is safe to
   * run unconditionally and safe to run twice.
   */
  await db(
    `DELETE FROM order_items WHERE order_id NOT IN (SELECT id FROM orders);
     DELETE FROM orders WHERE id IN (
       SELECT o.id FROM orders o JOIN order_items oi ON oi.order_id = o.id
        WHERE oi.book_id > ${REAL_CATALOGUE}
     );
     DELETE FROM sale_items WHERE book_id > ${REAL_CATALOGUE};
     DELETE FROM books WHERE id > ${REAL_CATALOGUE};
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
