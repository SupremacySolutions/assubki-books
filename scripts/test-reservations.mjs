// Isolated regression tests: real application functions and migrated SQLite,
// no developer/production database and no outbound notifications.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
const root = fileURLToPath(new URL('..', import.meta.url));
const temp = mkdtempSync(join(tmpdir(), 'assubki-reservations-'));
const active = join(temp, 'active.sqlite'),
  pristine = join(temp, 'pristine.sqlite');
let fault = null,
  hook = null,
  queries = 0;
function execute(query, path = active) {
  const raw = execFileSync(
    'sqlite3',
    ['-bail', '-json', '-cmd', 'PRAGMA foreign_keys=ON', '-cmd', 'PRAGMA trusted_schema=ON', path],
    {
      input: query,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  ).trim();
  return raw ? JSON.parse('[' + raw.replace(/\]\s*\[/g, '],[') + ']') : [];
}
function bound(query, args) {
  let at = 0;
  return query.replace(/'(?:''|[^'])*'|--[^\n]*|\/\*[\s\S]*?\*\/|\?(\d+)?/g, (match, n) => {
    if (!match.startsWith('?')) return match;
    const v = args[n ? Number(n) - 1 : at++];
    if (v === null) return 'NULL';
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    if (typeof v === 'string') return "'" + v.replaceAll("'", "''") + "'";
    throw new Error('Invalid SQL bind ' + v);
  });
}
class Statement {
  constructor(query, args = []) {
    this.query = query;
    this.args = args;
  }
  bind(...args) {
    assert.ok(args.length <= 100, 'D1 maximum 100 bound parameters');
    return new Statement(this.query, args);
  }
  async all() {
    queries++;
    if (fault?.(this.query)) throw new Error('injected failure');
    const results = execute(bound(this.query, this.args) + ';')[0] ?? [];
    if (hook) await hook(this.query, results);
    return { results, meta: {} };
  }
  async first(column) {
    const row = (await this.all()).results[0] ?? null;
    return column && row ? row[column] : row;
  }
  async run() {
    return (await db.batch([this]))[0];
  }
}
const db = {
  prepare(query) {
    return new Statement(query);
  },
  async batch(statements) {
    queries += statements.length;
    // Inject failure INSIDE the SQL transaction to verify actual rollback.
    const sql =
      'BEGIN;' +
      statements
        .map(
          (s, i) =>
            (fault?.(s.query)
              ? 'INSERT INTO deliberately_missing_table VALUES (1)'
              : bound(s.query, s.args)) +
            `;SELECT ${i} AS _index,changes() AS changes,last_insert_rowid() AS last_row_id;`,
        )
        .join('\n') +
      'COMMIT;';
    const chunks = execute(sql);
    let pending = [];
    const out = [];
    for (const chunk of chunks) {
      if (chunk[0]?._index !== undefined) {
        out.push({ results: pending, meta: chunk[0] });
        pending = [];
      } else pending = chunk;
    }
    return out;
  },
};
globalThis.reservationTestEnv = { DB: db, EMAIL_DRY_RUN: '1', TELEGRAM_DRY_RUN: '1' };
/*
 * Outbound network stays off, but what would have been sent is kept.
 *
 * The arrival email is the one message this whole feature exists to send, and
 * a dry run only records its subject - which is how its primary button came to
 * carry the label in the href and the URL as its text for a whole release.
 * Capturing the body a real send would have posted is the only way to assert
 * on the rendered anchor.
 */
globalThis.sentEmails = [];
globalThis.fetch = async (url, init) => {
  if (String(url).includes('api.resend.com')) {
    globalThis.sentEmails.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: 'test' }), { status: 200 });
  }
  throw new Error('Outbound network is disabled in tests');
};
await build({
  stdin: {
    contents: `
export {createCheckout,getOrder} from './src/lib/orders';
export {receiveDelivery,fillClaims} from './src/lib/arrival';
export {importLines} from './src/lib/shipments';
export {createGroup,getGroup,setGroupLine} from './src/lib/group';
export {expireOrders} from './src/lib/stock-release';
export {drainArrivalNotices,pendingNotices} from './src/lib/shipment-notify';
export {drainStockAlerts,leaseAlert,alertFailed,alertSent} from './src/lib/stock-alerts';
export {forgetOrderDiscount} from './src/lib/sales';
export {planBasketLine,basketDeliveryNote} from './src/lib/basket-plan';
export {POST as confirm} from './src/pages/api/admin/orders/[ref]/confirm';
export {POST as status} from './src/pages/api/admin/orders/[ref]/status';
export {POST as cancel} from './src/pages/api/orders/cancel';
export {POST as saveShipment} from './src/pages/api/admin/shipments/[id]/save';
export {POST as promote} from './src/pages/api/admin/shipments/[id]/promote';
export {POST as shipmentArrival} from './src/pages/api/admin/shipments/[id]/arrived';
`,
    resolveDir: root,
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: join(temp, 'app.mjs'),
  plugins: [
    {
      name: 'test-env',
      setup(b) {
        b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'env', namespace: 'test' }));
        b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
          contents: 'export const env=globalThis.reservationTestEnv;',
        }));
      },
    },
  ],
});
const app = await import(pathToFileURL(join(temp, 'app.mjs')));
execute(
  readdirSync(join(root, 'migrations'))
    .filter((n) => n.endsWith('.sql'))
    .sort()
    .map((n) => readFileSync(join(root, 'migrations', n), 'utf8'))
    .join('\n'),
  pristine,
);
let seq = 0,
  passed = 0;
const row = (q) => execute(q + ';')[0]?.[0];
const sql = (q) => execute(q + ';');
const request = (id, fields = {}) => ({
  params: { id: String(id), ref: String(id) },
  url: new URL('https://example.invalid'),
  request: new Request('https://example.invalid', {
    method: 'POST',
    body: new URLSearchParams(fields),
  }),
});
function shipment() {
  return row("INSERT INTO shipments(title,status) VALUES ('Test shipment','open') RETURNING id").id;
}
function book(sid = null, incoming = 0, stock = 0, price = 1000) {
  return row(`INSERT INTO books(slug,title,price_pence,status,shipment_id,incoming,stock)
 VALUES ('regression-${++seq}','Test book',${price},'${sid === null ? 'live' : 'draft'}',${sid ?? 'NULL'},${incoming},${stock}) RETURNING id`)
    .id;
}
function order(lines) {
  return app.createCheckout({
    name: 'Regression',
    email: 'test@example.invalid',
    fulfilment: 'collection',
    items: lines.map((x) => (typeof x === 'number' ? { bookId: x, qty: 1 } : x)),
  });
}
function receive(sid, lines, version = 0, key = crypto.randomUUID()) {
  return app.receiveDelivery({
    shipmentId: sid,
    version,
    key,
    lines: lines.map((x) => ({ bookId: x[0], qty: x[1] })),
  });
}
async function test(name, fn) {
  copyFileSync(pristine, active);
  fault = null;
  hook = null;
  queries = 0;
  app.forgetOrderDiscount();
  await fn();
  console.log('PASS ' + name);
  passed++;
}
try {
  await test('stock alerts recover a restock that never reached the notification hook', async () => {
    const id = book(null, 0, 0);
    sql(`INSERT INTO stock_alerts(book_id,email) VALUES (${id},'waiting@example.invalid')`);
    assert.equal((await app.drainStockAlerts(db, 'https://example.invalid')).sent, 0);
    sql(`UPDATE books SET stock=2 WHERE id=${id}`);
    assert.equal((await app.drainStockAlerts(db, 'https://example.invalid')).sent, 1);
    assert.equal(row('SELECT COUNT(*) AS n FROM stock_alerts').n, 0);
  });
  await test('a provider refusal retains the stock alert and respects backoff before retry', async () => {
    const id = book(null, 0, 1);
    sql(`INSERT INTO stock_alerts(book_id,email) VALUES (${id},'waiting@example.invalid')`);
    const oldFetch = globalThis.fetch;
    Object.assign(globalThis.reservationTestEnv, {
      EMAIL_DRY_RUN:'0', RESEND_API_KEY:'test-only', ORDER_FROM:'shop@example.invalid',
    });
    globalThis.fetch = async () => new Response('provider refused', {status:429});
    try {
      assert.deepEqual(await app.drainStockAlerts(db, 'https://example.invalid'), {sent:0,failed:1});
      const held = row('SELECT *, next_attempt_at > unixepoch() AS backed_off FROM stock_alerts');
      assert.equal(held.email, 'waiting@example.invalid');
      assert.equal(held.attempts, 1);
      assert.equal(held.backed_off, 1);
      assert.ok(held.last_error);
      assert.equal(held.lease_token, null);
      assert.deepEqual(await app.drainStockAlerts(db, 'https://example.invalid'), {sent:0,failed:0});
      sql('UPDATE stock_alerts SET next_attempt_at=0');
      globalThis.fetch = oldFetch;
      assert.equal((await app.drainStockAlerts(db, 'https://example.invalid')).sent, 1);
      assert.equal(row('SELECT COUNT(*) AS n FROM stock_alerts').n, 0);
    } finally {
      globalThis.fetch = oldFetch;
      globalThis.reservationTestEnv.EMAIL_DRY_RUN='1';
      delete globalThis.reservationTestEnv.RESEND_API_KEY;
      delete globalThis.reservationTestEnv.ORDER_FROM;
    }
  });
  await test('stock alert leases exclude another sender and reject stale acknowledgements', async () => {
    const id = book(null, 0, 1);
    const alert = row(`INSERT INTO stock_alerts(book_id,email,claimed_at) VALUES (${id},'waiting@example.invalid',unixepoch()) RETURNING id`).id;
    const token = await app.leaseAlert(db, alert);
    assert.ok(token);
    assert.equal(await app.leaseAlert(db, alert), null);
    await app.alertSent(db, alert, 'obsolete-token');
    await app.alertFailed(db, alert, 'obsolete-token', 'late failure');
    assert.equal(row(`SELECT lease_token FROM stock_alerts WHERE id=${alert}`).lease_token, token);
    await app.alertSent(db, alert, token);
    assert.equal(row('SELECT COUNT(*) AS n FROM stock_alerts').n, 0);
  });
  await test('shelf + two shipments commit separately with the basket discount preserved', async () => {
    const s1 = shipment(),
      s2 = shipment(),
      a = book(null, 0, 2, 4000),
      b = book(s1, 1, 0, 4000),
      c = book(s2, 1, 0, 2000);
    sql(
      "INSERT OR REPLACE INTO settings(key,value) VALUES ('order_discount_active','1'),('order_discount_threshold','85'),('order_discount_percent','10')",
    );
    app.forgetOrderDiscount();
    const orders = await order([a, b, c]);
    assert.equal(orders.length, 3);
    assert.equal(
      orders.reduce((n, o) => n + o.subtotalPence, 0),
      9000,
    );
    assert.ok(orders[0].expiresAt);
    assert.equal(orders[1].expiresAt, null);
    assert.equal(row(`SELECT COUNT(DISTINCT split_group) n FROM orders`).n, 1);
  });
  await test('failure in a later parcel rolls back every order and every hold', async () => {
    const a = book(null, 0, 2),
      s = shipment(),
      b = book(s, 1);
    // Fail the claim update only after both order inserts executed.
    fault = (q) => q.includes('UPDATE books SET') && q.includes('reserved_incoming');
    await assert.rejects(() => order([a, b]));
    assert.equal(row('SELECT COUNT(*) n FROM orders').n, 0);
    assert.equal(row(`SELECT reserved FROM books WHERE id=${a}`).reserved, 0);
  });
  await test('receipt failure rolls back shipment status, stock, claims and notices', async () => {
    const s = shipment(),
      b = book(s, 2);
    await order([b]);
    fault = (q) => q.includes('INSERT INTO stock_ledger');
    await assert.rejects(() => receive(s, [[b, 2]]));
    fault = null;
    assert.deepEqual(
      row(`SELECT stock,reserved,incoming,reserved_incoming FROM books WHERE id=${b}`),
      { stock: 0, reserved: 0, incoming: 2, reserved_incoming: 1 },
    );
    assert.equal(row(`SELECT status FROM shipments WHERE id=${s}`).status, 'open');
    await receive(s, [[b, 2]]);
  });
  await test('partial receipts hold the first copy, preserve snapshots and wait for completion', async () => {
    const s = shipment(),
      b = book(s, 3);
    const [first] = await order([{ bookId: b, qty: 2 }]);
    const [last] = await order([b]);
    const key = crypto.randomUUID();
    await receive(s, [[b, 1]], 0, key);
    await receive(s, [[b, 1]], 0, key);
    assert.deepEqual(
      row(`SELECT stock,reserved,incoming,reserved_incoming FROM books WHERE id=${b}`),
      { stock: 1, reserved: 1, incoming: 2, reserved_incoming: 2 },
    );
    assert.equal(row('SELECT COUNT(*) n FROM shipment_notices').n, 0);
    assert.equal(row(`SELECT pay_by FROM orders WHERE id=${first.id}`).pay_by, null);
    await assert.rejects(() => receive(s, [[b, 1]], 0), /changed/);
    await receive(s, [[b, 1]], 1);
    assert.ok(row(`SELECT pay_by FROM orders WHERE id=${first.id}`).pay_by);
    assert.equal(row(`SELECT pay_by FROM orders WHERE id=${last.id}`).pay_by, null);
    assert.equal(
      row(`SELECT SUM(qty*price_pence_snapshot) n FROM order_items WHERE order_id=${first.id}`).n,
      2000,
    );
    assert.equal(row('SELECT COUNT(*) n FROM shipment_notices').n, 1);
  });
  await test('payment is refused until arrival and consumes stock once after arrival', async () => {
    const s = shipment(),
      b = book(s, 1);
    const [o] = await order([b]);
    await app.confirm(request(o.ref, { payment_message: 'Test' }));
    assert.equal(row(`SELECT status FROM orders WHERE id=${o.id}`).status, 'requested');
    await receive(s, [[b, 1]]);
    await app.confirm(request(o.ref, { payment_message: 'Test' }));
    await app.status(request(o.ref, { status: 'paid' }));
    await app.status(request(o.ref, { status: 'paid' }));
    await app.status(request(o.ref, { status: 'completed' }));
    assert.deepEqual(row(`SELECT stock,reserved FROM books WHERE id=${b}`), {
      stock: 0,
      reserved: 0,
    });
  });
  await test('legacy paid claims are consumed when received', async () => {
    const s = shipment(),
      b = book(s, 1);
    const [o] = await order([b]);
    sql('DROP TRIGGER orders_wait_for_arrival');
    sql(`UPDATE orders SET status='paid' WHERE id=${o.id}`);
    await receive(s, [[b, 1]]);
    assert.deepEqual(row(`SELECT stock,reserved FROM books WHERE id=${b}`), {
      stock: 0,
      reserved: 0,
    });
  });
  await test('expiry cannot override concurrent payment or release another customer hold', async () => {
    const s = shipment(),
      b = book(s, 2);
    const [o] = await order([b]);
    await order([b]);
    await receive(s, [[b, 2]]);
    await app.drainArrivalNotices(db, 'https://example.invalid');
    await app.confirm(request(o.ref, { payment_message: 'Test' }));
    sql(`UPDATE orders SET pay_by=unixepoch()-60 WHERE id=${o.id}`);
    hook = async (q) => {
      if (q.includes('ORDER BY o.id LIMIT 100')) {
        hook = null;
        await app.status(request(o.ref, { status: 'paid' }));
      }
    };
    assert.equal((await app.expireOrders(db, true)).orders, 0);
    assert.equal(row(`SELECT status FROM orders WHERE id=${o.id}`).status, 'paid');
    assert.equal(row(`SELECT reserved FROM books WHERE id=${b}`).reserved, 1);
  });
  await test('customer cancellation rolls back on release failure and cannot double-release', async () => {
    const b = book(null, 0, 2);
    const [o] = await order([b]);
    await order([b]);
    fault = (q) => q.includes('INSERT INTO stock_ledger');
    await assert.rejects(() => app.cancel(request('', { ref: o.ref, t: o.token })));
    fault = null;
    assert.equal(row(`SELECT status FROM orders WHERE id=${o.id}`).status, 'requested');
    await app.cancel(request('', { ref: o.ref, t: o.token }));
    await app.cancel(request('', { ref: o.ref, t: o.token }));
    assert.equal(row(`SELECT reserved FROM books WHERE id=${b}`).reserved, 1);
  });
  await test('stale draft edits cannot delete active reservation titles', async () => {
    const s = shipment(),
      b = book(s, 1);
    const [o] = await order([b]);
    await app.saveShipment(request(s, { row: b, ['title_' + b]: '' }));
    assert.equal(row(`SELECT book_id FROM order_items WHERE order_id=${o.id}`).book_id, b);
  });
  await test('100 reservations receive deadlines and notices with bounded SQL', async () => {
    const s = shipment(),
      b = book(s, 100);
    sql(
      Array.from(
        { length: 100 },
        (_, i) =>
          `INSERT INTO orders(ref,access_token,customer_name,email,fulfilment,status,subtotal_pence,shipment_id) VALUES ('REG-${i}','test','Test','test@example.invalid','collection','requested',1000,${s});INSERT INTO order_items(order_id,book_id,title_snapshot,price_pence_snapshot,qty,from_incoming) VALUES(last_insert_rowid(),${b},'Test',1000,1,1);`,
      ).join(''),
    );
    sql(`UPDATE books SET reserved_incoming=100 WHERE id=${b}`);
    queries = 0;
    await receive(s, [[b, 100]]);
    assert.ok(queries < 20);
    assert.equal(row('SELECT COUNT(*) n FROM orders WHERE pay_by IS NOT NULL').n, 100);
    assert.equal(row('SELECT COUNT(*) n FROM shipment_notices').n, 100);
  });
  await test('the arrival email points its button at the order, not at its own label', async () => {
    const s = shipment(),
      b = book(s, 1);
    const [o] = await order([b]);
    await receive(s, [[b, 1]]);

    /* A real send, captured rather than performed, so the assertion is on the
       HTML a customer would actually receive. */
    globalThis.sentEmails.length = 0;
    /* Credentials only for the length of this test. A neighbouring test forces
       a delivery failure by relying on their absence, so they must not be set
       for the suite as a whole. */
    globalThis.reservationTestEnv.EMAIL_DRY_RUN = '0';
    globalThis.reservationTestEnv.RESEND_API_KEY = 'test-key-not-a-real-credential';
    globalThis.reservationTestEnv.ORDER_FROM = 'shop@example.invalid';
    try {
      assert.equal((await app.drainArrivalNotices(db, 'https://example.invalid')).sent, 1);
    } finally {
      globalThis.reservationTestEnv.EMAIL_DRY_RUN = '1';
      delete globalThis.reservationTestEnv.RESEND_API_KEY;
      delete globalThis.reservationTestEnv.ORDER_FROM;
    }

    assert.equal(globalThis.sentEmails.length, 1);
    const { html } = globalThis.sentEmails[0];
    /* `&` is escaped inside the attribute, as it must be, so compare against
       the escaped form rather than the raw URL. */
    const link = `https://example.invalid/order?ref=${o.ref}&amp;t=${o.token}`;

    /* `button(href, label)` is easy to call the other way round, and nothing
       else in the email fails visibly when it happens - the button still
       renders, in the right colour, with the URL as its words. */
    assert.ok(
      html.includes(`href="${link}"`),
      `the button should link to the order; got ${(/href="[^"]*"/.exec(html) ?? ['none'])[0]}`,
    );
    assert.ok(!/href="See your order"/.test(html), 'the label must not be used as the href');
  });
  await test('failed notices retry and do not expire a customer who was never told', async () => {
    const s = shipment(),
      b = book(s, 1);
    const [o] = await order([b]);
    await receive(s, [[b, 1]]);
    globalThis.reservationTestEnv.EMAIL_DRY_RUN = '0';
    assert.equal((await app.drainArrivalNotices(db, 'https://example.invalid')).failed, 1);
    globalThis.reservationTestEnv.EMAIL_DRY_RUN = '1';
    sql(`UPDATE orders SET pay_by=unixepoch()-60 WHERE id=${o.id}`);
    assert.equal((await app.expireOrders(db, true)).orders, 0);
    sql('UPDATE shipment_notices SET attempts=8,next_attempt_at=0');
    assert.equal((await app.drainArrivalNotices(db, 'https://example.invalid')).sent, 1);
    sql(`UPDATE orders SET pay_by=unixepoch()-60 WHERE id=${o.id}`);
    assert.equal((await app.expireOrders(db, true)).orders, 1);
    assert.equal(row(`SELECT reserved FROM books WHERE id=${b}`).reserved, 0);
  });
  await test('a legacy order spanning two shipments waits for both deliveries', async () => {
    const s1 = shipment(),
      s2 = shipment(),
      a = book(s1, 1),
      b = book(s2, 1);
    const [o1, o2] = await order([a, b]);
    sql(
      `UPDATE order_items SET order_id=${o1.id} WHERE order_id=${o2.id};DELETE FROM orders WHERE id=${o2.id}`,
    );
    await receive(s1, [[a, 1]]);
    assert.equal(row('SELECT COUNT(*) n FROM shipment_notices').n, 0);
    await receive(s2, [[b, 1]]);
    assert.equal(row('SELECT COUNT(*) n FROM shipment_notices').n, 1);
  });
  await test('receiving a set adds its physical volumes before holding the claim', async () => {
    const set = row("INSERT INTO book_sets(name,volumes) VALUES ('Test set',2) RETURNING id").id;
    sql(`INSERT INTO book_set_stock(set_id,volume,have) VALUES (${set},1,0),(${set},2,0)`);
    const b = book(null, 1);
    sql(`UPDATE books SET set_id=${set},set_from=1,set_to=2 WHERE id=${b}`);
    const [o] = await order([b]);
    await app.fillClaims(b, 1, crypto.randomUUID(), 0);
    assert.equal(row(`SELECT MIN(have) n FROM book_set_stock WHERE set_id=${set}`).n, 1);
    assert.equal(row(`SELECT reserved FROM books WHERE id=${b}`).reserved, 1);
    await app.confirm(request(o.ref, { payment_message: 'Test' }));
    await app.status(request(o.ref, { status: 'paid' }));
    assert.equal(row(`SELECT MAX(have) n FROM book_set_stock WHERE set_id=${set}`).n, 0);
  });
  await test('an extension made during expiry selection preserves the order and stock', async () => {
    const b = book(null, 1);
    const [o] = await order([b]);
    await app.fillClaims(b, 1, crypto.randomUUID(), 0);
    await app.drainArrivalNotices(db, 'https://example.invalid');
    sql(`UPDATE orders SET pay_by=unixepoch()-60 WHERE id=${o.id}`);
    hook = async (q) => {
      if (q.includes('ORDER BY o.id LIMIT 100')) {
        hook = null;
        sql(`UPDATE orders SET pay_by=unixepoch()+604800 WHERE id=${o.id}`);
      }
    };
    assert.equal((await app.expireOrders(db, true)).orders, 0);
    assert.equal(row(`SELECT reserved FROM books WHERE id=${b}`).reserved, 1);
  });
  await test('two notice drainers cannot claim and send the same notice', async () => {
    const s = shipment(),
      b = book(s, 1);
    await order([b]);
    await receive(s, [[b, 1]]);
    hook = async (q) => {
      if (q.includes('ORDER BY n.id')) {
        hook = null;
        assert.equal((await app.drainArrivalNotices(db, 'https://example.invalid')).sent, 1);
      }
    };
    assert.equal((await app.drainArrivalNotices(db, 'https://example.invalid')).sent, 0);
    assert.equal(row('SELECT attempts FROM shipment_notices').attempts, 1);
  });
  await test('a 250-title shipment imports, saves and receives with bounded SQL', async () => {
    const s = shipment();
    queries = 0;
    await app.importLines(
      s,
      Array.from({ length: 250 }, (_, i) => ({
        title: 'Large title ' + i,
        pricePence: 1000,
        stock: 1,
        volumes: null,
        script: 'english',
        index: i + 1,
      })),
    );
    const rows = execute(`SELECT id FROM books WHERE shipment_id=${s};`)[0];
    const fields = new URLSearchParams();
    for (const b of rows) {
      fields.append('row', b.id);
      for (const [key, value] of Object.entries({
        title: 'Edited ' + b.id,
        price: '12',
        incoming: '2',
        script: 'english',
      }))
        fields.set(key + '_' + b.id, value);
    }
    await app.saveShipment({
      ...request(s),
      request: new Request('https://example.invalid', { method: 'POST', body: fields }),
    });
    assert.equal(
      row(`SELECT COUNT(*) n FROM books WHERE shipment_id=${s} AND incoming=2 AND price_pence=1200`)
        .n,
      250,
    );
    await receive(
      s,
      rows.map((b) => [b.id, 1]),
    );
    assert.ok(queries < 25);
    assert.equal(
      row(`SELECT COUNT(*) n FROM books WHERE shipment_id=${s} AND stock=1 AND incoming=1`).n,
      250,
    );
  });
  await test('group baskets expose incoming stock and the shipment destination', async () => {
    const sid = shipment(),
      b = book(sid, 2);
    const g = await app.createGroup('Regression', 'test@example.invalid');
    await app.setGroupLine(g.code, g.ownerToken, b, 1, 'Regression');
    const view = await app.getGroup(g.code, g.ownerToken);
    assert.equal(view.lines[0].shipmentId, sid);
    assert.equal(view.lines[0].reservable, 2);
    assert.equal(app.planBasketLine(view.lines[0], 1).waiting, true);
  });
  await test('basket and checkout retain incoming copies and explain separate orders', async () => {
    assert.equal(app.planBasketLine({ available: 0, reservable: 2, shipmentId: 1 }, 1).qty, 1);
    assert.equal(app.planBasketLine({ available: 1, reservable: 3 }, 2).waiting, true);
    assert.match(
      app.basketDeliveryNote(
        [
          { id: 1, available: 1 },
          { id: 2, available: 0, reservable: 1, shipmentId: 1 },
        ],
        { 1: 1, 2: 1 },
      ),
      /2 separate orders/,
    );
  });
  console.log(`${passed} reservation regression tests passed`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
