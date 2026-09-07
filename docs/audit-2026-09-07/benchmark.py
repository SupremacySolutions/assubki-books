"""Disposable SQLite query-plan and write-amplification comparison; no live writes."""
import sqlite3,json,time,pathlib
root=pathlib.Path(__file__).resolve().parents[2]
c=sqlite3.connect(':memory:');c.execute('PRAGMA trusted_schema=ON')
for f in sorted((root/'migrations').glob('*.sql')):c.executescript(f.read_text())
c.executemany("INSERT INTO orders(ref,access_token,customer_name,email,fulfilment,status,subtotal_pence) VALUES (?,'test','Test','test@example.invalid','collection','requested',1000)",[(f'BENCH{i}',) for i in range(10000)])
c.executemany("INSERT INTO messages(order_id,sender,via,body,created_at) VALUES (1,'customer','web','Benchmark',?)",[(i,) for i in range(10000)])
c.executemany("INSERT INTO public_actions(action,ip,at) VALUES ('order',?,?)",[(str(i),i) for i in range(10000)])
results=[]
def profile(name,q,args=()):
 plan=[list(r) for r in c.execute('EXPLAIN QUERY PLAN '+q,args)]; steps=[0]
 def tick():steps[0]+=100
 c.set_progress_handler(tick,100);start=time.perf_counter();rows=c.execute(q,args).fetchall();elapsed=(time.perf_counter()-start)*1000;c.set_progress_handler(None,0)
 return {'name':name,'query':q,'rows':len(rows),'approx_vm_steps':steps[0],'milliseconds':round(elapsed,3),'plan':plan}
q='SELECT id,sender,body FROM messages WHERE order_id=? AND id>? ORDER BY id'
results.append(profile('message cursor before',q,(1,9990)))
c.execute('CREATE INDEX audit_messages_cursor ON messages(order_id,id)')
results.append(profile('message cursor after',q,(1,9990)))
q='SELECT COUNT(*) FROM public_actions WHERE at<100'
results.append(profile('global throttle cleanup before',q));c.execute('CREATE INDEX audit_public_actions_at ON public_actions(at)');results.append(profile('global throttle cleanup after',q))
# Count SQLite-trigger writes, not D1 billed rows: identical stock mutation.
c.execute("INSERT INTO books(slug,title,status,stock,price_pence) VALUES ('bench-stock','Benchmark','live',100,1000)");bid=c.execute('SELECT last_insert_rowid()').fetchone()[0]
a=c.total_changes;c.execute('UPDATE books SET stock=stock+1 WHERE id=?',(bid,));before=c.total_changes-a
c.execute('DROP TRIGGER books_fts_update');c.executescript("""CREATE TRIGGER books_fts_update AFTER UPDATE OF title,title_ar,title_ur,author,description_html ON books BEGIN
INSERT INTO books_fts(books_fts,rowid,title,title_ar,title_ur,author,description_html) VALUES ('delete',old.id,old.title,old.title_ar,old.title_ur,old.author,old.description_html);
INSERT INTO books_fts(rowid,title,title_ar,title_ur,author,description_html) VALUES (new.id,new.title,new.title_ar,new.title_ur,new.author,new.description_html); END;""")
a=c.total_changes;c.execute('UPDATE books SET stock=stock+1 WHERE id=?',(bid,));after=c.total_changes-a
results.append({'name':'stock update FTS write amplification','sqlite_changes_before':before,'sqlite_changes_after':after})
c.execute('UPDATE books SET title=? WHERE id=?',('Findable replacement',bid));assert c.execute("SELECT COUNT(*) FROM books_fts WHERE books_fts MATCH 'Findable'").fetchone()[0]==1
results.append({'name':'narrowed FTS trigger still indexes title changes','passed':True})
(root/'docs/audit-2026-09-07/evidence/query-benchmarks.json').write_text(json.dumps(results,indent=2));print(json.dumps(results,indent=2))
