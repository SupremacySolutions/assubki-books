import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const temp = mkdtempSync(join(tmpdir(), 'assubki-tooling-'));
const moduleUrl = new URL('./lib/managed-process.mjs', import.meta.url).href;
const live = pid => {
  try { return !/^Z/.test(execFileSync('ps', ['-p', String(pid), '-o', 'stat='], {encoding:'utf8'}).trim()); }
  catch { return false; }
};
async function waitFor(fn) {
  for(let i=0;i<120;i++){ if(await fn()) return; await delay(100); }
  throw new Error('Timed out waiting for process lifecycle');
}
const managers = [];
try {
  writeFileSync(join(temp,'listener.mjs'), `import {createServer} from 'node:net'; import {writeFileSync} from 'node:fs';
const server=createServer(); server.listen(0,'127.0.0.1',()=>writeFileSync(process.env.PIDS,JSON.stringify({pid:process.pid,port:server.address().port})));`);
  writeFileSync(join(temp,'parent.mjs'), `import {spawn} from 'node:child_process';
spawn(process.execPath,[${JSON.stringify(join(temp,'listener.mjs'))}],{stdio:'inherit'});
if(process.env.CASE==='normal') setTimeout(()=>process.exit(0),500);
else setInterval(()=>{},1000);`);
  writeFileSync(join(temp,'manager.mjs'), `import {managed,shutdownHooks} from ${JSON.stringify(moduleUrl)};
const job=managed(process.execPath,[${JSON.stringify(join(temp,'parent.mjs'))}]);
const dispose=shutdownHooks(job.stop,{timeoutMs:process.env.CASE==='timeout'?1500:30000});
try {process.exitCode=await job.exited;} finally {await job.stop();dispose();}`);
  for(const mode of ['normal','SIGINT','SIGTERM','SIGKILL','timeout']) {
    const pids=join(temp,mode+'.json');
    const manager=spawn(process.execPath,[join(temp,'manager.mjs')],{env:{...process.env,PIDS:pids,CASE:mode},stdio:'ignore'});
    managers.push(manager);
    const done=new Promise(r=>manager.once('exit',(code,signal)=>r({code,signal})));
    await waitFor(()=>existsSync(pids));
    const listener=JSON.parse(readFileSync(pids,'utf8'));
    if(mode.startsWith('SIG')) manager.kill(mode);
    const result=await done;
    await waitFor(()=>!live(listener.pid));
    if(mode==='normal') assert.equal(result.code,0);
    else assert.ok(result.code!==0 || result.signal);
    console.log(`PASS ${mode}: owned listener and descendants stopped`);
  }
  // Direct invocation must refuse before trying to read credentials or touch a server.
  for(const args of [['--prod'],[]]) {
    const child=spawn(process.execPath,['scripts/e2e.mjs',...args],{stdio:['ignore','ignore','pipe'],env:{PATH:process.env.PATH}});
    let error=''; child.stderr.on('data',chunk=>error+=chunk);
    const code=await new Promise(r=>child.once('exit',r));
    assert.notEqual(code,0);
    assert.match(error,/Run npm run test:e2e/);
  }
  console.log('PASS mutation E2E refuses direct and production invocation');
} finally {
  for(const manager of managers) if(manager.exitCode===null && manager.signalCode===null) manager.kill('SIGTERM');
  rmSync(temp,{recursive:true,force:true});
}
