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

const outcomes=[];
async function audit(name,fn){try{await test(name,fn);outcomes.push({name,result:'reproduced'});}catch(e){console.log('NOT REPRODUCED '+name+': '+e.message);outcomes.push({name,result:'not reproduced',detail:e.message});}}
const setForm={action:'create',volumes:'2',sets:'1',part_0_name:'Test first volume',part_0_from:'1',part_0_to:'1',part_0_price:'5'};
try {
await audit('F01 arrival email primary link has reversed arguments',async()=>{
 const sid=shipment(),b=book(sid,1);await order([b]);await receive(sid,[[b,1]]);
 Object.assign(globalThis.reservationTestEnv,{EMAIL_DRY_RUN:'0',RESEND_API_KEY:'fake',ORDER_FROM:'audit@example.invalid'});
 let payload;globalThis.fetch=async(url,init)=>{payload=JSON.parse(init.body);return Response.json({id:'fake'});};
 await app.drainArrivalNotices(db,'https://example.invalid');
 assert.match(payload.html,/href="See your order"/);
 globalThis.reservationTestEnv.EMAIL_DRY_RUN='1';
});
await audit('F02 failed back-in-stock notices are deleted and reported as sent',async()=>{
 const b=book(null,0,1);await app.askToBeTold(b,'test@example.invalid');globalThis.reservationTestEnv.EMAIL_DRY_RUN='0';
 globalThis.fetch=async()=>new Response('simulated rejection',{status:429});
 assert.equal(await app.notifyBackInStock(b,'https://example.invalid'),1);
 assert.equal(row('SELECT COUNT(*) n FROM stock_alerts').n,0);globalThis.reservationTestEnv.EMAIL_DRY_RUN='1';
});
await audit('F03 restocked set appears available but checkout rejects it',async()=>{
 const b=book(null,0,1);await app.setBook(request(b,setForm));const [o]=await order([b]);
 await app.confirm(request(o.ref,{payment_message:'Test'}));await app.status(request(o.ref,{status:'paid'}));
 await app.setBook(request(b,{action:'restock',sets:'2'}));
 assert.equal(row('SELECT MIN(have) n FROM book_set_stock').n,2);
 assert.equal(row(`SELECT stock FROM books WHERE id=${b}`).stock,0);
 await assert.rejects(()=>order([b]));
});
await audit('F04 reducing a set pool below existing holds is accepted',async()=>{
 const b=book(null,0,1);await app.setBook(request(b,setForm));await order([b]);
 await app.setBook(request(b,{action:'restock',sets:'0'}));
 assert.equal(row('SELECT MIN(have) n FROM book_set_stock').n,0);assert.equal(row(`SELECT reserved FROM books WHERE id=${b}`).reserved,1);
});
await audit('F05 failed set creation leaves an orphan header',async()=>{
 const b=book(null,0,1);fault=q=>q.includes('INSERT INTO books (slug, title');
 await assert.rejects(()=>app.setBook(request(b,setForm)));fault=null;
 assert.equal(row('SELECT COUNT(*) n FROM book_sets').n,1);assert.equal(row('SELECT COUNT(*) n FROM book_set_stock').n,0);
});
await audit('F06 unread message arriving between fetch and acknowledgement is cleared',async()=>{
 const b=book(null,0,1),[o]=await order([b]);await app.postMessage({orderId:o.id,sender:'customer',via:'web',body:'First'});
 hook=async(q)=>{if(q.includes('FROM messages WHERE order_id = ? AND id > ?')){hook=null;await app.postMessage({orderId:o.id,sender:'customer',via:'web',body:'Second'});}};
 const response=await app.adminThread({...request(o.ref),url:new URL('https://example.invalid?since=0')});
 const payload=await response.json();assert.equal(payload.messages.length,1);assert.equal(row(`SELECT unread_for_owner n FROM orders WHERE id=${o.id}`).n,0);
 assert.equal(row(`SELECT COUNT(*) n FROM messages WHERE order_id=${o.id}`).n,2);
});
await audit('F07 group expiry exceeds D1 bind limit above 100 abandoned baskets',async()=>{
 sql(Array.from({length:101},(_,i)=>`INSERT INTO group_baskets(code,token,owner_token,organiser,expires_at) VALUES ('G${i}','test','owner','Test',0)`).join(';'));
 await assert.rejects(()=>app.expireGroupBaskets(db),/100 bound/);
});
await audit('F08 proof sweep deletes 101 objects then fails to clear their rows',async()=>{
 const b=book(null,0,1),[o]=await order([b]);sql(`UPDATE orders SET status='cancelled',updated_at=0 WHERE id=${o.id}`);
 sql(Array.from({length:101},(_,i)=>`INSERT INTO messages(order_id,sender,via,image_key,had_image) VALUES (${o.id},'customer','web','proofs/${i}.jpg',1)`).join(';'));
 let deleted=0;await assert.rejects(()=>app.sweepProofs(db,{delete:async()=>{deleted++;}}),/100 bound/);
 assert.equal(deleted,101);assert.equal(row('SELECT COUNT(*) n FROM messages WHERE image_key IS NOT NULL').n,101);
});
await audit('F09 shared group member can overwrite another named member line',async()=>{
 const b=book(null,0,5),g=await app.createGroup('Owner','test@example.invalid');
 await app.setGroupLine(g.code,g.token,b,2,'Alice');await app.setGroupLine(g.code,g.token,b,0,'Alice');
 assert.equal((await app.getGroup(g.code,g.ownerToken)).lines.length,0);
});
await audit('F10 group member name reaches browser HTML interpolation unchanged',async()=>{
 const b=book(null,0,1),g=await app.createGroup('Owner','test@example.invalid');
 const payload='<b id=audit-injection>Injected</b>';
 await app.setGroupLine(g.code,g.token,b,1,payload);assert.equal((await app.getGroup(g.code,g.ownerToken)).lines[0].addedBy,payload);
 const basket=readFileSync(join(root,'src/pages/basket.astro'),'utf8');assert.ok(basket.includes('${line.addedBy}'));assert.ok(basket.includes('rows.innerHTML = view.lines.length'));
});
await audit('F11 an idle customer poll reads order items unnecessarily',async()=>{
 const b=book(null,0,1),[o]=await order([b]);queries=0;
 await app.customerStatus({url:new URL(`https://example.invalid?ref=${o.ref}&t=${o.token}&since=0`)});
 assert.equal(queries,2);console.log('idle customer poll SQL statements:',queries);
});
await audit('F12 missing webhook secret accepts a forged update',async()=>{
 const b=book(null,0,1),[o]=await order([b]);delete globalThis.reservationTestEnv.TELEGRAM_WEBHOOK_SECRET;
 const response=await app.webhook({request:new Request('https://example.invalid',{method:'POST',body:JSON.stringify({message:{chat:{id:99},text:'/start '+o.ref+'_'+o.token.slice(0,8)}})})});
 assert.equal(response.status,200);assert.equal(row(`SELECT telegram_chat_id FROM orders WHERE id=${o.id}`).telegram_chat_id,'99');
});
await audit('F13 shipment date edits partially commit on a book update failure',async()=>{
 const sid=shipment(),b=book(sid,1);fault=q=>q.includes('UPDATE books')&&q.includes('incoming_vague');
 await assert.rejects(()=>app.shipmentDetails(request(sid,{title:'Changed',incoming_vague:'late',incoming_month:'2027-01'})));fault=null;
 assert.equal(row(`SELECT incoming_month m FROM shipments WHERE id=${sid}`).m,'2027-01');
 assert.equal(row(`SELECT incoming_month m FROM books WHERE id=${b}`).m,null);
});
await audit('F14 concurrent customer messages bypass the hourly cap',async()=>{
 const b=book(null,0,1),[o]=await order([b]);
 await Promise.all(Array.from({length:25},(_,i)=>app.customerMessage({request:new Request('https://example.invalid',{method:'POST',headers:{Accept:'application/json'},body:new URLSearchParams({ref:o.ref,t:o.token,body:'Burst '+i})})})));
 assert.equal(row(`SELECT COUNT(*) n FROM messages WHERE order_id=${o.id}`).n,25);
});
await audit('F15 a concurrent draft edit can open a shipment with no price',async()=>{
 const sid=shipment(),b=book(sid,1);sql(`UPDATE shipments SET status='draft' WHERE id=${sid}`);
 hook=async(q)=>{if(q.includes('SELECT COUNT(*) AS n FROM books WHERE shipment_id')){hook=null;sql(`UPDATE books SET price_pence=0 WHERE id=${b}`);}};
 assert.equal((await app.openShipment(sid)).ok,true);assert.equal(row(`SELECT price_pence p FROM books WHERE id=${b}`).p,0);
});
await test('S01 300-title import, open and complete receipt',async()=>{
 const sid=shipment();sql(`UPDATE shipments SET status='draft' WHERE id=${sid}`);
 const lines=Array.from({length:300},(_,i)=>({title:'Scale title '+i,raw:'Scale title '+i,pricePence:1000,volumes:1,stock:1,index:i+1,script:'latin'}));
 assert.equal(await app.importLines(sid,lines),300);
 assert.equal((await app.openShipment(sid)).ok,true);
 const ids=execute(`SELECT id FROM books WHERE shipment_id=${sid}`)[0];
 const result=await receive(sid,ids.map(b=>[b.id,1]));
 assert.equal(row(`SELECT COUNT(*) n FROM books WHERE shipment_id=${sid} AND stock=1 AND incoming=0`).n,300);
});
console.log(JSON.stringify(outcomes,null,2));
} finally {rmSync(temp,{recursive:true,force:true});}
