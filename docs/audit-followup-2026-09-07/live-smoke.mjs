import {writeFileSync} from 'node:fs';
const origin='https://assubkibooks.co.uk';
const results=[];
for(const path of ['/','/catalogue','/catalogue?q=fiqh','/shipments','/basket','/admin/login']){
 const r=await fetch(origin+path,{redirect:'manual'}),html=await r.text();
 const row={path,status:r.status,title:html.match(/<title>(.*?)<\/title>/s)?.[1],csp:r.headers.get('content-security-policy')};
 if(path==='/basket'){
  row.organiserCopy=html.includes('the person who started the group can change anything');
  const scripts=[...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(m=>m[1]);row.scripts=[];
  for(const src of scripts){const u=new URL(src,origin);if(u.origin!==origin)continue;const a=await fetch(u),code=await a.text();row.scripts.push({path:u.pathname,status:a.status,memberToken:code.includes('memberToken')});}
 }
 results.push(row);
}
writeFileSync('docs/audit-followup-2026-09-07/evidence/live-smoke.json',JSON.stringify(results,null,2));console.log(results.map(r=>r.path+': '+r.status).join('\n'));
