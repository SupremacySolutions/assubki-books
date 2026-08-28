#!/usr/bin/env node
/**
 * Pushes the migrated book covers into R2 under the keys already stored in
 * `book_images.image_key`, so every photo lives in one place.
 *
 * They originally shipped as static assets in public/img, which was the right
 * call while R2 was unavailable - but it left two kinds of photo behaving
 * differently. Deleting a listing removed its database rows while the files
 * stayed in the repo forever, and the owner could not really delete a migrated
 * cover at all. With everything in R2, delete means delete.
 *
 *   node scripts/upload-covers.mjs            # upload
 *   node scripts/upload-covers.mjs --check    # just report what is missing
 */

import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'public', 'img', 'books');
const BUCKET = 'assubki-books-uploads';
const CONCURRENCY = 6;
const CHECK_ONLY = process.argv.includes('--check');

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.webp')) out.push(full);
  }
  return out;
}

const files = walk(SRC).map((file) => ({
  file,
  // public/img/books/<slug>/1.webp → books/<slug>/1.webp, matching image_key.
  key: `books/${relative(SRC, file).split(sep).join('/')}`,
}));

console.log(`${files.length} covers to place in R2 bucket "${BUCKET}"`);
if (CHECK_ONLY) {
  console.log(files.slice(0, 3).map((f) => `  ${f.key}`).join('\n'));
  process.exit(0);
}

let done = 0;
const failures = [];
const queue = [...files];

await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const job = queue.shift();
      try {
        await execFileAsync('npx', [
          'wrangler', 'r2', 'object', 'put', `${BUCKET}/${job.key}`,
          '--file', job.file,
          '--content-type', 'image/webp',
          '--remote',
        ]);
      } catch (err) {
        failures.push({ key: job.key, error: String(err).split('\n')[0] });
      }
      if (++done % 50 === 0) console.log(`  ${done}/${files.length}`);
    }
  }),
);

console.log(`\nUploaded ${files.length - failures.length}/${files.length}`);
if (failures.length) {
  console.log(`${failures.length} failed:`);
  for (const f of failures.slice(0, 20)) console.log(`  ${f.key}: ${f.error}`);
  process.exitCode = 1;
}
