/** Machine-wide check capacity and exclusive checkout ownership.
 * SQLite transactions publish complete leases atomically. An interrupted
 * writer cannot expose an empty slot or let another process steal its claim.
 * sqlite3 is already required by this project's local database/test tooling.
 */
import { mkdirSync, existsSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const slotDir = () => join(tmpdir(), 'assubki-books-checks');
export function slotCount() {
  const override = Number(process.env.ASSUBKI_CHECK_SLOTS);
  if (Number.isInteger(override) && override > 0) return override;
  return Math.max(2, Math.min(8, Math.floor(totalmem() / (4 * 1024 ** 3))));
}
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
function database() {
  const dir = slotDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'leases.sqlite');
  query(path, `CREATE TABLE IF NOT EXISTS leases (
    token TEXT PRIMARY KEY, pid INTEGER NOT NULL, cwd TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL, weight INTEGER NOT NULL, capacity INTEGER NOT NULL,
    command TEXT NOT NULL, at INTEGER NOT NULL
  );`);
  return path;
}
function query(path, sql) {
  const output = execFileSync('sqlite3', ['-batch', '-bail', '-json', '-cmd', '.timeout 5000', path], {
    input: sql, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
  }).trim();
  return output ? JSON.parse(output) : [];
}
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}
function active(path) {
  const records = query(path, 'SELECT * FROM leases;');
  const dead = records.filter(record => !alive(record.pid));
  // Delete by immutable acquisition token, not pathname or PID. A concurrent
  // replacement has a different token and cannot be removed by this snapshot.
  if (dead.length) query(path, `DELETE FROM leases WHERE token IN (${dead.map(r => quote(r.token)).join(',')});`);
  return records.filter(record => alive(record.pid));
}
export function activeChecks() {
  return active(database()).filter(record => record.kind === 'check');
}
function claim(path, { kind, cwd, weight, capacity }) {
  const token = randomUUID();
  const command = process.argv.slice(2).join(' ').slice(0, 200);
  const admitted = query(path, `BEGIN IMMEDIATE;
    INSERT INTO leases(token,pid,cwd,kind,weight,capacity,command,at)
      SELECT ${quote(token)},${process.pid},${quote(cwd)},${quote(kind)},${weight},${capacity},${quote(command)},${Date.now()}
      WHERE NOT EXISTS (SELECT 1 FROM leases WHERE cwd=${quote(cwd)})
      ${kind === 'check' ? `AND (SELECT COALESCE(SUM(weight),0) FROM leases WHERE kind='check') + ${weight}
        <= MIN(${capacity}, (SELECT COALESCE(MIN(capacity),${capacity}) FROM leases WHERE kind='check'))` : ''};
    SELECT token FROM leases WHERE token=${quote(token)};
    COMMIT;`);
  if (!admitted.length) return null;
  let released = false;
  return {
    slots: weight,
    release() {
      if (released) return;
      if (existsSync(path)) query(path, `DELETE FROM leases WHERE token=${quote(token)};`);
      released = true;
    },
  };
}

/** Servers do not consume check capacity, but share the SAME checkout mutex. */
export function acquireServer({ cwd = process.cwd() } = {}) {
  cwd = realpathSync(cwd);
  const path = database();
  active(path);
  const lease = claim(path, { kind: 'server', cwd, weight: 0, capacity: slotCount() });
  if (!lease) throw new Error('This checkout is already running a check or managed server. Wait for it, or use npm run dev:stop.');
  return lease;
}

/** Wait without reserving partial capacity or a checkout; admission rechecks
 * both together in one transaction, even if a server started during the wait.
 */
export async function acquireSlot({ weight = 1, timeoutMs = 45 * 60 * 1000, onWait, signal, cwd = process.cwd() } = {}) {
  cwd = realpathSync(cwd);
  const path = database(), slots = slotCount();
  const want = Math.max(1, Math.min(weight, slots));
  const deadline = Date.now() + timeoutMs;
  let announced = false;
  for (;;) {
    signal?.throwIfAborted();
    const busy = active(path);
    const lease = claim(path, { kind: 'check', cwd, weight: want, capacity: slots });
    if (lease) return lease;
    if (Date.now() > deadline) throw new Error(
      `Waited ${Math.round(timeoutMs / 60000)} minutes for ${want} of ${slots} check slots and exclusive checkout access. Held by: ` +
      busy.map(b => `PID ${b.pid} (${b.cwd}, ${b.kind})`).join(', '),
    );
    if (!announced) { announced = true; onWait?.(busy, slots, want); }
    await delay(300 + Math.random() * 400, undefined, { signal });
  }
}
export function weightOf(argv) {
  return /run-e2e\.mjs/.test(argv.join(' ')) ? 2 : 1;
}
