import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const execFileAsync = promisify(execFile);

/** Read SQL without relying on another runtime keeping WAL sidecars open. */
export function readSqlite(file, sql) {
  // macOS sqlite3 -readonly cannot open a WAL database after its last writer
  // closes and removes -wal/-shm. Allow SQLite to recreate those sidecars, but
  // keep SQL writes forbidden. mode=rw also refuses a missing database rather
  // than silently creating an empty one. Never use immutable: the server can
  // still be writing, and assertions must see committed WAL data.
  const uri = pathToFileURL(resolve(file));
  uri.searchParams.set('mode', 'rw');
  return execFileAsync('sqlite3', [
    '-json',
    '-cmd', 'PRAGMA query_only=ON',
    '-cmd', 'PRAGMA foreign_keys=ON',
    '-cmd', 'PRAGMA trusted_schema=ON',
    '-cmd', '.timeout 8000',
    uri.href, sql,
  ], { timeout: 60000, maxBuffer: 40 * 1024 * 1024 });
}
