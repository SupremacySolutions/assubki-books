#!/usr/bin/env node
/**
 * What the live database has, against what the migrations say it should.
 *
 *   node docs/schema-reconciliation/check-schema.mjs           # local D1
 *   node docs/schema-reconciliation/check-schema.mjs --remote  # production
 *
 * Read-only in both directions. The only statement it sends to D1 is a SELECT
 * against `sqlite_master`, which returns schema definitions and no customer
 * data; the reference it compares against is built by replaying the migrations
 * into a temporary SQLite file that is deleted on the way out.
 *
 * Run it before reconciling to see the gap, and again afterwards to see that
 * there is none. Its exit code is 0 when live matches the migrations and 1 when
 * it does not, so it can gate a deploy.
 *
 * Needs the `sqlite3` command and, for --remote, a wrangler that is logged in.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REMOTE = process.argv.includes('--remote');
const DB = 'assubki-books';

/*
 * Objects that belong to the platform rather than to us.
 *
 * `_cf_KV` is Cloudflare's own. `d1_migrations` is wrangler's ledger - the
 * thing whose emptiness caused all of this - and is not described by any
 * migration, so it would otherwise show up for ever as an unexplained extra.
 * The `books_fts_*` shadow tables are created by SQLite when the virtual table
 * is, and are not written down anywhere either.
 */
const PLATFORM = /^(_cf_|d1_migrations$|sqlite_|books_fts_(config|data|docsize|idx)$)/;

/** The schema the migrations produce, built from nothing each time. */
function reference() {
  const dir = mkdtempSync(join(tmpdir(), 'asb-schema-'));
  const file = join(dir, 'reference.db');
  try {
    for (const name of readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort()) {
      /*
       * `trusted_schema=ON` for every file, because the setting is per
       * connection and each migration gets its own.
       *
       * The macOS system `sqlite3` ships with it off, and with it off a trigger
       * is not allowed to name a virtual table - so `books_fts_insert` is
       * rejected on every row the seed adds, the seed's 226 books never land,
       * and each later migration that references them fails a foreign key until
       * the replay is nothing like the schema it is supposed to be. D1 has no
       * such restriction, so this only ever made the reference wrong.
       */
      execFileSync('sqlite3', [file], {
        input: `PRAGMA trusted_schema=ON;\n${readFileSync(join('migrations', name), 'utf8')}`,
      });
    }
    /*
     * JSON, so the newlines survive the trip.
     *
     * A tab-separated dump has to flatten them to keep one object per line, and
     * flattening them before `strip` runs lets every `--` comment swallow the
     * rest of its definition - which reads as half the schema having gone
     * missing. Comments have to be removed while the line breaks that end them
     * are still there.
     */
    const out = execFileSync('sqlite3', ['-json', file], {
      input: 'SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL;',
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    return parse(JSON.parse(out || '[]').map((r) => [r.type, r.name, r.sql]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The schema the database actually has.
 *
 * `ASB_PERSIST_TO` points wrangler at a database directory other than the
 * default `.wrangler/state`, which is how the rehearsal in README.md is done:
 * build a throwaway copy of production's shape, reconcile that first, and keep
 * your working local database out of it.
 */
function live() {
  const persist = process.env.ASB_PERSIST_TO ? ['--persist-to', process.env.ASB_PERSIST_TO] : [];
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', DB, REMOTE ? '--remote' : '--local', ...persist, '--json',
     '--command', 'SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL'],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  const rows = JSON.parse(out.slice(out.indexOf('['))).flatMap((b) => b.results ?? []);
  return parse(rows.map((r) => [r.type, r.name, r.sql]));
}

/*
 * Comments are not schema, and the two sides disagree about them.
 *
 * SQLite stores a definition exactly as it was typed, comments and all - so the
 * reference, replayed from the migration files with `sqlite3`, keeps them.
 * Wrangler strips them before sending, so the same object in D1 does not. Left
 * in, every commented table in the repository reads as a difference, and the
 * real ones are lost in the noise.
 *
 * Line comments go first and take their newline's worth of separation with
 * them, which is why this runs before whitespace is collapsed: doing it the
 * other way round would let a `--` swallow the rest of the definition.
 */
function strip(sql) {
  return String(sql)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/;$/, '');
}

function parse(triples) {
  const map = new Map();
  for (const [type, name, sql] of triples) {
    if (PLATFORM.test(name)) continue;
    map.set(`${type} ${name}`, strip(sql));
  }
  return map;
}

/** The columns of a CREATE TABLE, so a difference can be named rather than dumped. */
function columns(sql) {
  const body = sql.slice(sql.indexOf('(') + 1, sql.lastIndexOf(')'));
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(current.trim()); current = ''; }
    else current += ch;
  }
  parts.push(current.trim());
  return new Map(parts.filter(Boolean).map((c) => [c.split(/[\s(]/)[0].replace(/"/g, ''), c]));
}

const want = reference();
const have = live();

const missing = [...want.keys()].filter((k) => !have.has(k));
const extra = [...have.keys()].filter((k) => !want.has(k));
const differs = [...want.keys()].filter((k) => have.has(k) && have.get(k) !== want.get(k));

console.log(`${REMOTE ? 'production' : 'local'} D1 "${DB}"`);
console.log(`  ${have.size} objects live, ${want.size} expected from migrations/\n`);

if (missing.length) {
  console.log(`MISSING from the database (${missing.length}):`);
  for (const k of missing) console.log(`  ${k}`);
  console.log();
}
if (differs.length) {
  console.log(`DEFINITION DIFFERS (${differs.length}):`);
  for (const k of differs) {
    console.log(`  ${k}`);
    if (k.startsWith('table ')) {
      const live_ = columns(have.get(k));
      const want_ = columns(want.get(k));
      for (const [name, def] of want_) if (!live_.has(name)) console.log(`      + ${def}`);
      for (const [name, def] of live_) if (!want_.has(name)) console.log(`      - ${def}`);
    }
  }
  console.log();
}
if (extra.length) {
  console.log(`PRESENT but not in migrations/ (${extra.length}):`);
  for (const k of extra) console.log(`  ${k}`);
  console.log();
}

const clean = !missing.length && !differs.length && !extra.length;
console.log(clean ? 'In step with migrations/.' : 'NOT in step with migrations/. See README.md.');
process.exit(clean ? 0 : 1);
