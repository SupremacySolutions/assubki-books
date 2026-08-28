#!/usr/bin/env node
/**
 * Downloads every book image from the old WordPress uploads directory,
 * resizes and re-encodes it as WebP, and writes it to public/img/ under the
 * same key the seed SQL references.
 *
 * These covers are immutable, so they ship as static assets with the deploy
 * rather than living in R2: free, edge-cached, and versioned with the code.
 * R2 is for images the owner uploads later through the admin panel.
 *
 * The originals total ~98 MB of full-size JPEGs - far more than a cover
 * thumbnail needs. Capping the long edge at 800px and encoding WebP brings
 * that down by roughly 6x with no visible loss at the sizes actually rendered.
 *
 *   node scripts/fetch-images.mjs
 *
 * Re-running skips files already present, so an interrupted run resumes.
 */

import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { loadRaw, buildBooks } from './lib/catalogue.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'public', 'img');

const MAX_EDGE = 800;
const QUALITY = 80;
const CONCURRENCY = 8;

const { products } = loadRaw();
const books = buildBooks(products);
const jobs = books.flatMap((b) => b.images.map((img) => ({ ...img, slug: b.slug })));

console.log(`${jobs.length} images across ${books.filter((b) => b.images.length).length} books`);

const results = [];
const failures = [];
let done = 0;

async function processOne(job) {
  const dest = join(OUT_DIR, job.key);
  mkdirSync(dirname(dest), { recursive: true });

  if (existsSync(dest)) {
    const meta = await sharp(dest).metadata();
    results.push({ ...job, bytes: statSync(dest).size, width: meta.width, height: meta.height, cached: true });
    return;
  }

  const res = await fetch(job.src, { headers: { 'User-Agent': 'Mozilla/5.0 (assubki-migration)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const input = Buffer.from(await res.arrayBuffer());

  const out = await sharp(input)
    .rotate()                                     // honour EXIF orientation
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: QUALITY })
    .toBuffer({ resolveWithObject: true });

  writeFileSync(dest, out.data);
  results.push({
    ...job,
    bytes: out.data.length,
    original: input.length,
    width: out.info.width,
    height: out.info.height,
  });
}

// Fixed-size worker pool - 454 parallel fetches would just get us rate-limited.
async function run() {
  const queue = [...jobs];
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const job = queue.shift();
      try {
        await processOne(job);
      } catch (err) {
        failures.push({ key: job.key, src: job.src, error: err.message });
      }
      if (++done % 50 === 0) console.log(`  ${done}/${jobs.length}`);
    }
  });
  await Promise.all(workers);
}

await run();

const totalOut = results.reduce((n, r) => n + r.bytes, 0);
const totalIn = results.reduce((n, r) => n + (r.original ?? 0), 0);

console.log(`\nProcessed ${results.length}/${jobs.length}`);
if (totalIn) {
  console.log(`  original ${(totalIn / 1048576).toFixed(1)} MB → webp ${(totalOut / 1048576).toFixed(1)} MB ` +
              `(${(100 - (totalOut / totalIn) * 100).toFixed(0)}% smaller)`);
} else {
  console.log(`  ${(totalOut / 1048576).toFixed(1)} MB on disk`);
}
console.log(`  mean ${(totalOut / results.length / 1024).toFixed(1)} KB, ` +
            `largest ${(Math.max(...results.map((r) => r.bytes)) / 1024).toFixed(1)} KB`);

if (failures.length) {
  console.log(`\n${failures.length} failed:`);
  for (const f of failures.slice(0, 20)) console.log(`  ${f.key}: ${f.error}`);
}

// Real dimensions, so the pages can reserve layout space and avoid CLS.
writeFileSync(
  join(ROOT, 'data', 'image-dimensions.json'),
  JSON.stringify(
    Object.fromEntries(results.map((r) => [r.key, { width: r.width, height: r.height, bytes: r.bytes }])),
    null,
    2,
  ),
);
console.log('\nWrote data/image-dimensions.json');
