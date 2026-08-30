#!/usr/bin/env node
/**
 * Puts every book cover in the same frame.
 *
 * They arrived in whatever shape the WordPress photo happened to be - 617×800
 * for most, but also 88×800 spines and 800×450 scans - so the catalogue grid
 * showed ragged whitespace and the hero, the only place that crops, cut the
 * spines to nothing.
 *
 * Each cover is fitted *inside* a 3:4 frame on the shop's paper colour, with
 * the rosette set quietly in the corner, and written once per display size.
 * Fitted rather than cropped, so a spine keeps all of itself and gains
 * background instead.
 *
 * Done here rather than as the image is served because serving-time transforms
 * need Cloudflare Images, which is not enabled on this account and costs money.
 * sharp is free and the migration already used it.
 *
 *   node scripts/standardise-covers.mjs --sample   # a contact sheet, no upload
 *   node scripts/standardise-covers.mjs --dry      # process all, upload none
 *   node scripts/standardise-covers.mjs            # process, upload, print SQL
 *
 * Safe to re-run: every output is derived from the source, and the originals
 * are left in R2 untouched - they are the only rollback there is.
 */

import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';

const execFileAsync = promisify(execFile);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORK = join(ROOT, '.cache', 'standardise');
const BUCKET = 'assubki-books-uploads';
const CONCURRENCY = 4;

const SAMPLE = process.argv.includes('--sample');
const DRY = process.argv.includes('--dry') || SAMPLE;

/** The shop's paper colour - the same one the pages sit on. */
const PAPER = { r: 0xf5, g: 0xf4, b: 0xf0, alpha: 1 };

/**
 * Kept in step with src/lib/image-presets.ts by hand, because that file is
 * TypeScript the site imports and this is a plain script. If they drift, the
 * route falls back to the master, so the failure is a large image rather than
 * a missing one.
 */
const PRESETS = {
  // The ladder tops out near the sources themselves: nothing here is bigger
  // than 800px on its long edge, so a larger master would be invention.
  master: { width: 600, height: 800 },
  // No `detail` file: it would be identical to the master, and the route falls
  // back to the master for any variant that is not there.
  card: { width: 450, height: 600 },
  thumb: { width: 132, height: 176 },
  hero: { width: 168, height: 224 },
  social: { width: 600, height: 600 },
};

/**
 * How much of the frame the cover fills. The rest is background, and the mark
 * sits in it.
 */
const FILL = 0.88;

/**
 * Small covers *are* enlarged, up to a point.
 *
 * 52 of the 454 came in under 800px, down to 300×400. Left at native size they
 * sat visibly smaller than everything around them, which is the inconsistency
 * this whole pass exists to remove - a shelf of books should line up. Past
 * about twice, though, an upscale stops being a bigger picture and starts being
 * a softer one, so it stops there and that cover sits slightly small.
 */
const MAX_UPSCALE = 2;

const ROSETTE = (await import(join(ROOT, 'scripts', 'lib', 'rosette.mjs'))).ROSETTE_PATH;

/** The mark, as an SVG buffer sized for the frame it is going into. */
function markFor(width) {
  const size = Math.round(width * 0.11);
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 200 200">` +
      `<path d="${ROSETTE}" fill="#184485" fill-opacity="0.5"/></svg>`,
  );
}

/** One cover, one size. */
async function frame(input, preset) {
  const { width, height } = PRESETS[preset];
  // The mark sits in the corner with a margin proportional to the frame, so it
  // reads the same at 168px as it does at 900.
  const margin = Math.round(width * 0.045);
  const mark = markFor(width);
  const markSize = Math.round(width * 0.11);

  const meta = await sharp(input).rotate().metadata();
  const box = { width: Math.round(width * FILL), height: Math.round(height * FILL) };

  // Never ask for more than MAX_UPSCALE of what the source actually has.
  const natural = Math.min(box.width / meta.width, box.height / meta.height);
  const scale = Math.min(natural, MAX_UPSCALE);

  return sharp(input)
    .rotate()
    .resize({
      width: Math.max(1, Math.round(meta.width * scale)),
      height: Math.max(1, Math.round(meta.height * scale)),
      fit: 'inside',
      kernel: 'lanczos3',
    })
    .flatten({ background: PAPER })
    .toBuffer()
    .then((cover) =>
      sharp({ create: { width, height, channels: 3, background: PAPER } })
        .composite([
          { input: cover, gravity: 'centre' },
          { input: mark, top: height - markSize - margin, left: width - markSize - margin },
        ])
        .webp({ quality: 82 })
        .toBuffer(),
    );
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

/** "books/x/1.webp" → "books/x/1-std.webp", and per preset alongside it. */
const stdKey = (key) => key.replace(/\.[a-z0-9]+$/i, '-std.webp');
const variantKey = (masterKey, preset) => masterKey.replace(/\.webp$/, `-${preset}.webp`);

// ---------------------------------------------------------------------------

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

let images = await loadImages();
console.log(`${images.length} images in the catalogue`);

if (SAMPLE) {
  // The four that decide whether the frame works: a spine, a landscape scan, a
  // small straggler, and an ordinary portrait cover.
  const want = [
    'books/al-tawdih-wal-talwih/4.webp',
    'books/hidayah-al-nahw/1.webp',
    'books/usul-al-shashi/1.webp',
    'books/al-nahw-al-wadih/1.webp',
  ];
  images = images.filter((i) => want.includes(i.image_key));
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
        await pull(row.image_key, src);

        const master = stdKey(row.image_key);
        for (const preset of Object.keys(PRESETS)) {
          const out = join(WORK, `${row.id}-${preset}.webp`);
          writeFileSync(out, await frame(src, preset));
          if (!DRY) {
            await push(preset === 'master' ? master : variantKey(master, preset), out);
          }
        }

        updates.push({
          id: row.id,
          key: master,
          width: PRESETS.master.width,
          height: PRESETS.master.height,
        });
      } catch (err) {
        failures.push({ key: row.image_key, error: String(err).split('\n')[0] });
      }
      if (++done % 25 === 0) console.log(`  ${done}/${images.length}`);
    }
  }),
);

console.log(`\nFramed ${updates.length}/${images.length}${DRY ? ' (nothing uploaded)' : ''}`);
if (SAMPLE) console.log(`Look at: ${WORK}`);

if (failures.length) {
  console.log(`${failures.length} failed:`);
  for (const f of failures.slice(0, 20)) console.log(`  ${f.key}: ${f.error}`);
  process.exitCode = 1;
}

if (!DRY && updates.length) {
  // Printed rather than run: pointing the catalogue at the new keys is the one
  // irreversible step, and it should be a deliberate one.
  const sql = updates
    .map(
      (u) =>
        `UPDATE book_images SET image_key='${u.key}', width=${u.width}, height=${u.height} WHERE id=${u.id};`,
    )
    .join('\n');
  const sqlFile = join(WORK, 'point-at-new-keys.sql');
  writeFileSync(sqlFile, sql);
  console.log(`\nNow point the catalogue at them:\n  npx wrangler d1 execute assubki-books --remote --file=${sqlFile}`);
}
