/**
 * How many checks may run on this machine at once, and who is holding them.
 *
 * There used to be one lock for the whole machine, and a second check exited
 * with an explanation instead of running. That was written for one person at
 * one terminal on an eight-gigabyte Mac, where two Astro builds at once is how
 * you get an out-of-memory failure that looks like a test failure.
 *
 * It stops working the moment several agents each have their own workspace:
 * every one of them wants to typecheck, and a refusal is indistinguishable
 * from a broken build to whatever is reading the exit code. So the limit stays
 * - the machine has not got any bigger - but reaching it now *queues* rather
 * than refuses. Waiting is slow; failing is wrong.
 *
 * A slot is a file created with `wx`, which is atomic: two processes racing for
 * the last slot cannot both win. Each records who holds it, so a slot whose
 * owner was force-killed can be told from one that is genuinely busy.
 */

import { openSync, writeFileSync, closeSync, readFileSync, readdirSync, unlinkSync, mkdirSync } from 'node:fs';
import { tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';

/**
 * Resolved on each call, not at import.
 *
 * A constant here reads `TMPDIR` once when the module loads, which makes the
 * directory impossible to point elsewhere afterwards - so the tooling test
 * would have shared the real slots with the very `run-check` that is running
 * it, and asked whether two heavy jobs can coexist on a machine that already
 * had one.
 */
export const slotDir = () => join(tmpdir(), 'assubki-books-checks');

/**
 * One slot per four gigabytes, never fewer than two, never more than eight.
 *
 * Two is the floor because the whole point is that a second workspace can
 * work; one slot with a queue is just the old lock with extra waiting. An
 * Astro build peaks well under two gigabytes, so four each leaves room for the
 * machine itself. `ASSUBKI_CHECK_SLOTS` overrides it for a machine that knows
 * better than this arithmetic does.
 */
export function slotCount() {
  const override = Number(process.env.ASSUBKI_CHECK_SLOTS);
  if (Number.isInteger(override) && override > 0) return override;
  return Math.max(2, Math.min(8, Math.floor(totalmem() / (4 * 1024 ** 3))));
}

/** Whether a process is still there. EPERM means alive but not ours. */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function read(file) {
  try { return JSON.parse(readFileSync(join(slotDir(), file), 'utf8')); }
  catch { return null; }
}

/**
 * The checks running right now, with dead owners cleared on the way past.
 *
 * A crashed or force-killed check leaves its file behind, and a slot nobody
 * holds must not cost the next workspace its turn - that is the stale-lock
 * problem the old design made everybody solve by hand.
 */
export function activeChecks() {
  const dir = slotDir();
  mkdirSync(dir, { recursive: true });
  const held = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.slot')) continue;
    const record = read(file);
    if (record && alive(record.pid)) held.push({ ...record, file });
    else { try { unlinkSync(join(dir, file)); } catch {} }
  }
  return held;
}

/**
 * Takes a slot, waiting for one if they are all busy.
 *
 * Returns a `release` that is safe to call twice. The timeout is a backstop
 * against a slot held by something that will never finish, not a normal path:
 * it fails loudly and names who it was waiting for, because "the check timed
 * out" with no owner is the least useful thing this could say.
 */
export async function acquireSlot({ weight = 1, timeoutMs = 45 * 60 * 1000, onWait } = {}) {
  const slots = slotCount();
  // A job heavier than the whole machine still has to run; it simply gets all
  // of it. Without this, a two-slot machine could never start the E2E suite.
  const want = Math.max(1, Math.min(weight, slots));
  const deadline = Date.now() + timeoutMs;
  let announced = false;

  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const take = (i) => {
    const path = join(slotDir(), `${i}.slot`);
    let fd;
    try { fd = openSync(path, 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') return null;
      throw error;
    }
    writeFileSync(fd, JSON.stringify({
      pid: process.pid, token, cwd: process.cwd(), at: Date.now(), weight: want,
      command: process.argv.slice(2).join(' ').slice(0, 200),
    }));
    closeSync(fd);
    return path;
  };
  // Only ever remove our own: a slot reclaimed as stale may since have been
  // taken by somebody else, and unlinking theirs would let a further check in
  // over the limit.
  const give = (path) => {
    const i = Number(path.split('/').pop().replace('.slot', ''));
    // Matched on the token, not the PID: one process may hold two acquisitions
    // at once, and releasing by PID would let either of them free the other's.
    if (read(`${i}.slot`)?.token === token) { try { unlinkSync(path); } catch {} }
  };

  for (;;) {
    const busy = activeChecks();
    const mine = [];
    for (let i = 0; i < slots && mine.length < want; i++) {
      const path = take(i);
      if (path) mine.push(path);
    }

    if (mine.length === want) {
      let released = false;
      return {
        slots: mine.length,
        release() {
          if (released) return;
          released = true;
          for (const path of mine) give(path);
        },
      };
    }

    /*
     * Could not get enough of them. Give back what we did take before waiting:
     * two heavy jobs each holding half the machine and waiting for the other
     * half would sit there until the timeout. The jitter is what stops them
     * then retrying in lockstep for ever.
     */
    for (const path of mine) give(path);

    if (Date.now() > deadline) {
      throw new Error(
        `Waited ${Math.round(timeoutMs / 60000)} minutes for ${want} of ${slots} check slots. Held by: ` +
        `${busy.map((b) => `PID ${b.pid} (${b.cwd})`).join(', ') || 'nobody, which means a slot file could not be created'}.`,
      );
    }
    if (!announced) {
      announced = true;
      onWait?.(busy, slots, want);
    }
    await new Promise((r) => setTimeout(r, 300 + Math.random() * 400));
  }
}

/**
 * What a command costs.
 *
 * The E2E suite builds the Worker and then runs `wrangler dev` beside the
 * assertions, and on an eight-gigabyte machine two of those at once is enough
 * for the OS to kill one of the servers - which surfaces as `TypeError:
 * terminated` and every suite after it "crashing", a failure that has nothing
 * to do with the code under test and takes a while to disbelieve. Weighing it
 * at two keeps a second heavy run out while still letting light checks share.
 */
export function weightOf(argv) {
  const line = argv.join(' ');
  return /run-e2e\.mjs/.test(line) ? 2 : 1;
}
