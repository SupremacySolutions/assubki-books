#!/usr/bin/env node
/**
 * Renders the shop's link-preview card, public/og.jpg.
 *
 * Every page without a picture of its own shares this one. The card before it
 * put the name on the left and the rosette on the right, and WhatsApp's small
 * preview crops the middle square of a wide picture - so the shop was shown to
 * people as "-Subkī Bo" and half a flower. Here everything sits in that middle
 * square: the rosette, the name, the Arabic name. Cropped or whole, it reads.
 *
 *   node scripts/make-og.mjs
 *
 * Bump SHOP_CARD's `?v=` in src/lib/image-presets.ts after changing it: chat
 * apps hold a link's preview for days, keyed on the image's address.
 *
 * Drawn by headless Chrome rather than by sharp, because the name has to be in
 * the shop's own faces and sharp cannot load a font file on macOS - asked for
 * Spectral, it quietly sets Helvetica. Chrome reads the same @fontsource files
 * the site serves, so the card and the site cannot drift. Set CHROME to point
 * at a different browser binary.
 */

import { mkdirSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

const run = promisify(execFile);
const W = 1200;
const H = 630;
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const WORK = resolve('.cache/og');

// The rosette from its one source, as make-mark.mjs reads it.
const path = readFileSync('src/lib/mark.ts', 'utf8').match(/'(M100 76[^']+)'/)?.[1];
if (!path) throw new Error('could not find ROSETTE_PATH in src/lib/mark.ts');

const font = (file) => pathToFileURL(resolve('node_modules/@fontsource', file)).href;

const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
@font-face { font-family: Spectral; font-weight: 600; src: url(${font('spectral/files/spectral-latin-600-normal.woff2')}) format('woff2'); unicode-range: U+0000-00FF; }
@font-face { font-family: Spectral; font-weight: 600; src: url(${font('spectral/files/spectral-latin-ext-600-normal.woff2')}) format('woff2'); unicode-range: U+0100-024F; }
@font-face { font-family: Naskh; src: url(${font('noto-naskh-arabic/files/noto-naskh-arabic-arabic-400-normal.woff2')}) format('woff2'); }
html, body { margin: 0; width: ${W}px; height: ${H}px; overflow: hidden; }
body { background: #0e2a55; display: flex; flex-direction: column; align-items: center; justify-content: center; }
svg { width: 210px; height: 210px; display: block; }
.name { margin-top: 26px; font: 600 66px/1.1 Spectral, serif; color: #fff; letter-spacing: 0.005em; }
.ar { margin-top: 10px; font: 38px/1.4 Naskh, serif; color: #C3CCDE; }
</style></head><body>
<svg viewBox="30 30 140 140" aria-hidden="true"><path d="${path}" fill="#C3CCDE"/></svg>
<div class="name">As-Subkī Books</div>
<div class="ar" dir="rtl" lang="ar">مكتبة السبكي</div>
</body></html>`;

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
const page = join(WORK, 'card.html');
const shot = join(WORK, 'card.png');
writeFileSync(page, html);

try {
  await run(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--allow-file-access-from-files',
    `--user-data-dir=${join(WORK, 'profile')}`,
    `--window-size=${W},${H}`,
    '--virtual-time-budget=3000',
    `--screenshot=${shot}`,
    pathToFileURL(page).href,
  ], { timeout: 60_000 });
} catch (err) {
  throw new Error(`Chrome could not render the card (${CHROME}). Set CHROME to a Chrome binary.\n${err}`);
}

const { width, height } = await sharp(shot).metadata();
if (width !== W || height !== H) throw new Error(`Chrome drew ${width}x${height}, not ${W}x${H}`);

await sharp(shot).flatten({ background: '#0e2a55' }).jpeg({ quality: 88, mozjpeg: true }).toFile('public/og.jpg');
console.log(`public/og.jpg ${statSync('public/og.jpg').size} bytes`);
