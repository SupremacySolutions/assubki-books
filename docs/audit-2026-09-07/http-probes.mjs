// Only disposable local targets. This script deliberately sends malformed requests.
import {readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const base=process.env.AUDIT_SITE??'http://localhost:4347';
if(!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(base))throw Error('Local test target required');
function files(dir){return readdirSync(dir,{withFileTypes:true}).flatMap(d=>d.isDirectory()?files(join(dir,d.name)):[join(dir,d.name)]);}
const routes=files('src/pages').filter(p=>p.endsWith('.ts')).flatMap(source=>{
 const text=readFileSync(source,'utf8'),methods=[...text.matchAll(/export const (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ALL)/g)].map(m=>m[1]);
 const route='/'+source.slice('src/pages/'.length,-3).replace(/\/index$/,'');return methods.map(method=>({source,route,method,methods}));
});
const login=await fetch(base+'/api/admin/login',{method:'POST',redirect:'manual',headers:{Origin:base},body:new URLSearchParams({password:'isolated-audit-only'})});
let cookie=login.headers.get('set-cookie')?.split(';')[0];if(!cookie)throw Error('Could not authenticate isolated test session');
const out=[];
async function probe(route,method,mode){
 const path=route.replace(/\[\.\.\.[^\]]+\]/g,'audit-missing.jpg').replace(/\[ref\]/g,'ASB-ZZZZ').replace(/\[[^\]]+\]/g,'9999999');
 if(mode!=='unauthenticated' && route.startsWith('/api/admin/')) {
  const signed=await fetch(base+'/api/admin/login',{method:'POST',redirect:'manual',headers:{Origin:base},body:new URLSearchParams({password:'isolated-audit-only'})});
  cookie=signed.headers.get('set-cookie')?.split(';')[0];if(!cookie)throw Error('Test session renewal failed');
 }
 const headers={Origin:mode==='csrf'?'https://evil.invalid':base};if(mode!=='unauthenticated')headers.Cookie=cookie;
 let body;
 if(!['GET','HEAD'].includes(method)){if(mode==='malformed'){headers['Content-Type']='application/json';body='{';}else body=new URLSearchParams();}
 const res=await fetch(base+path,{method,headers,body,redirect:'manual',signal:AbortSignal.timeout(15000)});
 return {mode,method,status:res.status,location:res.headers.get('location')?.replace(/([?&]t=)[^&#]*/g,'$1REDACTED')??null};
}
for(const x of routes){
 const observations=[];
 for(const mode of ['unauthenticated','authenticated-empty',...(['GET','HEAD'].includes(x.method)?[]:['malformed','csrf'])]){
  try{observations.push(await probe(x.route,x.method,mode));}catch(e){observations.push({mode,error:e.message});}
 }
 const unsupported=['PUT','PATCH','DELETE','POST'].find(m=>!x.methods.includes(m));
 if(unsupported){try{observations.push({...await probe(x.route,unsupported,'authenticated-empty'),mode:'unsupported-method'});}catch(e){observations.push({mode:'unsupported-method',error:e.message});}}
 out.push({...x,observations});writeFileSync('docs/audit-2026-09-07/evidence/http-probes.json',JSON.stringify(out,null,2));
}
// Edge cases outside the generic matrix.
const extra=[];
for(const [name,path,opts] of [
 ['malformed admin cookie','/admin',{headers:{Cookie:'asb_admin=%'}}],
 ['login external backslash redirect','/api/admin/login',{method:'POST',headers:{Origin:base},body:new URLSearchParams({password:'isolated-audit-only',next:'/\\evil.invalid'})}],
 ['public proof prefix','/img/proofs/1/audit.jpg',{}],
 ['path traversal','/img/uploads/%2e%2e/%2e%2e/proofs/audit.jpg',{}]
]){const r=await fetch(base+path,{...opts,redirect:'manual'});extra.push({name,status:r.status,location:r.headers.get('location')});}
writeFileSync('docs/audit-2026-09-07/evidence/http-extra.json',JSON.stringify(extra,null,2));console.log(out.length+' endpoint/method pairs probed');
