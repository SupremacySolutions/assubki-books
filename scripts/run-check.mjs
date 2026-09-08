// Share one slot across checkouts so tests/builds do not compete for RAM.
import { openSync, readFileSync, writeFileSync, closeSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { managed, shutdownHooks } from './lib/managed-process.mjs';

// Do not build over an interactive server or compete with it for local state.
try {
  const server = JSON.parse(readFileSync('.cache/dev-server.json', 'utf8'));
  let command = '';
  try { command = execFileSync('ps', ['-p', String(server.pid), '-o', 'command='], { encoding: 'utf8' }); } catch {}
  if (command.includes(server.token)) throw new Error('Stop the managed server with npm run dev:stop before running checks or image sync.');
} catch (error) { if (error.code !== 'ENOENT') throw error; }

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

const job = managed(command, args);
const dispose = shutdownHooks(job.stop);
try { process.exitCode = await job.exited; }
finally { await job.stop(); dispose(); }
