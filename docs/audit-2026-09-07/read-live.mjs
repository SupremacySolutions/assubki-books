// Read-only aggregate checks. No row-level customer data or secret values.
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const results=[];
for(const query of readFileSync('docs/audit-2026-09-07/live-checks.sql','utf8').split(';').map(s=>s.trim()).filter(Boolean)){
 if(!/^(SELECT |EXPLAIN QUERY PLAN SELECT |PRAGMA foreign_key_check$)/i.test(query))throw Error('Not an approved read');
 try{
 const raw=execFileSync('node_modules/.bin/wrangler',['d1','execute','assubki-books','--remote','--json','--command',query],{encoding:'utf8',maxBuffer:4e6});
 results.push({query,result:JSON.parse(raw)});
 }catch(e){results.push({query,error:String(e.stdout||e.message).slice(0,500)});}
 writeFileSync('docs/audit-2026-09-07/evidence/live-checks.json',JSON.stringify(results,null,2));
}
console.log(results.length+' live read-only checks recorded');
