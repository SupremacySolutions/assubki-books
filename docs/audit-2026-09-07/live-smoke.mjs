// Read-only public pages with no order tokens or search-query logging.
import {writeFileSync} from 'node:fs';
const records=[];
for(const path of ['/','/catalogue','/shipments','/contact','/delivery','/about','/order','/admin/login']){
 const res=await fetch('https://assubkibooks.co.uk'+path,{redirect:'manual',signal:AbortSignal.timeout(20000)});
 const text=await res.text();records.push({path,status:res.status,location:res.headers.get('location'),title:/<title>(.*?)<\/title>/s.exec(text)?.[1],headers:Object.fromEntries([...res.headers].filter(([k])=>['content-security-policy','strict-transport-security','x-content-type-options','cache-control','referrer-policy','cf-cache-status'].includes(k)))});
}
writeFileSync('docs/audit-2026-09-07/evidence/live-smoke.json',JSON.stringify(records,null,2));console.log(records.map(r=>r.path+' '+r.status).join('\n'));
