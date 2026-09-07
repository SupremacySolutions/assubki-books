// Run the backup CLI against a synthetic database through a read-only npx stub,
// then restore its SQL into an empty SQLite database and verify data and search.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const temp = mkdtempSync(join(tmpdir(), 'asb-backup-test-'));
const source = join(temp,'source.db'), restored = join(temp,'restored.db'), backup = join(temp,'backup.sql');
const sqlite = (file, sql) => execFileSync('sqlite3',['-bail','-json','-cmd','PRAGMA trusted_schema=ON',file],{input:sql,encoding:'utf8'});
try {
  sqlite(source,readdirSync('migrations').filter(f=>f.endsWith('.sql')).sort().map(f=>readFileSync(join('migrations',f),'utf8')).join('\n'));
  writeFileSync(join(temp,'npx'),`#!/usr/bin/env node
    const {execFileSync}=require('node:child_process');
    const sql=process.argv.at(-1);
    if (!sql.startsWith('SELECT ')) throw Error('Only reads are allowed');
    const out=execFileSync('sqlite3',['-json',process.env.BACKUP_TEST_DB,sql],{encoding:'utf8'});
    process.stdout.write(JSON.stringify([{results:JSON.parse(out||'[]')}]));
  `,{mode:0o700});
  const env = {...process.env,PATH:temp+':'+process.env.PATH,BACKUP_TEST_DB:source};
  execFileSync('node',['scripts/backup-remote.mjs','--out',backup],{env,stdio:'pipe'});
  assert.equal(statSync(backup).mode & 0o777,0o600);
  sqlite(restored,readFileSync(backup,'utf8'));
  for(const query of ['SELECT COUNT(*) AS n FROM books;',"SELECT COUNT(*) AS n FROM books_fts WHERE books_fts MATCH 'quran';",'PRAGMA foreign_key_check;']) {
    assert.equal(sqlite(restored,query),sqlite(source,query));
  }
  assert.ok(JSON.parse(sqlite(restored,"SELECT COUNT(*) AS n FROM books_fts WHERE books_fts MATCH 'quran';"))[0].n>0);
  const before=readFileSync(backup);
  assert.notEqual(spawnSync('node',['scripts/backup-remote.mjs','--out',backup],{env}).status,0);
  assert.deepEqual(readFileSync(backup),before);
  assert.notEqual(spawnSync('node',['scripts/backup-remote.mjs','--out'],{env}).status,0);
  console.log('PASS backup restores books and FTS search, uses private permissions, and refuses overwrite or a missing path');
} finally {rmSync(temp,{recursive:true,force:true});}
