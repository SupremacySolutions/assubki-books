/**
 * Renders the shop's mark everywhere it is needed as a file.
 *
 * Email clients strip inline SVG, so the emails cannot use the component the
 * website uses - they need a real raster image at a stable URL. This renders
 * that PNG, and the favicon alongside it, from the single path in
 * `src/lib/mark.ts`, so the mark cannot drift between the three places it
 * appears.
 *
 * Run after changing that path:  node scripts/make-mark.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import sharp from 'sharp';

const NAVY = '#184485';
const PALE = '#C3CCDE';

// The path is the source of truth, so it is read rather than copied. A silent
// miss here would ship a blank mark, so it fails loudly instead.
const source = readFileSync('src/lib/mark.ts', 'utf8');
const path = source.match(/'(M100 76[^']+)'/)?.[1];
if (!path) throw new Error('could not find ROSETTE_PATH in src/lib/mark.ts');

const svg = (fill, background) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">${
    background ? `<rect width="200" height="200" rx="28" fill="${background}"/>` : ''
  }<path d="${path}" fill="${fill}"/></svg>`;

// Drawn at 3× the 28px it is displayed at, so it stays sharp on a phone.
mkdirSync('public/email', { recursive: true });
await sharp(Buffer.from(svg(PALE)), { density: 600 })
  .resize(84, 84)
  .png({ compressionLevel: 9 })
  .toFile('public/email/mark.png');

writeFileSync('public/favicon.svg', svg(PALE, NAVY));

/**
 * The BIMI logo - the circle beside the sender in an inbox.
 *
 * BIMI will not accept ordinary SVG. It demands the SVG Tiny Portable/Secure
 * profile: a square viewBox, a <title>, no scripts, no animation, no external
 * references, and no raster image inside. So this is written by hand rather
 * than reusing the favicon, which has none of that.
 *
 * The background fills the whole square because the mail client does the
 * circular crop itself, and the mark is scaled to 92% so that crop cannot bite
 * into the outer ring of leaves.
 */
const bimi = [
  '<svg version="1.2" baseProfile="tiny-ps" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">',
  '<title>As-Subki Books</title>',
  `<rect width="200" height="200" fill="${NAVY}"/>`,
  `<g transform="translate(100,100) scale(0.92) translate(-100,-100)"><path d="${path}" fill="${PALE}"/></g>`,
  '</svg>',
].join('');
writeFileSync('public/email/bimi.svg', bimi);

const { size } = statSync("public/email/mark.png");
console.log(`  public/email/mark.png   84×84, ${size} bytes`);
console.log('  public/favicon.svg      regenerated from the same path');
console.log(`  public/email/bimi.svg   ${statSync('public/email/bimi.svg').size} bytes (SVG Tiny PS)`);
