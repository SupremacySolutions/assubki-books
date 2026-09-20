import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSqlite } from './lib/sqlite-read.mjs';

const temp = mkdtempSync(join(tmpdir(), 'assubki-e2e-db-'));
// URI punctuation and spaces must stay part of the filename.
const file = join(temp, 'assertions #1?.sqlite');
const select = async sql => JSON.parse((await readSqlite(file, sql)).stdout);
let writer, writerExited;
try {
  execFileSync('sqlite3', [file, `
    PRAGMA journal_mode=WAL;
    CREATE TABLE example (id INTEGER PRIMARY KEY);
    INSERT INTO example VALUES (1);
    PRAGMA wal_checkpoint(TRUNCATE);
  `]);
  // All connections have exited and the WAL is checkpointed. Emulate the
  // sidecar cleanup performed when the local D1 runtime closes an idle DB.
  if (existsSync(file + '-wal')) assert.equal(statSync(file + '-wal').size, 0);
  for (const suffix of ['-wal', '-shm']) rmSync(file + suffix, { force: true });
  assert.deepEqual(await select('SELECT * FROM example'), [{ id: 1 }]);
  console.log('PASS reads a closed WAL database without sidecars, including URI punctuation');

  await assert.rejects(readSqlite(file, 'INSERT INTO example VALUES (2)'), /readonly/i);
  assert.deepEqual(await select('SELECT * FROM example'), [{ id: 1 }]);
  console.log('PASS SQL writes remain forbidden');

  const missing = join(temp, 'missing.sqlite');
  await assert.rejects(readSqlite(missing, 'SELECT 1'), /unable to open/i);
  assert.equal(existsSync(missing), false);
  console.log('PASS a missing database is refused without creating it');

  writer = spawn('sqlite3', [file], { stdio: ['pipe', 'pipe', 'pipe'] });
  writerExited = new Promise(resolve => writer.once('exit', resolve));
  let error = '';
  writer.stderr.on('data', chunk => { error += chunk; });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('SQLite writer did not become ready: ' + error)), 5000);
    let output = '';
    writer.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('READY')) { clearTimeout(timeout); resolve(); }
    });
    writer.once('error', err => { clearTimeout(timeout); reject(err); });
    writer.stdin.write('PRAGMA wal_autocheckpoint=0; INSERT INTO example VALUES (3);\n.print READY\n');
  });
  assert.ok(statSync(file + '-wal').size > 0);
  assert.deepEqual(await select('SELECT * FROM example ORDER BY id'), [{ id: 1 }, { id: 3 }]);
  console.log('PASS assertions see committed WAL data while its writer stays open');
} finally {
  if (writer) {
    writer.stdin.end();
    const timeout = setTimeout(() => writer.kill('SIGKILL'), 5000);
    await writerExited;
    clearTimeout(timeout);
  }
  rmSync(temp, { recursive: true, force: true });
}
