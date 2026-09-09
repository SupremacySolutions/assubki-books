import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
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

  const runCheck = new URL('./run-check.mjs', import.meta.url).pathname;
  const { acquireSlot, acquireServer, activeChecks, weightOf } = await import('./lib/check-slots.mjs');
  const originalTmp = process.env.TMPDIR, originalSlots = process.env.ASSUBKI_CHECK_SLOTS;
  process.env.TMPDIR = join(temp, 'scheduler');
  process.env.ASSUBKI_CHECK_SLOTS = '2';
  const workspace = name => { const path = join(temp,name); mkdirSync(path,{recursive:true}); return path; };
  const launch = (cwd, code) => {
    const child=spawn(process.execPath,[runCheck,process.execPath,'-e',code],{
      cwd, env:{...process.env}, stdio:['ignore','ignore','pipe'],
    });
    managers.push(child);
    let error='';child.stderr.on('data',chunk=>error+=chunk);
    return {child,error:()=>error,done:new Promise(r=>child.once('exit',r))};
  };
  const mark = (file, ms=0) => `require('node:fs').writeFileSync(${JSON.stringify(file)},'1');setTimeout(()=>{},${ms})`;
  const hold = (file, release) => `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(file)},'1');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))clearInterval(timer)},30)`;
  try {
    const a=workspace('a'),b=workspace('b');
    const release=join(temp,'release-pair');
    const pair=[a,b].map(cwd=>launch(cwd,hold(join(cwd,'started'),release)));
    await waitFor(()=>pair.every((p,i)=>existsSync(join([a,b][i],'started'))));
    const thirdMark=join(temp,'third');
    const third=launch(workspace('c'),mark(thirdMark));
    await waitFor(()=>third.error().includes('Waiting for'));
    assert.equal(existsSync(thirdMark),false);
    writeFileSync(release,'1');
    for(const p of [...pair,third]) assert.equal(await p.done,0,p.error());
    console.log('PASS distinct workspaces run concurrently; excess checks queue');

    const same=workspace('same'),one=join(same,'one'),two=join(same,'two'),unlock=join(same,'unlock');
    const first=launch(same,hold(one,unlock));
    await waitFor(()=>existsSync(one));
    // An alias must not become a second checkout lock.
    const alias=join(temp,'alias');
    const {symlinkSync}=await import('node:fs');symlinkSync(same,alias,'dir');
    const second=launch(alias,mark(two));
    await waitFor(()=>second.error().includes('Waiting for'));
    assert.equal(existsSync(two),false);
    assert.throws(()=>acquireServer({cwd:same}),/already running a check/);
    writeFileSync(unlock,'1');
    assert.equal(await first.done,0);assert.equal(await second.done,0);
    console.log('PASS same checkout and symlink aliases serialize; checks exclude servers');

    // Fill all machine capacity, queue a check, THEN start its local server.
    const capacity=await acquireSlot({cwd:workspace('capacity'),weight:2});
    const target=workspace('queued-server'),ran=join(target,'ran');
    const queued=launch(target,mark(ran));
    await waitFor(()=>queued.error().includes('Waiting for'));
    const server=acquireServer({cwd:target});
    capacity.release();
    await delay(1000);assert.equal(existsSync(ran),false);
    server.release();assert.equal(await queued.done,0);assert.ok(existsSync(ran));
    console.log('PASS a server started during the queue wait still excludes the check');

    const blocked=await acquireSlot({cwd:workspace('blocker'),weight:2});
    const never=join(temp,'must-not-run');
    const cancelled=launch(workspace('cancelled'),mark(never));
    await waitFor(()=>cancelled.error().includes('Waiting for'));
    cancelled.child.kill('SIGTERM');assert.notEqual(await cancelled.done,0);
    blocked.release();assert.equal(existsSync(never),false);
    console.log('PASS cancellation while queued never launches the command');

    // Simultaneous real processes, not same-process calls between awaits.
    // Atomic admission must never exceed two even while scanners reap leases.
    const events=join(temp,'events');
    const racers=Array.from({length:12},(_,i)=>launch(workspace('race-'+i),
      `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(events)},'start ${i}\\n');setTimeout(()=>fs.appendFileSync(${JSON.stringify(events)},'end ${i}\\n'),200)`));
    for(const racer of racers)assert.equal(await racer.done,0,racer.error());
    let running=0,peak=0;
    for(const line of readFileSync(events,'utf8').trim().split('\n')){
      running+=line.startsWith('start')?1:-1;peak=Math.max(peak,running);
      assert.ok(running>=0 && running<=2,`capacity breached: ${running}`);
    }
    assert.equal(running,0);assert.equal(peak,2);
    console.log('PASS simultaneous admission never exceeds machine capacity');

    // A completed-but-unreleased lease stands in for a force-killed owner.
    const owner=spawn(process.execPath,['--input-type=module','-e',
      `import {acquireSlot} from ${JSON.stringify(new URL('./lib/check-slots.mjs',import.meta.url).href)};await acquireSlot();`],
      {cwd:workspace('dead'),env:{...process.env},stdio:'ignore'});
    managers.push(owner);assert.equal(await new Promise(r=>owner.once('exit',r)),0);
    assert.ok(!activeChecks().some(r=>r.pid===owner.pid));
    console.log('PASS dead owners are reclaimed without deleting another lease');

    assert.equal(weightOf(['node','scripts/run-e2e.mjs']),2);
    const heavy=await acquireSlot({cwd:workspace('heavy'),weight:2});
    await assert.rejects(acquireSlot({cwd:workspace('other-heavy'),weight:2,timeoutMs:500}),/Waited .* for 2 of 2/);
    heavy.release();
    const next=await acquireSlot({cwd:workspace('other-heavy'),weight:2,timeoutMs:1000});next.release();
    assert.equal(activeChecks().length,0);
    console.log('PASS heavy E2E admission is all-or-nothing and releases all capacity');
  } finally {
    if(originalTmp===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=originalTmp;
    if(originalSlots===undefined)delete process.env.ASSUBKI_CHECK_SLOTS;else process.env.ASSUBKI_CHECK_SLOTS=originalSlots;
  }
} finally {
  for(const manager of managers) if(manager.exitCode===null && manager.signalCode===null) {
    const ended=new Promise(r=>manager.once('exit',r));manager.kill('SIGTERM');await ended;
  }
  rmSync(temp,{recursive:true,force:true});
}
