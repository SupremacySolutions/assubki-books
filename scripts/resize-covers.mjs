#!/usr/bin/env node
/**
 * Stores each cover at the sizes the site actually shows it at.
 *
 * The artwork is left alone - same colours, no frame, no background, no mark.
 * A plain white border surrounding all four sides is removed before resizing;
 * this is scanner canvas, not part of the cover, and otherwise survives inside
 * even an object-cover box.
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
 *   node scripts/resize-covers.mjs --dry --public # faster catalogue audit
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
const PUBLIC_PULL = process.argv.includes('--public');
const CONCURRENCY = PUBLIC_PULL ? 12 : 4;

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
 * `detail` is stored even when it is no smaller than the original. It is the
 * largest place a cover appears, and needs the same white-frame cleanup as the
 * smaller variants rather than falling back to the untouched original.
 */
const PRESETS = {
  card: { width: 600, height: 840 },
  detail: { width: 840, height: 1176 },
  thumb: { width: 180, height: 252 },
  hero: { width: 170, height: 238 },
  social: { width: 600, height: 600 },
};

/*
 * Sharp finds a border by walking inwards from a known white background. The
 * two-axis gate is the safety catch for secondary photos. Primary covers were
 * audited as a set and may have scanner canvas on one pair of sides only, or a
 * deliberately loose product shot; either is removed before the common crop.
 */
const WHITE_THRESHOLD = 12;
const MIN_FRAME_TRIM = 0.01;
const MAX_FRAME_TRIM = 0.25;

/**
 * One trim attempt, measured.
 *
 * `background` picks what counts as canvas: white for a scanner bed, or the
 * image's own corner colour when `null`, which is what sharp does by default.
 */
async function measureTrim(normal, background, primary) {
  const trimmed = await sharp(normal.data)
    .trim(background ? { background, threshold: WHITE_THRESHOLD } : { threshold: WHITE_THRESHOLD })
    .toBuffer({ resolveWithObject: true });

  const left = Math.max(0, -(trimmed.info.trimOffsetLeft ?? 0));
  const top = Math.max(0, -(trimmed.info.trimOffsetTop ?? 0));
  const right = normal.info.width - trimmed.info.width - left;
  const bottom = normal.info.height - trimmed.info.height - top;
  const widthTrim = (left + right) / normal.info.width;
  const heightTrim = (top + bottom) / normal.info.height;
  const inRange = (share) => share <= MAX_FRAME_TRIM;
  const horizontalPair =
    left / normal.info.width >= MIN_FRAME_TRIM / 2 &&
    right / normal.info.width >= MIN_FRAME_TRIM / 2;
  const verticalPair =
    top / normal.info.height >= MIN_FRAME_TRIM / 2 &&
    bottom / normal.info.height >= MIN_FRAME_TRIM / 2;

  /*
   * A primary cover may carry scanner canvas on one opposite pair only - the
   * An-Nasihah reference has white down both sides but none above or below.
   * Secondary photos stay stricter because a page or spine is not meant to be
   * forced into the same silhouette as a front cover.
   *
   * The upper bound applies to a colour-matched trim whoever the cover is:
   * white canvas cannot be mistaken for artwork, but a dark border and a dark
   * design can, and a quarter of the picture is the most any frame should be.
   */
  const framed = primary
    ? (horizontalPair || verticalPair) && (background ? true : inRange(widthTrim) && inRange(heightTrim))
    : inRange(widthTrim) && inRange(heightTrim) && horizontalPair && verticalPair;

  return {
    framed,
    data: trimmed.data,
    width: trimmed.info.width,
    height: trimmed.info.height,
    trim: { left, right, top, bottom, widthTrim, heightTrim },
  };
}

async function prepareCover(input, primary) {
  const normal = await sharp(input).rotate().toBuffer({ resolveWithObject: true });

  /*
   * A transparent surround is not a border to be judged - it is simply absent.
   *
   * Six covers arrived as PNGs whose artwork floats in a transparent field
   * filling two thirds of the file. Nothing matched white, so no trim ran, and
   * the shop rendered the card's own background through the hole - which reads
   * as exactly the border everything else here is trying to remove.
   *
   * It is handled before the colour trims and outside their size cap. That cap
   * exists because a dark border and a dark design can be confused; nothing can
   * be confused with transparency, so a trim of two thirds is not suspicious,
   * it is correct. What is left is flattened onto white so the stored variant
   * is opaque whatever sits behind it.
   */
  const meta = await sharp(normal.data).metadata();
  if (meta.hasAlpha) {
    const cut = await sharp(normal.data)
      .trim({ threshold: WHITE_THRESHOLD })
      .toBuffer({ resolveWithObject: true });

    const removed =
      1 - (cut.info.width * cut.info.height) / (normal.info.width * normal.info.height);
    if (removed >= MIN_FRAME_TRIM) {
      const flat = await sharp(cut.data)
        .flatten({ background: '#ffffff' })
        .toBuffer({ resolveWithObject: true });
      return {
        data: flat.data,
        width: flat.info.width,
        height: flat.info.height,
        framed: true,
        trim: { left: 0, right: 0, top: 0, bottom: 0, widthTrim: removed, heightTrim: removed },
      };
    }
  }

  /*
   * White first, then the cover's own border colour.
   *
   * Trimming only white missed a whole class of scan: the Zam Zam titles - the
   * hundred-stories series among them - sit on a **black** bed, so the border
   * is 0,0,0 and a white trim found nothing at all to remove. Those covers
   * kept a 30-40px band down each side through every pass, which is exactly
   * the border the shop was still showing.
   *
   * White keeps priority so nothing that already worked changes, and the
   * colour-matched attempt only runs when white found no frame.
   */
  let best = await measureTrim(normal, '#ffffff', primary);
  if (!best.framed) {
    const natural = await measureTrim(normal, null, primary);
    if (natural.framed) best = natural;
  }

  const trimmed = best.framed
    ? { data: best.data, width: best.width, height: best.height, framed: true, trim: best.trim }
    : {
        data: normal.data,
        width: normal.info.width,
        height: normal.info.height,
        framed: false,
        trim: best.trim,
      };

  return primary ? await extendToBox(trimmed) : trimmed;
}

/** The public frame, as a ratio. Every primary variant is cut to this. */
const BOX = 5 / 7;
/** The most width worth inventing, as a share of the cover's own. */
const MAX_EXTEND = 0.12;
/** How much an edge may vary and still count as plain enough to continue. */
const PLAIN_EDGE = 12;

/**
 * A cover too narrow for the box, widened along its own edges.
 *
 * The alternative is to crop, and on a cover with a printed border that is
 * what people notice: the rule along the bottom goes while the one along the
 * top stays, and it reads as damage even when the strip removed was blank.
 * These covers are not too tall, they are too narrow - so rather than take
 * height away, give width back.
 *
 * Only where the edge being continued is plain. The outermost column is
 * stretched outwards, which is seamless on the flat colour that runs down the
 * side of most covers and obvious nonsense on a photograph or a pattern, so
 * the edge is measured first and anything busy is left to be cropped as
 * before. Bounded too: past a point this stops being a cover with a wider
 * margin and starts being a cover somebody made up.
 */
async function extendToBox(cover) {
  const { width: w, height: h } = cover;
  const want = Math.round(h * BOX);
  const pad = want - w;
  if (pad <= 0 || pad > w * MAX_EXTEND) return cover;

  const { data, info } = await sharp(cover.data).ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  if (!plainEdge(data, info, 0) || !plainEdge(data, info, info.width - 1)) return cover;

  const left = Math.floor(pad / 2);
  const right = pad - left;
  const column = async (x, width) =>
    sharp(cover.data).extract({ left: x, top: 0, width: 1, height: h })
      .resize(width, h, { fit: 'fill' }).png().toBuffer();

  const widened = await sharp({
    create: { width: want, height: h, channels: 3, background: '#ffffff' },
  })
    .composite([
      ...(left ? [{ input: await column(0, left), left: 0, top: 0 }] : []),
      { input: await sharp(cover.data).png().toBuffer(), left, top: 0 },
      ...(right ? [{ input: await column(w - 1, right), left: left + w, top: 0 }] : []),
    ])
    .png()
    .toBuffer();

  return { ...cover, data: widened, width: want, height: h, extended: pad };
}

/** Whether one outer column is flat enough to be worth continuing outwards. */
function plainEdge(data, info, x) {
  const channels = info.channels;
  const samples = [];
  const steps = 60;
  for (let i = 0; i < steps; i++) {
    const y = Math.min(info.height - 1, Math.round(((i + 0.5) / steps) * info.height));
    const at = (y * info.width + x) * channels;
    samples.push([data[at], data[at + 1], data[at + 2]]);
  }
  const mean = [0, 1, 2].map((k) => samples.reduce((sum, v) => sum + v[k], 0) / samples.length);
  const spread =
    samples.reduce((sum, v) => sum + Math.max(...[0, 1, 2].map((k) => Math.abs(v[k] - mean[k]))), 0) /
    samples.length;
  return spread <= PLAIN_EDGE;
}

/**
 * One cover, one size.
 *
 * A primary cover is the merchandise image customers browse, so every public
 * variant is a full-bleed 5:7 rectangle. Other photos remain documentary: a
 * spine, contents page or spread is fitted whole and never cropped.
 */
async function resize(input, preset, primary, shape) {
  const { width, height } = PRESETS[preset];
  const fill = primary && preset !== 'social';
  return sharp(input)
    .rotate()
    .resize({
      width,
      height,
      fit: fill ? 'cover' : 'inside',
      position: fill ? anchor(shape, width / height) : 'centre',
      // Primary variants need an exact common rectangle. The browser already
      // enlarged small covers to that slot; doing it once here also gives the
      // route predictable dimensions and a single crop everywhere.
      withoutEnlargement: !fill,
      kernel: 'lanczos3',
    })
    .webp({ quality: 82 })
    .toBuffer();
}

/**
 * Which end of a too-tall cover gives way.
 *
 * Titles overwhelmingly sit at the top of these covers, so a cover that has to
 * lose real height loses it from the foot - a content-aware crop sometimes
 * chose a decorative centre and cut the title clean off, and north never does.
 *
 * But most covers are barely off the box: of the 117 taller than 5:7, 81% are
 * within 8% of it. Taking all of that off one end is what makes a framed cover
 * look damaged - the border rule along the bottom goes while the one along the
 * top stays, and the eye reads the difference immediately even though the
 * amount is small. Split between the two ends nothing is lost that was not
 * going anyway, and the frame stays a frame.
 *
 * So: share the loss when it is small enough that half of it cannot reach the
 * title, and fall back to protecting the title when it is not.
 */
const SHARE_TRIM = 0.08;
function anchor(shape, box) {
  if (!shape?.width || !shape?.height) return 'north';
  const ratio = shape.width / shape.height;
  // Wider than the box: the trim lands on the sides, and centre is the only
  // sensible reading of that - a cover is not lopsided.
  if (ratio >= box) return 'centre';
  return (box - ratio) / box <= SHARE_TRIM ? 'centre' : 'north';
}

/** Every image the catalogue knows about, newest keys last. */
async function loadImages() {
  const { stdout } = await execFileAsync('npx', [
    'wrangler', 'd1', 'execute', 'assubki-books', '--remote', '--json',
    '--command',
    "SELECT bi.id, bi.image_key, bi.sort, b.slug FROM book_images bi JOIN books b ON b.id = bi.book_id ORDER BY bi.id",
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
  if (PUBLIC_PULL) {
    const path = key.split('/').map(encodeURIComponent).join('/');
    const res = await fetch(`https://assubkibooks.co.uk/img/${path}?audit=1`);
    if (!res.ok) throw new Error(`public image ${res.status}`);
    writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    return;
  }
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
const audit = [];
let framesRemoved = 0;
let done = 0;
const queue = [...images];

await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const row = queue.shift();
      const src = join(WORK, `src-${row.id}`);
      try {
        const original = await pullOriginal(row.image_key, src);
        const primary = row.sort === 0;
        const prepared = await prepareCover(src, primary);
        if (prepared.framed) framesRemoved++;

        for (const preset of Object.keys(PRESETS)) {
          const out = join(WORK, `${row.id}-${preset}.webp`);
          writeFileSync(
            out,
            await resize(prepared.data, preset, primary, prepared),
          );
          if (!DRY) await push(variantKey(original, preset), out);
        }

        // These are the pixels the variants now contain. The page uses their
        // ratio to decide whether a final side crop is safe.
        updates.push({
          id: row.id,
          key: original,
          width: prepared.width,
          height: prepared.height,
        });
        audit.push({
          id: row.id,
          slug: row.slug,
          sort: row.sort,
          primary,
          framed: prepared.framed,
          width: prepared.width,
          height: prepared.height,
          trim: prepared.trim,
        });
      } catch (err) {
        failures.push({ key: row.image_key, error: String(err).split('\n')[0] });
      }
      if (++done % 25 === 0) console.log(`  ${done}/${images.length}`);
    }
  }),
);

console.log(`\nResized ${updates.length}/${images.length}${DRY ? ' (nothing uploaded)' : ''}`);
console.log(`White frame removed from ${framesRemoved}`);
writeFileSync(join(WORK, 'cover-audit.json'), JSON.stringify(audit.sort((a, b) => a.id - b.id), null, 2));
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
