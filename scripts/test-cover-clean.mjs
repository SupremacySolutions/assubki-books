/*
 * The detector, checked against pictures rather than against itself.
 *
 * All of src/scripts/cover-clean.ts is deliberately free of the DOM so it can
 * be run here, and until now nothing did: the module's own header says the
 * portal cannot be driven from the HTTP suite, and that was the end of it. The
 * consequence was a detector that lost half of a two-tone cover for however
 * long it had been doing that, silently, because a half cover is still a
 * plausible rectangle and nothing was ever asked to look.
 *
 * The fixtures are painted rather than photographed. A photograph would be a
 * better test and a worse fixture - it cannot be read in a diff, it cannot be
 * varied one property at a time, and it cannot be checked in at a size anyone
 * wants in a repository. These say what they are testing in their own source.
 *
 *   node --experimental-strip-types --no-warnings scripts/test-cover-clean.mjs
 */
import assert from 'node:assert/strict';
import { detectQuad } from '../src/scripts/cover-clean.ts';
import { cropsCleanly, fillsTheBox } from '../src/lib/cover-fit.ts';

let passed = 0;
function test(name, run) {
  run();
  passed++;
  console.log(`  ok  ${name}`);
}

/** A picture, from a function that colours each pixel. */
function paint(width, height, colour) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = colour(x, y);
      const p = (y * width + x) * 4;
      data[p] = r;
      data[p + 1] = g;
      data[p + 2] = b;
      data[p + 3] = 255;
    }
  }
  return { data, width, height };
}

/*
 * Sensor grain. Without it every fixture is a handful of exact values and the
 * thresholding has an easier problem than it will ever be given - the first
 * version of the weak bar passed on noiseless fixtures and took the whole
 * frame on real ones.
 */
let seed = 20240907;
const grain = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return (seed >> 16) % 8;
};

/** How far a detected quad sits from where the book actually is. */
function drift(quad, box) {
  const want = [
    { x: box.left, y: box.top },
    { x: box.right, y: box.top },
    { x: box.right, y: box.bottom },
    { x: box.left, y: box.bottom },
  ];
  return Math.max(...quad.map((p, i) => Math.hypot(p.x - want[i].x, p.y - want[i].y)));
}

const TABLE = () => [120 + grain(), 95 + grain(), 60 + grain()];
const PALE = () => [230 + grain(), 225 + grain(), 215 + grain()];

/** A plain pale book on a surface, at a known place in the frame. */
function bookOn(surface, box = { left: 60, top: 15, right: 180, bottom: 165 }) {
  const image = paint(240, 180, (x, y) =>
    x > box.left && x < box.right && y > box.top && y < box.bottom ? PALE() : surface(),
  );
  return { image, box };
}

/**
 * A cover in two tones: pale down its top half, near-black navy below.
 *
 * This is the shop's own Fiqh in 40 Days, and it is the shape of the bug. One
 * global threshold splits the *cover*, not the cover from the table, and the
 * half that survives is book-shaped enough that every sanity check passes it.
 */
function twoTone(surface) {
  const box = { left: 18, top: 4, right: 167, bottom: 236 };
  const image = paint(185, 240, (x, y) => {
    if (x < box.left || x > box.right || y < box.top || y > box.bottom) return surface();
    const down = (y - box.top) / (box.bottom - box.top);
    if (down < 0.55) return [150 + down * 100 + grain(), 90 + down * 60 + grain(), 190 + grain()];
    if (down > 0.86 && (x >> 3) % 2 === 0) return [12 + grain(), 10 + grain(), 26 + grain()];
    return [40 + grain(), 60 + grain(), 130 + grain()];
  });
  return { image, box };
}

console.log('cover detection');

test('finds a book lying on a table', () => {
  const { image, box } = bookOn(TABLE);
  assert.ok(drift(detectQuad(image), box) <= 3);
});

test('finds a book that fills the frame', () => {
  const { image, box } = bookOn(TABLE, { left: 5, top: 4, right: 235, bottom: 176 });
  assert.ok(drift(detectQuad(image), box) <= 4);
});

test('finds a dark book on a dark surface', () => {
  const box = { left: 60, top: 15, right: 180, bottom: 165 };
  const image = paint(240, 180, (x, y) =>
    x > box.left && x < box.right && y > box.top && y < box.bottom
      ? [38 + grain(), 36 + grain(), 40 + grain()]
      : [60 + grain(), 58 + grain(), 55 + grain()],
  );
  assert.ok(drift(detectQuad(image), box) <= 3);
});

test('finds a pale book on pale paper', () => {
  const box = { left: 60, top: 15, right: 180, bottom: 165 };
  const image = paint(240, 180, (x, y) =>
    x > box.left && x < box.right && y > box.top && y < box.bottom
      ? [252, 251, 249]
      : [244, 243, 240],
  );
  assert.ok(drift(detectQuad(image), box) <= 3);
});

/*
 * The four that mattered. A two-tone cover was being cut in half on any
 * surface dark enough to make its own navy read as background - and in half
 * the other way up on paper pale enough to do the same to its pale end.
 */
for (const [surface, colour] of [
  ['a black letterbox', () => [6 + grain(), 6 + grain(), 8 + grain()]],
  ['a dark desk', () => [34 + grain(), 32 + grain(), 36 + grain()]],
  ['white paper', () => [246 + grain(), 245 + grain(), 243 + grain()]],
  ['a wooden table', TABLE],
]) {
  test(`keeps both halves of a two-tone cover on ${surface}`, () => {
    const { image, box } = twoTone(colour);
    const quad = detectQuad(image);
    assert.ok(quad, 'no quad found');
    assert.ok(
      drift(quad, box) <= 4,
      `lost part of the cover: ${JSON.stringify(quad)} against ${JSON.stringify(box)}`,
    );
  });
}

test('refuses a background it cannot read rather than guessing', () => {
  // A two-colour cloth: half of it is as far from the border colour as the
  // book is, so there is no honest answer and the whole frame is the right one.
  const image = paint(240, 180, (x, y) =>
    x > 60 && x < 180 && y > 15 && y < 165
      ? PALE()
      : ((x >> 3) + (y >> 3)) % 2
        ? [200, 60, 60]
        : [240, 235, 220],
  );
  assert.equal(detectQuad(image), null);
});

test('keeps a hand holding the book inside the crop rather than refusing', () => {
  // A thumb fuses to the cover and cannot be opened away. Reaching past the
  // book is recoverable - the owner drags the corner in - where handing back
  // the whole frame means placing all four by hand.
  const box = { left: 60, top: 15, right: 180, bottom: 165 };
  const image = paint(240, 180, (x, y) => {
    if (x > box.left && x < box.right && y > box.top && y < box.bottom) return PALE();
    if (Math.hypot(x - box.left, y - 90) < 18) return [205, 165, 140];
    return TABLE();
  });
  const quad = detectQuad(image);
  assert.ok(quad, 'gave up on a photo with a hand in it');
  // Right, top and bottom stay put; only the held edge reaches out.
  assert.ok(Math.abs(quad[1].x - box.right) <= 3, 'the far edge moved');
  assert.ok(quad[0].x <= box.left, 'the held edge should reach out, not in');
  assert.ok(box.left - quad[0].x < 40, 'the held edge reached far past the thumb');
});

test('a corner is never placed outside the picture', () => {
  const { image } = bookOn(TABLE, { left: -20, top: -10, right: 260, bottom: 190 });
  for (const p of detectQuad(image) ?? []) {
    assert.ok(p.x >= 0 && p.x <= 240 && p.y >= 0 && p.y <= 180);
  }
});

console.log('\ncover framing');

test('crops sideways but never top and bottom', () => {
  assert.equal(cropsCleanly(640, 800), true); // 4:5, trims its side margins
  assert.equal(cropsCleanly(600, 1000), false); // taller than the box: would cut a title
  assert.equal(cropsCleanly(900, 1000), false); // too wide: the trim reaches artwork
  assert.equal(cropsCleanly(null, 800), false); // nothing known, nothing assumed
  // Filling the box is a different question: an ordinary cover a hair narrower
  // than 5:7 is still a cover, and covers are shown full bleed.
  assert.equal(fillsTheBox(600, 840), true);
  assert.equal(fillsTheBox(600, 1000), false); // far enough off to be a spine
  assert.equal(fillsTheBox(660, 1000), true);  // ordinary, just narrow
  assert.equal(fillsTheBox(null, 800), true);  // unmeasured uploads fill, as before
});

console.log(`\n${passed} cover regression tests passed`);
