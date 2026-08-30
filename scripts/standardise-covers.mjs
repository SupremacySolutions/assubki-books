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
/**
 * `--only=<substring>` reprocesses just the rows whose key matches.
 *
 * An upload can fail on its own - one did, on a run where the other 454 were
 * fine - and when the master fails the variants after it are never written, so
 * that row needs the whole set again and nothing else does.
 */
const ONLY = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length) ?? null;
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
 * How much of the frame the cover fills, and how much of the bottom is kept
 * clear for the mark.
 *
 * The mark used to go in the corner of the whole frame, which only worked for
 * covers narrower than 3:4. An exactly-3:4 scan reaches to within 36px of the
 * edge, so the mark landed on the artwork - and because it happened to some
 * covers and not others it read as damage rather than as a mark. The band is
 * reserved first now and the cover fitted into what is left, so nothing can
 * overlap whatever shape turns up.
 */
const FILL = 0.88;
const BAND = 0.08;

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

/** The mark, as an SVG buffer at the size it will be drawn. */
function markFor(size) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 200 200">` +
      `<path d="${ROSETTE}" fill="#184485" fill-opacity="0.5"/></svg>`,
  );
}

/** One cover, one size. */
async function frame(input, preset) {
  const { width, height } = PRESETS[preset];

  // Band, mark and margin are all proportional to the frame, so the whole
  // arrangement reads the same at 168px as it does at 600.
  const band = Math.round(height * BAND);
  // Sized from the band, not the frame: a square social frame has the same
  // width as the master but a much shallower band, and 0.075 of the width did
  // not fit in it.
  const markSize = Math.round(band * 0.7);
  const margin = Math.round(width * 0.045);
  const mark = markFor(markSize);

  // The cover only ever gets the area above the band.
  const area = height - band;
  const box = { width: Math.round(width * FILL), height: Math.round(area * FILL) };

  const meta = await sharp(input).rotate().metadata();

  // Never ask for more than MAX_UPSCALE of what the source actually has.
  const natural = Math.min(box.width / meta.width, box.height / meta.height);
  const scale = Math.min(natural, MAX_UPSCALE);

  const cover = await sharp(input)
    .rotate()
    .resize({
      width: Math.max(1, Math.round(meta.width * scale)),
      height: Math.max(1, Math.round(meta.height * scale)),
      fit: 'inside',
      kernel: 'lanczos3',
    })
    .flatten({ background: PAPER })
    .toBuffer();

  // Centred by hand rather than by gravity: gravity centres on the frame, and
  // the cover has to be centred on the area above the band instead.
  const drawn = await sharp(cover).metadata();

  return sharp({ create: { width, height, channels: 3, background: PAPER } })
    .composite([
      {
        input: cover,
        left: Math.round((width - drawn.width) / 2),
        top: Math.round((area - drawn.height) / 2),
      },
      { input: mark, left: width - markSize - margin, top: area + Math.round((band - markSize) / 2) },
    ])
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
 * Pulls the original this key was made from.
 *
 * After the first pass the catalogue points at the framed files, so a re-run
 * reading `image_key` straight off would frame an already-framed cover and put
 * a frame inside a frame. The originals were deliberately left in R2; this
 * goes back to them. The extension is not recoverable from the framed name -
 * everything is written as `.webp` - so the candidates are tried in turn, and
 * a row whose original has gone is reported rather than reprocessed.
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

/** "books/x/1.webp" → "books/x/1-std.webp", and per preset alongside it. */
const stdKey = (key) => key.replace(/\.[a-z0-9]+$/i, '-std.webp');
const variantKey = (masterKey, preset) => masterKey.replace(/\.webp$/, `-${preset}.webp`);

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
  // The five that decide whether the frame works: a spine, a landscape scan, a
  // small straggler, an ordinary portrait cover, and an exactly-3:4 one.
  const want = [
    'books/al-tawdih-wal-talwih/4.webp',
    'books/hidayah-al-nahw/1.webp',
    'books/usul-al-shashi/1.webp',
    'books/al-nahw-al-wadih/1.webp',
    // Exactly 3:4, which is the case the mark used to land on.
    'books/an-nasihah-islamic-curriculum-coursebook-2/1.webp',
  ];
  images = images.filter((i) => want.includes(i.image_key) || want.includes(i.image_key.replace(/-std\.webp$/, '.webp')));
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
        const from = await pullOriginal(row.image_key, src);

        const master = stdKey(from);
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
