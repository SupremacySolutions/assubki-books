#!/usr/bin/env node
/**
 * Stores each cover at the sizes the site actually shows it at.
 *
 * The cover itself is left completely alone - same crop, same colours, no
 * frame, no background, no mark. This exists only so the home page is not sent
 * an 800px cover for an 84px slot, twenty-eight times.
 *
 * There was a framing pass here before, which put every cover on the shop's
 * paper colour with the rosette in the corner. The owner did not want it: the
 * books look better as they are. What survived is the half nobody sees - the
 * resizing - because that was never the part he objected to.
 *
 * Done here rather than as the image is served because serving-time transforms
 * need Cloudflare Images, which is not enabled on this account and costs money.
 * sharp is free and the original migration already used it.
 *
 *   node scripts/resize-covers.mjs --sample   # a contact sheet, no upload
 *   node scripts/resize-covers.mjs --dry      # process all, upload none
 *   node scripts/resize-covers.mjs            # process, upload, print SQL
 *
 * Safe to re-run: every output is derived from the original, and the original
 * is never written to.
 */

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';

const execFileAsync = promisify(execFile);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORK = join(ROOT, '.cache', 'resize');
const BUCKET = 'assubki-books-uploads';
const CONCURRENCY = 4;

const SAMPLE = process.argv.includes('--sample');
/**
 * `--only=<substring>` reprocesses just the rows whose key matches.
 *
 * An upload can fail on its own - one did, on a run where the other 454 were
 * fine - and that row then needs the whole set again while nothing else does.
 */
const ONLY = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length) ?? null;
const DRY = process.argv.includes('--dry') || SAMPLE;

/**
 * Kept in step with src/lib/image-presets.ts by hand, because that file is
 * TypeScript the site imports and this is a plain script. If they drift, the
 * route falls back to the original, so the failure is a large image rather
 * than a missing one.
 *
 * No `detail` entry: at 840×1120 it is bigger than almost every original, so
 * the file would be a copy of the original under another name. The route falls
 * back to the original for any size that is not here, which is exactly right.
 */
const PRESETS = {
  card: { width: 600, height: 800 },
  thumb: { width: 176, height: 234 },
  hero: { width: 168, height: 224 },
  social: { width: 600, height: 600 },
};

/** One cover, one size. Fitted inside, never cropped, never enlarged. */
async function resize(input, preset) {
  const { width, height } = PRESETS[preset];
  return sharp(input)
    .rotate()
    .resize({
      width,
      height,
      fit: 'inside',
      // A cover smaller than the slot stays its own size. Enlarging it would
      // only make it softer, and there is no frame now to keep it in line
      // with its neighbours.
      withoutEnlargement: true,
      kernel: 'lanczos3',
    })
    .webp({ quality: 82 })
    .toBuffer();
}

/** Every image the catalogue knows about, newest keys last. */
async function loadImages() {
  const { stdout } = await execFileAsync('npx', [
    'wrangler', 'd1', 'execute', 'assubki-books', '--remote', '--json',
    '--command',
    "SELECT bi.id, bi.image_key, b.slug FROM book_images bi JOIN books b ON b.id = bi.book_id ORDER BY bi.id",
  ], { maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(stdout)[0].results;
}

/**
 * Pulls the original behind a key.
 *
 * The catalogue may still point at a framed `-std.webp` from the pass that has
 * now been reverted, and resizing one of those would keep the frame forever.
 * The originals were deliberately never overwritten. The extension is not
 * recoverable from a framed name - everything was written as `.webp` - so the
 * candidates are tried in turn, and a row whose original has gone is reported
 * rather than quietly reprocessed.
 */
async function pullOriginal(key, dest) {
  if (!key.endsWith('-std.webp')) {
    await pull(key, dest);
    return key;
  }
  const stem = key.slice(0, -'-std.webp'.length);
  for (const ext of ['.webp', '.jpg', '.jpeg', '.png']) {
    try {
      await pull(stem + ext, dest);
      return stem + ext;
    } catch {
      // Next extension. Only the last one failing is a real failure.
    }
  }
  throw new Error(`no original behind ${key}`);
}

async function pull(key, dest) {
  await execFileAsync('npx', [
    'wrangler', 'r2', 'object', 'get', `${BUCKET}/${key}`, '--file', dest, '--remote',
  ], { maxBuffer: 32 * 1024 * 1024 });
}

async function push(key, file) {
  await execFileAsync('npx', [
    'wrangler', 'r2', 'object', 'put', `${BUCKET}/${key}`,
    '--file', file, '--content-type', 'image/webp', '--remote',
  ], { maxBuffer: 32 * 1024 * 1024 });
}

/** "books/x/1.webp" → "books/x/1-card.webp". Matches the route's own maths. */
const variantKey = (key, preset) => `${key.replace(/\.[a-z0-9]+$/i, '')}-${preset}.webp`;

// ---------------------------------------------------------------------------

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

let images = await loadImages();
console.log(`${images.length} images in the catalogue`);

if (ONLY) {
  images = images.filter((i) => i.image_key.includes(ONLY));
  console.log(`only: ${images.length} matching "${ONLY}"`);
}

if (SAMPLE) {
  // The four that decide whether the sizes work: a spine, a landscape scan, a
  // small straggler, and an ordinary portrait cover.
  const want = [
    'books/al-tawdih-wal-talwih/4.webp',
    'books/hidayah-al-nahw/1.webp',
    'books/usul-al-shashi/1.webp',
    'books/al-nahw-al-wadih/1.webp',
  ];
  // Matched against the original name, since the catalogue may still be on the
  // framed keys when this runs.
  images = images.filter((i) => want.includes(i.image_key.replace(/-std\.webp$/, '.webp')));
  console.log(`sample: ${images.map((i) => i.image_key).join(', ')}`);
}

const updates = [];
const failures = [];
let done = 0;
const queue = [...images];

await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const row = queue.shift();
      const src = join(WORK, `src-${row.id}`);
      try {
        const original = await pullOriginal(row.image_key, src);

        for (const preset of Object.keys(PRESETS)) {
          const out = join(WORK, `${row.id}-${preset}.webp`);
          writeFileSync(out, await resize(src, preset));
          if (!DRY) await push(variantKey(original, preset), out);
        }

        // The original's own dimensions, so the page can reserve the right
        // space for it. The framing pass wrote 600×800 for everything, which
        // is no longer true of anything.
        const meta = await sharp(src).rotate().metadata();
        updates.push({ id: row.id, key: original, width: meta.width, height: meta.height });
      } catch (err) {
        failures.push({ key: row.image_key, error: String(err).split('\n')[0] });
      }
      if (++done % 25 === 0) console.log(`  ${done}/${images.length}`);
    }
  }),
);

console.log(`\nResized ${updates.length}/${images.length}${DRY ? ' (nothing uploaded)' : ''}`);
if (SAMPLE) console.log(`Look at: ${WORK}`);

if (failures.length) {
  console.log(`${failures.length} failed:`);
  for (const f of failures.slice(0, 20)) console.log(`  ${f.key}: ${f.error}`);
  process.exitCode = 1;
}

if (!DRY && updates.length) {
  // Printed rather than run: pointing the catalogue back at the originals is
  // the one irreversible step, and it should be a deliberate one.
  const sql = updates
    .map(
      (u) =>
        `UPDATE book_images SET image_key='${u.key}', width=${u.width}, height=${u.height} WHERE id=${u.id};`,
    )
    .join('\n');
  const sqlFile = join(WORK, 'point-at-originals.sql');
  writeFileSync(sqlFile, sql);
  console.log(`\nNow point the catalogue at them:\n  npx wrangler d1 execute assubki-books --remote --file=${sqlFile}`);
}
