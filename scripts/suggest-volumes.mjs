#!/usr/bin/env node
/**
 * Reads the books that already say how many volumes they are, and prints the
 * UPDATE statements for the owner to look at.
 *
 * It prints. It does not write. A parsed number is a guess about what is in a
 * box somebody is buying - "3 volumes" in a description might be the set, or
 * it might be describing the work rather than what is being sold - and that is
 * not a guess to apply silently across a catalogue. Same reasoning as
 * resize-covers.mjs, which prints its repointing SQL rather than running it.
 *
 *   node scripts/suggest-volumes.mjs
 *
 * Then read the file it names, delete the lines that are wrong, and run it.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORK = join(ROOT, '.cache', 'volumes');

const WORDS = {
  two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12,
};

/**
 * The number of volumes a piece of text claims, or null.
 *
 * Deliberately narrow: the number has to sit immediately before the word, so
 * "in 3 volumes" and "2 Volume Set" are read and a description that merely
 * mentions volumes somewhere is not. A missed set costs a moment of typing; a
 * wrong one goes on the shop front.
 */
export function volumesIn(text) {
  if (!text) return null;
  const flat = String(text).replace(/<[^>]+>/g, ' ').toLowerCase();

  const digits = flat.match(/(\d{1,3})\s*[- ]?\s*(?:volume|volumes|vols?\.?)\b/);
  if (digits) {
    const n = Number.parseInt(digits[1], 10);
    if (n > 1 && n <= 200) return n;
  }

  const words = flat.match(/\b(two|three|four|five|six|seven|eight|nine|ten|twelve)\s+volumes?\b/);
  if (words) return WORDS[words[1]];

  return null;
}

// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const { stdout } = await execFileAsync('npx', [
    'wrangler', 'd1', 'execute', 'assubki-books', '--remote', '--json',
    '--command',
    `SELECT id, slug, title, description_html AS body, volumes
       FROM books
      WHERE status = 'live'
        AND (lower(title) LIKE '%volume%' OR lower(title) LIKE '%vol%'
             OR lower(description_html) LIKE '%volume%')
      ORDER BY id`,
  ], { maxBuffer: 32 * 1024 * 1024 });

  const rows = JSON.parse(stdout)[0].results;
  const found = [];
  const unsure = [];

  for (const row of rows) {
    if (row.volumes) continue; // already answered
    const n = volumesIn(row.title) ?? volumesIn(row.body);
    (n ? found : unsure).push({ ...row, n });
  }

  console.log(`${rows.length} listings mention volumes; ${found.length} give a number.\n`);
  for (const f of found) console.log(`  ${String(f.n).padStart(3)}  ${f.slug}`);

  if (unsure.length) {
    console.log(`\n${unsure.length} mention volumes without a number anywhere obvious:`);
    for (const u of unsure.slice(0, 20)) console.log(`       ${u.slug}`);
    console.log('  These need reading. They are not in the file.');
  }

  mkdirSync(WORK, { recursive: true });
  const file = join(WORK, 'set-volumes.sql');
  writeFileSync(
    file,
    found.map((f) => `UPDATE books SET volumes=${f.n} WHERE id=${f.id};  -- ${f.slug}`).join('\n') + '\n',
  );
  console.log(`\nRead this, delete anything wrong, then run it:\n  ${file}`);
  console.log(`  npx wrangler d1 execute assubki-books --remote --file=${file}`);
}
