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
let held, job;
const controller = new AbortController();
// Cancellation/parent-death handling must exist while queued, not only after
// admission, or an abandoned queued task can start a new check later.
const dispose = shutdownHooks(async () => {
  controller.abort();
  await job?.stop();
});
process.on('exit', () => held?.release());
try {
  held = await acquireSlot({
    weight: weightOf([command, ...args]), signal: controller.signal,
    onWait: (busy, slots, want) => {
      console.error(`Waiting for ${want} of ${slots} check slots and exclusive access to this checkout.`);
      for (const b of busy) console.error(`  PID ${b.pid}  ${b.cwd}  (${b.kind}: ${b.command})`);
    },
  });
  controller.signal.throwIfAborted();
  job = managed(command, args);
  process.exitCode = await job.exited;
} catch (error) {
  if (!controller.signal.aborted) throw error;
  process.exitCode = 130;
} finally {
  try { await job?.stop(); }
  finally { dispose(); held?.release(); }
}
