import {writeFileSync} from 'node:fs';
const origin='https://assubkibooks.co.uk';
const cat=await(await fetch(origin+'/catalogue')).text();
const path=cat.match(/href="(\/book\/[^"?#]+)"/)?.[1];if(!path)throw Error('No observed book link');
const r=await fetch(origin+path),html=await r.text();const results={path,status:r.status,scripts:[]};
for(const m of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)){
 const url=new URL(m[1],origin);if(url.origin!==origin)continue;
 const code=await(await fetch(url)).text();const at=code.indexOf('/api/group/line');if(at<0)continue;
 results.scripts.push({path:url.pathname,groupRequestExcerpt:code.slice(Math.max(0,at-60),at+500)});
}
writeFileSync('docs/audit-followup-2026-09-07/evidence/live-product.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
