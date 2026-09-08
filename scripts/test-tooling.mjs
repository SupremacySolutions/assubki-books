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

  /*
   * Several workspaces must be able to check at once, and the one that arrives
   * when they are all busy must wait rather than fail - an exit code cannot say
   * "the machine was busy" and "your code is broken" differently.
   */
  const slots = join(temp, 'slots');
  const runCheck = new URL('./run-check.mjs', import.meta.url).pathname;
  const checkEnv = (n, cwd) => ({ ...process.env, ASSUBKI_CHECK_SLOTS: String(n), TMPDIR: slots, ...(cwd ? { PWD: cwd } : {}) });
  mkdirSync(slots, { recursive: true });

  // Two slots, two checks: both run at once rather than one refusing.
  const started = [];
  const pair = ['a', 'b'].map(name => {
    const child = spawn(process.execPath, [runCheck, process.execPath, '-e', `
      import('node:fs').then(fs => fs.writeFileSync(${JSON.stringify(join(temp, 'x'))} + '${name}', '1'));
      setTimeout(() => {}, 2500);`], { env: checkEnv(2), stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; child.stderr.on('data', c => err += c);
    started.push(child);
    return { child, name, err: () => err, done: new Promise(r => child.once('exit', r)) };
  });
  await waitFor(() => pair.every(p => existsSync(join(temp, 'x' + p.name))));
  console.log('PASS two workspaces run their checks concurrently');

  // A third, with both slots busy, waits and then succeeds.
  const third = spawn(process.execPath, [runCheck, process.execPath, '-e', '0'], { env: checkEnv(2), stdio: ['ignore', 'ignore', 'pipe'] });
  let thirdErr = ''; third.stderr.on('data', c => thirdErr += c);
  const thirdCode = await new Promise(r => third.once('exit', r));
  assert.equal(thirdCode, 0, 'a queued check must succeed, not fail');
  assert.match(thirdErr, /Waiting for \d+ of \d+ check slots/);
  await Promise.all(pair.map(p => p.done));
  console.log('PASS a check beyond the limit queues and still succeeds');

  /*
   * A slot whose owner was force-killed must not cost anybody their turn. This
   * is the stale-lock problem the single lock made everybody solve by hand, so
   * the dead PID here is a real one that really exited rather than a number
   * chosen for being improbable.
   */
  const corpse = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' });
  const deadPid = corpse.pid;
  corpse.kill('SIGKILL');
  await new Promise(r => corpse.once('exit', r));
  await waitFor(() => !live(deadPid));
  const staleDir = join(slots, 'assubki-books-checks');
  mkdirSync(staleDir, { recursive: true });
  for (const i of [0, 1]) writeFileSync(join(staleDir, `${i}.slot`), JSON.stringify({ pid: deadPid, cwd: '/gone', at: Date.now() }));
  const revived = spawn(process.execPath, [runCheck, process.execPath, '-e', '0'], { env: checkEnv(2), stdio: ['ignore', 'ignore', 'pipe'] });
  let revivedErr = ''; revived.stderr.on('data', c => revivedErr += c);
  assert.equal(await new Promise(r => revived.once('exit', r)), 0, 'a slot held by a dead PID must be reclaimed');
  assert.doesNotMatch(revivedErr, /waiting/, 'and reclaimed without waiting for it');
  console.log('PASS a slot left by a force-killed check is reclaimed');

  /*
   * The E2E suite weighs two, because two of them at once on a small machine
   * gets one of their servers killed by the OS. A light check may share what is
   * left; a second heavy one must wait. And two heavy jobs must never each grab
   * half the machine and wait for the other half for ever.
   */
  const { acquireSlot, weightOf, slotDir } = await import(new URL('./lib/check-slots.mjs', import.meta.url).href);
  assert.equal(weightOf(['node', 'scripts/run-e2e.mjs']), 2);
  assert.equal(weightOf(['astro', 'check']), 1);

  // Its own directory: these must not share slots with the run-check that is
  // running this test, which already holds one of the real ones.
  process.env.TMPDIR = join(temp, 'w');
  mkdirSync(slotDir(), { recursive: true });
  process.env.ASSUBKI_CHECK_SLOTS = '4';
  const heavy = await acquireSlot({ weight: 2 });
  assert.equal(heavy.slots, 2, 'a heavy job takes two slots');
  const light = await acquireSlot({ weight: 1, timeoutMs: 3000 });
  assert.equal(light.slots, 1, 'a light check still fits beside it');
  await assert.rejects(
    acquireSlot({ weight: 2, timeoutMs: 1500 }),
    /Waited .* for 2 of 4 check slots/,
    'a second heavy job waits rather than squeezing in',
  );
  heavy.release(); light.release();

  // Deadlock check: with two slots, two heavy jobs must not hold one each.
  process.env.ASSUBKI_CHECK_SLOTS = '2';
  const [first, second] = await Promise.allSettled([
    acquireSlot({ weight: 2, timeoutMs: 4000 }),
    acquireSlot({ weight: 2, timeoutMs: 4000 }),
  ]);
  const winners = [first, second].filter(r => r.status === 'fulfilled');
  assert.equal(winners.length, 1, 'exactly one heavy job wins; the other waits rather than deadlocking');
  winners[0].value.release();
  console.log('PASS the heavy suite excludes a second one without deadlocking');
} finally {
  for(const manager of managers) if(manager.exitCode===null && manager.signalCode===null) manager.kill('SIGTERM');
  rmSync(temp,{recursive:true,force:true});
}
