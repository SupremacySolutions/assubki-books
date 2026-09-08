import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

// Each command owns a process group. The independent guard also reaps that
// group if this Node process is killed before its finally block can run.
export function managed(command, args = [], options = {}) {
  if (process.platform === 'win32') throw new Error('Managed development currently requires macOS or Linux.');
  const child = spawn(command, args, { ...options, detached: true, stdio: options.stdio ?? 'inherit' });
  let guard;
  let stopping;
  const signal = (name) => {
    if (!child.pid) return;
    try { process.kill(-child.pid, name); } catch (error) { if (!['ESRCH', 'EPERM'].includes(error.code)) throw error; }
  };
  const groupExists = () => {
    if (!child.pid) return false;
    try { process.kill(-child.pid, 0); return true; }
    catch (error) {
      if (error.code === 'ESRCH') return false;
      // A sandboxed workerd can briefly report EPERM during shutdown on macOS.
      if (error.code !== 'EPERM') throw error;
      return execFileSync('ps', ['-axo', 'pgid=,stat='], {encoding:'utf8'}).split('\n').some(line => {
        const [group, state] = line.trim().split(/\s+/);
        return Number(group) === child.pid && !state?.startsWith('Z');
      });
    }
  };
  const stop = () => stopping ??= (async () => {
    signal('SIGTERM');
    for (let i = 0; i < 30; i++) {
      if (!groupExists()) break;
      await delay(100);
    }
    signal('SIGKILL');
    for (let i = 0; i < 30 && groupExists(); i++) await delay(100);
    if (groupExists()) throw new Error(`Process group ${child.pid} did not stop`);
    if (guard?.connected) guard.disconnect();
  })();
  child.once('spawn', () => {
    guard = spawn(process.execPath, [new URL('./process-guard.mjs', import.meta.url).pathname, String(child.pid)], {
      detached: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    guard.on('error', (error) => { console.error(error); void stop(); });
    guard.unref();
  });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    // 'close' can wait forever when a forgotten grandchild inherited stdout.
    child.once('exit', async (code, sig) => {
      try { await stop(); resolve(code ?? (sig === 'SIGINT' ? 130 : 1)); }
      catch (error) { reject(error); }
    });
  });
  return { child, exited, stop };
}

export function shutdownHooks(stop, { timeoutMs = 2 * 60 * 60 * 1000 } = {}) {
  const parent = process.ppid;
  let stopped = false;
  const shutdown = async () => {
    if (stopped) return;
    stopped = true;
    process.exitCode = 130;
    await stop();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  const orphan = setInterval(() => {
    if (process.ppid !== parent || process.ppid === 1) void shutdown();
  }, 500);
  const deadline = setTimeout(() => { console.error('Managed command reached its time limit; stopping.'); void shutdown(); }, timeoutMs);
  orphan.unref(); deadline.unref();
  return () => {
    clearInterval(orphan); clearTimeout(deadline);
    process.off('SIGINT', shutdown); process.off('SIGTERM', shutdown);
  };
}
