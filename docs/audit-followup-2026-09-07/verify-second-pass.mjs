// Isolated regression tests: real application functions and migrated SQLite,
// no developer/production database and no outbound notifications.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
const root = fileURLToPath(new URL('../..', import.meta.url));
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
globalThis.fetch = async () => {
  throw new Error('Outbound network is disabled in tests');
};
await build({
  stdin: {
    contents: `
export {createCheckout,getOrder} from './src/lib/orders';
export {POST as setBook} from './src/pages/api/admin/books/[id]/set';
export {postMessage,thread,markRead} from './src/lib/messages';
export {GET as adminThread} from './src/pages/api/admin/orders/[ref]/thread';
export {GET as customerStatus} from './src/pages/api/orders/status';
export {POST as customerMessage} from './src/pages/api/orders/message';
export {POST as webhook} from './src/pages/api/telegram/webhook';
export {notifyBackInStock} from './src/lib/notify';
export {askToBeTold} from './src/lib/stock-alerts';
export {expireGroupBaskets,sweepProofs} from './workers/expire-holds/index';

export {receiveDelivery,fillClaims} from './src/lib/arrival';
export {importLines,openShipment} from './src/lib/shipments';
export {POST as shipmentDetails} from './src/pages/api/admin/shipments/[id]/details';
export {createGroup,getGroup,setGroupLine} from './src/lib/group';
export {readGroup,escapeHtml} from './src/scripts/group';
export {readCookie} from './src/lib/admin-auth';
export {POST as login} from './src/pages/api/admin/login';
export {POST as groupLine} from './src/pages/api/group/line';
export {POST as lookup} from './src/pages/api/orders/lookup';
export {expireOrders} from './src/lib/stock-release';
export {drainArrivalNotices,pendingNotices} from './src/lib/shipment-notify';
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

const setForm={action:'create',volumes:'2',sets:'1',part_0_name:'Test first volume',part_0_from:'1',part_0_to:'1',part_0_price:'5'};
const results=[];
async function check(name,fn){try{await test(name,fn);results.push({name,passed:true});}catch(e){console.log('FAIL '+name+': '+e.message);results.push({name,passed:false});}}
try {
await check('Fixed F01 arrival button targets the order',async()=>{
 const sid=shipment(),b=book(sid,1);await order([b]);await receive(sid,[[b,1]]);
 Object.assign(globalThis.reservationTestEnv,{EMAIL_DRY_RUN:'0',RESEND_API_KEY:'fake',ORDER_FROM:'audit@example.invalid'});
 let payload;globalThis.fetch=async(url,init)=>{payload=JSON.parse(init.body);return Response.json({id:'fake'});};
 await app.drainArrivalNotices(db,'https://example.invalid');assert.match(payload.html,/href="https:\/\/example.invalid\/order\?/);assert.doesNotMatch(payload.html,/href="See your order"/);
 globalThis.reservationTestEnv.EMAIL_DRY_RUN='1';
});
await check('Improved F02 provider rejection restores subscriber and reports zero sent',async()=>{
 const b=book(null,0,1);await app.askToBeTold(b,'test@example.invalid');globalThis.reservationTestEnv.EMAIL_DRY_RUN='0';globalThis.fetch=async()=>new Response('rejected',{status:429});
 assert.equal(await app.notifyBackInStock(b,'https://example.invalid'),0);assert.equal(row('SELECT COUNT(*) n FROM stock_alerts').n,1);globalThis.reservationTestEnv.EMAIL_DRY_RUN='1';
});
await check('Fixed F03 restocked set completes another checkout',async()=>{
 const b=book(null,0,1);await app.setBook(request(b,setForm));const[o]=await order([b]);await app.confirm(request(o.ref,{payment_message:'Test'}));await app.status(request(o.ref,{status:'paid'}));
 await app.setBook(request(b,{action:'restock',sets:'2'}));assert.equal(row(`SELECT stock n FROM books WHERE id=${b}`).n,2);assert.equal((await order([b])).length,1);
});
await check('Improved F04 existing holds prevent an ordinary reduction',async()=>{
 const b=book(null,0,1);await app.setBook(request(b,setForm));await order([b]);const r=await app.setBook(request(b,{action:'restock',sets:'0'}));assert.match(r.headers.get('location'),/heldsets/);assert.equal(row('SELECT MIN(have) n FROM book_set_stock').n,1);
});
await check('Fixed F05 set creation failure rolls back header and attachment',async()=>{
 const b=book(null,0,1);fault=q=>q.includes('INSERT INTO books (slug, title');await assert.rejects(()=>app.setBook(request(b,setForm)));fault=null;
 assert.equal(row('SELECT COUNT(*) n FROM book_sets').n,0);assert.equal(row(`SELECT set_id FROM books WHERE id=${b}`).set_id,null);
});
await check('Fixed F06 intervening message remains unread',async()=>{
 const b=book(null,0,1),[o]=await order([b]);await app.postMessage({orderId:o.id,sender:'customer',via:'web',body:'First'});
 hook=async(q)=>{if(q.includes('FROM messages WHERE order_id = ? AND id > ?')){hook=null;await app.postMessage({orderId:o.id,sender:'customer',via:'web',body:'Second'});}};
 const r=await app.adminThread({...request(o.ref),url:new URL('https://example.invalid?since=0')});assert.equal((await r.json()).messages.length,1);assert.equal(row(`SELECT unread_for_owner n FROM orders WHERE id=${o.id}`).n,1);
});
await check('Fixed F07 101 groups expire successfully',async()=>{
 sql(Array.from({length:101},(_,i)=>`INSERT INTO group_baskets(code,token,owner_token,organiser,expires_at) VALUES ('G${i}','t${i}','o${i}','Test',1);`).join(''));
 assert.equal(await app.expireGroupBaskets(db),101);assert.equal(row('SELECT COUNT(*) n FROM group_baskets').n,0);
});
await check('Fixed F08 101 deleted proof objects have metadata cleared',async()=>{
 const b=book(null,0,1),[o]=await order([b]);sql(`UPDATE orders SET status='completed',completed_at=1 WHERE id=${o.id}`);
 sql(Array.from({length:101},(_,i)=>`INSERT INTO messages(order_id,sender,via,body,image_key,created_at) VALUES (${o.id},'customer','web','test','proofs/${i}',1);`).join(''));
 let deleted=0;assert.equal(await app.sweepProofs(db,{delete:async()=>{deleted++;}}),101);assert.equal(deleted,101);assert.equal(row('SELECT COUNT(*) n FROM messages WHERE image_key IS NOT NULL').n,0);
});
await check('Fixed F09 member ownership and organiser API override',async()=>{
 const b=book(null,0,4),g=await app.createGroup('Owner','test@example.invalid');
 assert.equal(await app.setGroupLine(g.code,g.token,b,1,'Alice','alice-token'),'ok');assert.equal(await app.setGroupLine(g.code,g.token,b,0,'Alice','bob-token'),'denied');
 assert.equal((await app.getGroup(g.code,g.ownerToken)).lines.length,1);assert.equal(await app.setGroupLine(g.code,g.ownerToken,b,0,'Alice','owner-token'),'ok');assert.equal((await app.getGroup(g.code,g.ownerToken)).lines.length,0);
});
await check('Fixed F10 group-name escaping handles markup and quotes',async()=>{
 assert.equal(app.escapeHtml('<b>"A" & B</b>'), '&lt;b&gt;&quot;A&quot; &amp; B&lt;/b&gt;');
 for(const p of ['basket','checkout'])assert.ok(readFileSync(join(root,`src/pages/${p}.astro`),'utf8').includes('escapeHtml(line.addedBy)'));
});
await check('Fixed F11 idle customer status uses one SQL query',async()=>{
 const b=book(null,0,1),[o]=await order([b]);queries=0;const r=await app.customerStatus({url:new URL(`https://example.invalid?ref=${o.ref}&t=${o.token}&since=0`)});assert.equal(r.status,200);assert.equal(queries,1);
});
await check('Fixed F12 absent webhook secret fails closed',async()=>{
 delete globalThis.reservationTestEnv.TELEGRAM_WEBHOOK_SECRET;const r=await app.webhook({request:new Request('https://example.invalid',{method:'POST',body:'{}'})});assert.equal(r.status,503);
});
await check('Fixed F13 shipment date edits roll back on child failure',async()=>{
 const sid=shipment(),b=book(sid,1);fault=q=>q.includes('UPDATE books')&&q.includes('incoming_vague');await assert.rejects(()=>app.shipmentDetails(request(sid,{title:'Test',incoming_month:'2027-01',incoming_vague:'early'})));fault=null;assert.equal(row(`SELECT incoming_month m FROM shipments WHERE id=${sid}`).m,null);
});
await check('Fixed F14 concurrent message admission caps writes at twenty',async()=>{
 const b=book(null,0,1),[o]=await order([b]);await Promise.all(Array.from({length:25},(_,i)=>app.postMessage({orderId:o.id,sender:'customer',via:'web',body:'Burst '+i})));
 assert.equal(row(`SELECT COUNT(*) n FROM messages WHERE order_id=${o.id}`).n,20);assert.equal(row(`SELECT unread_for_owner n FROM orders WHERE id=${o.id}`).n,20);
});
await check('Fixed F15 shipment refuses invalid concurrent edit',async()=>{
 const sid=shipment(),b=book(sid,1);sql(`UPDATE shipments SET status='draft' WHERE id=${sid}`);hook=async(q)=>{if(q.includes('SELECT COUNT(*) AS n FROM books WHERE shipment_id')){hook=null;sql(`UPDATE books SET price_pence=0 WHERE id=${b}`);}};
 assert.equal((await app.openShipment(sid)).ok,false);assert.equal(row(`SELECT status FROM shipments WHERE id=${sid}`).status,'draft');
});
await check('Fixed F18 malformed cookie is treated as absent',async()=>{assert.equal(app.readCookie(new Request('https://example.invalid',{headers:{cookie:'asb_admin=%'}}),'asb_admin'),null);});
await check('Remaining F16 malformed form body still throws',async()=>{await assert.rejects(()=>app.lookup({request:new Request('https://example.invalid',{method:'POST',headers:{'content-type':'application/json'},body:'{'})}));});
await check('Closed R01 concurrent overlapping holds prevent restock',async()=>{
 const b=book(null,0,2);await app.setBook(request(b,{...setForm,sets:'2'}));const part=row(`SELECT id FROM books WHERE set_id IS NOT NULL AND id<>${b}`).id;
 hook=async(q)=>{if(q.includes('AS floor')){hook=null;sql(`UPDATE books SET reserved=1 WHERE id IN (${b},${part});`);}};
 await app.setBook(request(b,{action:'restock',sets:'1'}));assert.equal(row('SELECT MIN(have) n FROM book_set_stock').n,2);assert.equal(row('SELECT SUM(reserved) n FROM books WHERE set_from=1').n,2);
});
await check('Closed R02 organiser controls carry the selected owner',async()=>{
 const b=book(null,0,4),g=await app.createGroup('Owner','test@example.invalid');await app.setGroupLine(g.code,g.token,b,1,'Alice','alice-token');
 const source=readFileSync(join(root,'src/pages/basket.astro'),'utf8');assert.ok(source.includes('name: owner'));assert.ok(source.includes('input.dataset.groupOwner'));assert.ok(source.includes('data-group-owner="${escapeHtml(line.addedBy)}"'));assert.ok(source.includes('id="g${row}"'));
 await app.setGroupLine(g.code,g.ownerToken,b,2,'Alice','owner-token');const lines=(await app.getGroup(g.code,g.ownerToken)).lines;assert.equal(lines.length,1);assert.equal(lines[0].addedBy,'Alice');assert.equal(lines[0].qty,2);
});
await check('Closed R03 legacy membership persists its key across reads',async()=>{
 let stored=JSON.stringify({code:'TEST',token:'shared',name:'Alice',organiser:false});let writes=0;
 globalThis.localStorage={getItem:()=>stored,setItem:(_key,value)=>{stored=value;writes++;}};
 const a=app.readGroup(),b=app.readGroup();assert.equal(a.memberToken,b.memberToken);assert.equal(JSON.parse(stored).memberToken,a.memberToken);assert.equal(writes,1);delete globalThis.localStorage;
});
await check('R03 unavailable storage preserves membership',async()=>{
 const legacy=JSON.stringify({code:'TEST',token:'shared',name:'Alice',organiser:false});globalThis.localStorage={getItem:()=>legacy,setItem:()=>{throw Error('quota');}};
 assert.equal(app.readGroup().name,'Alice');delete globalThis.localStorage;
});
await check('R04 an older acknowledgement resurrects already-read messages',async()=>{
 const b=book(null,0,1),[o]=await order([b]);const a=await app.postMessage({orderId:o.id,sender:'customer',via:'web',body:'A'}),z=await app.postMessage({orderId:o.id,sender:'customer',via:'web',body:'B'});
 await app.markRead(o.id,'owner',z);assert.equal(row(`SELECT unread_for_owner n FROM orders WHERE id=${o.id}`).n,0);await app.markRead(o.id,'owner',a);assert.equal(row(`SELECT unread_for_owner n FROM orders WHERE id=${o.id}`).n,1);
});
await check('R05 failed restoration still loses a stock-alert subscriber',async()=>{
 const b=book(null,0,1);await app.askToBeTold(b,'test@example.invalid');Object.assign(globalThis.reservationTestEnv,{EMAIL_DRY_RUN:'0',RESEND_API_KEY:'fake',ORDER_FROM:'audit@example.invalid'});globalThis.fetch=async()=>new Response('rejected',{status:429});fault=q=>q.includes('INSERT OR IGNORE INTO stock_alerts');
 await assert.rejects(()=>app.notifyBackInStock(b,'https://example.invalid'));fault=null;assert.equal(row('SELECT COUNT(*) n FROM stock_alerts').n,0);globalThis.reservationTestEnv.EMAIL_DRY_RUN='1';
});
await check('Closed R06 double-slash redirect falls back to admin',async()=>{
 Object.assign(globalThis.reservationTestEnv,{ADMIN_PASSWORD:'audit-only',ADMIN_SESSION_SECRET:'audit-session'});
 const r=await app.login({url:new URL('https://example.invalid/api/admin/login'),request:new Request('https://example.invalid/api/admin/login',{method:'POST',body:new URLSearchParams({password:'audit-only',next:'https://example.invalid//evil.invalid'})})});
 assert.equal(r.status,302);assert.equal(r.headers.get('location'),'/admin');
});
await check('Closed R07 product page supplies member key and API accepts addition',async()=>{
 const b=book(null,0,4),g=await app.createGroup('Owner','test@example.invalid');
 const source=readFileSync(join(root,'src/pages/book/[slug].astro'),'utf8');assert.ok(source.slice(source.indexOf("fetch('/api/group/line'")).includes('memberToken: member.memberToken'));
 const r=await app.groupLine({request:new Request('https://example.invalid',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:g.code,token:g.token,name:'Alice',memberToken:'alice-token',bookId:b,qty:1})})});
 assert.equal(r.status,200);assert.equal((await app.getGroup(g.code,g.ownerToken)).lines.length,1);
});
await check('R08 refused restock can still change listing stocks for an uneven pool',async()=>{
 const b=book(null,0,2);await app.setBook(request(b,{...setForm,sets:'2',part_0_from:'2',part_0_to:'2'}));
 const part=row(`SELECT id FROM books WHERE set_id IS NOT NULL AND id<>${b}`).id;
 sql('UPDATE book_set_stock SET have=1 WHERE volume=1');
 hook=async(q)=>{if(q.includes('AS floor')){hook=null;await order([b]);await order([part]);}};
 const response=await app.setBook(request(b,{action:'restock',sets:'1'}));
 assert.match(response.headers.get('location'),/heldsets/);
 assert.equal(row('SELECT have FROM book_set_stock WHERE volume=2').have,2);
 assert.equal(row(`SELECT stock FROM books WHERE id=${part}`).stock,1);
 // The full-set hold is then released; one physical volume 2 is available.
 sql(`UPDATE books SET reserved=0 WHERE id=${b}`);
 await assert.rejects(()=>order([part]));
});
console.log(JSON.stringify(results,null,2));if(results.some(r=>!r.passed))process.exitCode=1;
} finally {rmSync(temp,{recursive:true,force:true});}
