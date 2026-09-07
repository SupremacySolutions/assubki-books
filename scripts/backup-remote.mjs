#!/usr/bin/env node
/**
 * A file copy of the production database, because `wrangler d1 export` cannot
 * make one.
 *
 *   node scripts/backup-remote.mjs [--out backup-YYYYmmdd-HHMM.sql]
 *
 * D1's own export refuses outright on any database holding an FTS5 virtual
 * table - "cannot export databases with Virtual Tables (fts5)" - and `books_fts`
 * is not going anywhere, so the export that docs/schema-reconciliation/README.md
 * asks for before a migration is not available on this database at all. Time
 * Travel still is, but a bookmark is Cloudflare's to keep and thirty days long;
 * the point of the file is that it is neither.
 *
 * Read-only against production: every statement it sends is a SELECT. What it
 * writes is a plain .sql of schema then rows, restorable with
 * `wrangler d1 execute --file`, which is the same shape `d1 export` would have
 * produced.
 *
 * The virtual table is written as its CREATE and none of its contents: its
 * shadow tables are SQLite's to fill, and the triggers in 0001 rebuild the
 * index from `books` as the rows go back in.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const DB = 'assubki-books';
const outArg = process.argv.indexOf('--out');
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
const OUT = outArg > -1 ? process.argv[outArg + 1] : `backup-${stamp}.sql`;

/** One read-only statement, as JSON. */
function query(sql) {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', DB, '--remote', '--json', '--command', sql],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  return JSON.parse(out.slice(out.indexOf('['))).flatMap((b) => b.results ?? []);
}

/** SQLite literals. A Buffer would need X'..'; nothing in this schema stores one. */
function literal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}

const schema = query(
  "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
);

/*
 * Shadow tables carry the FTS index, and SQLite makes them itself the moment
 * `CREATE VIRTUAL TABLE books_fts` runs. Writing their own CREATEs out beside
 * it means a restore is told to create each of them twice, which it refuses;
 * writing their rows out means the index is filled twice over. Neither is
 * needed - the triggers in 0001 rebuild the index from `books` as its rows go
 * back in, which is where the index comes from in the first place.
 */
const shadow = /^books_fts_(config|data|docsize|idx)$/;
const skipRows = (n) => shadow.test(n) || n === 'books_fts';

const lines = [
  `-- ${DB}, read from production ${new Date().toISOString()}`,
  '-- Restore: npx wrangler d1 execute assubki-books --remote --file=<this file>',
  '-- Written by scripts/backup-remote.mjs; `wrangler d1 export` cannot read an fts5 database.',
  'PRAGMA defer_foreign_keys = TRUE;',
  '',
];

for (const o of schema.filter((o) => o.type === 'table' && !shadow.test(o.name))) lines.push(`${o.sql};`);
lines.push('');

let total = 0;
for (const t of schema.filter((o) => o.type === 'table' && !skipRows(o.name))) {
  const rows = query(`SELECT * FROM "${t.name}"`);
  if (!rows.length) continue;
  /*
   * Generated columns are computed on the way in and refused on the way back,
   * so `books.language` is read for the record and never named in an INSERT.
   */
  const generated = new Set(
    query(`SELECT name FROM pragma_table_xinfo('${t.name}') WHERE hidden IN (2, 3)`).map((r) => r.name),
  );
  const cols = Object.keys(rows[0]).filter((c) => !generated.has(c));
  for (const r of rows) {
    lines.push(
      `INSERT INTO "${t.name}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map((c) => literal(r[c])).join(', ')});`,
    );
  }
  total += rows.length;
  console.log(`  ${String(rows.length).padStart(6)}  ${t.name}`);
}

lines.push('');
for (const o of schema.filter((o) => o.type !== 'table')) lines.push(`${o.sql};`);

/*
 * Indexes and triggers go in after the rows - an index built once at the end
 * beats one maintained per INSERT, and a trigger that exists during the load
 * fires on data that is not new.
 *
 * That last part is why this line has to be here. `books_fts` is an external
 * content table: it holds no copy of the text, and its index is built solely by
 * the triggers in 0001 as books are written. Restore with the triggers created
 * after the books and the index is never built at all - every table is correct,
 * every count agrees, and the shop's search quietly answers nothing. `rebuild`
 * is the one statement that reads `books` back through the index.
 */
lines.push("INSERT INTO books_fts(books_fts) VALUES('rebuild');");
lines.push('');

writeFileSync(OUT, lines.join('\n'));
console.log(`\n${total} rows from ${schema.filter((o) => o.type === 'table' && !shadow.test(o.name)).length} tables -> ${OUT}`);
