// Share one slot across checkouts so tests/builds do not compete for RAM.
import { openSync, readFileSync, writeFileSync, closeSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const lock = join(tmpdir(), 'assubki-books-check.lock');
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('Usage: node scripts/run-check.mjs <command> [args...]');

let fd;
try {
  fd = openSync(lock, 'wx', 0o600);
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  const owner = readFileSync(lock, 'utf8').trim();
  console.error(`Another check owns ${lock} (PID ${owner || 'starting'}). Wait for it to finish.`);
  console.error('If that process has exited after a forced shutdown, remove that stale lock and retry.');
  process.exit(1);
}
writeFileSync(fd, String(process.pid));
closeSync(fd);
process.on('exit', () => {
  try { unlinkSync(lock); } catch {}
});

// A separate process group lets Ctrl-C stop Wrangler/esbuild children too.
const grouped = process.platform !== 'win32';
const child = spawn(command, args, { stdio: 'inherit', detached: grouped });
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    try {
      if (grouped) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {}
  });
}
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('close', (code, signal) => {
  process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1);
});
