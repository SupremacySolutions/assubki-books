/*
 * Multi-buy pricing, checked by arithmetic anyone can do on paper.
 *
 * src/lib/multibuy.ts is what the book page, the basket, checkout and the
 * order all charge with, so a mistake in it is a mistake in every figure the
 * shop shows. These cases are the ones the owner described, plus the edges
 * that would cost a customer money if they went wrong.
 *
 *   node --experimental-strip-types --no-warnings scripts/test-multibuy.mjs
 */
import assert from 'node:assert/strict';
import {
  lineCost,
  multibuySaving,
  marginalSaving,
  lineTotal,
  parseOffers,
  validateOffers,
} from '../src/lib/multibuy.ts';

let passed = 0;
function test(name, run) {
  run();
  passed++;
  console.log(`  ok  ${name}`);
}

// £3.00 each; 10 or more at £2.50 each; exactly 20 for £45.
const offers = [
  { kind: 'from', qty: 10, pence: 250 },
  { kind: 'bundle', qty: 20, pence: 4500 },
];

test('one copy is the ordinary price', () => {
  assert.equal(lineCost(1, 300, offers), 300);
  assert.equal(multibuySaving(1, 300, offers), 0);
});

test('below every threshold nothing changes', () => {
  assert.equal(lineCost(9, 300, offers), 2700);
});

test('"10 or more" prices every copy at the rate', () => {
  assert.equal(lineCost(10, 300, offers), 2500);
  assert.equal(lineCost(15, 300, offers), 3750);
});

test('an exact bundle is the bundle price', () => {
  assert.equal(lineCost(20, 300, offers), 4500);
  assert.equal(multibuySaving(20, 300, offers), 1500);
});

test('25 is one bundle plus five at the 10+ rate', () => {
  assert.equal(lineCost(25, 300, offers), 4500 + 5 * 250);
});

test('bundles repeat', () => {
  assert.equal(lineCost(40, 300, offers), 9000);
});

test('the cheapest combination wins, never a dearer one', () => {
  // 19 copies: too few for the bundle, so every copy is at the 10+ rate.
  assert.equal(lineCost(19, 300, offers), 19 * 250);
  // A bundle worse than the rate is never chosen.
  const worse = [{ kind: 'from', qty: 2, pence: 200 }, { kind: 'bundle', qty: 5, pence: 1400 }];
  assert.equal(lineCost(5, 300, worse), 1000);
});

test('"3 for £10" stays exact to the penny', () => {
  const three = [{ kind: 'bundle', qty: 3, pence: 1000 }];
  assert.equal(lineCost(3, 400, three), 1000);
  assert.equal(lineCost(4, 400, three), 1400);
  assert.equal(lineTotal({ pricePence: 400, qty: 4, multibuyPence: multibuySaving(4, 400, three) }), 1400);
});

test('a sale cheaper than the offer wins, and they never stack', () => {
  // A 20% sale takes £3.00 to £2.40 - already under the £2.50 rate.
  assert.equal(lineCost(10, 240, offers), 2400);
  assert.equal(multibuySaving(10, 240, offers), 0);
  // The bundle at £2.25 each still beats the sale price.
  assert.equal(lineCost(20, 240, offers), 4500);
});

test('copies added to an order earn the saving their arrival makes', () => {
  // Eight on the order, three more: eleven crosses "10 or more".
  const extra = marginalSaving(8, 3, 300, offers);
  assert.equal(extra, 300 * 3 - (lineCost(11, 300, offers) - lineCost(8, 300, offers)));
  assert.ok(extra > 0);
  // Never negative, whatever the quantities.
  for (let held = 0; held < 30; held++) {
    for (let add = 1; add < 30; add++) assert.ok(marginalSaving(held, add, 300, offers) >= 0);
  }
});

test('the saving never exceeds the full price', () => {
  for (let q = 0; q < 60; q++) assert.ok(lineCost(q, 300, offers) <= q * 300);
});

test('stored offers are read forgivingly', () => {
  assert.deepEqual(parseOffers(null), []);
  assert.deepEqual(parseOffers('not json'), []);
  assert.deepEqual(parseOffers('[{"kind":"from","qty":1,"pence":100}]'), []);
  assert.deepEqual(parseOffers(JSON.stringify(offers)), offers);
});

test('offers that are not a discount are refused', () => {
  assert.equal(validateOffers(offers, 300), null);
  assert.match(validateOffers([{ kind: 'from', qty: 10, pence: 300 }], 300), /not less/);
  assert.match(validateOffers([{ kind: 'bundle', qty: 20, pence: 6000 }], 300), /not less/);
  assert.match(validateOffers([{ kind: 'bundle', qty: 1, pence: 100 }], 300), /from 2/);
  assert.match(
    validateOffers([{ kind: 'from', qty: 10, pence: 250 }, { kind: 'from', qty: 10, pence: 240 }], 300),
    /two offers/,
  );
});

console.log(`\n${passed} multi-buy checks passed`);
