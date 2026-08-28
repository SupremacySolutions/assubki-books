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


const { size } = statSync("public/email/mark.png");
console.log(`  public/email/mark.png   84×84, ${size} bytes`);
console.log('  public/favicon.svg      regenerated from the same path');
