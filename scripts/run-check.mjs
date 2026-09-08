// A few checks may share the machine; more than that only competes for RAM.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { managed, shutdownHooks } from './lib/managed-process.mjs';
import { acquireSlot, weightOf } from './lib/check-slots.mjs';

// Do not build over an interactive server or compete with it for local state.
try {
  const server = JSON.parse(readFileSync('.cache/dev-server.json', 'utf8'));
  let command = '';
  try { command = execFileSync('ps', ['-p', String(server.pid), '-o', 'command='], { encoding: 'utf8' }); } catch {}
  if (command.includes(server.token)) throw new Error('Stop the managed server with npm run dev:stop before running checks or image sync.');
} catch (error) { if (error.code !== 'ENOENT') throw error; }

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('Usage: node scripts/run-check.mjs <command> [args...]');

/*
 * Queue for a slot rather than refusing one.
 *
 * A refusal exits non-zero, and nothing reading an exit code can tell "the
 * machine was busy" from "your code is broken" - which is the whole difficulty
 * with several workspaces each running their own checks. Waiting says the same
 * thing honestly and still finishes.
 */
const held = await acquireSlot({
  weight: weightOf([command, ...args]),
  onWait: (busy, slots, want) => {
    console.error(`Waiting for ${want} of ${slots} check slots; the machine is busy.`);
    for (const b of busy) console.error(`  PID ${b.pid}  ${b.cwd}${b.command ? `  (${b.command})` : ''}`);
    console.error('Set ASSUBKI_CHECK_SLOTS to change how many run at once.');
  },
});
process.on('exit', () => held.release());

const job = managed(command, args);
const dispose = shutdownHooks(job.stop);
try { process.exitCode = await job.exited; }
finally { await job.stop(); dispose(); held.release(); }
