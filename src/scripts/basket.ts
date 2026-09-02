/**
 * The basket is a list of intents, not a priced order.
 *
 * Only book ids and quantities are stored. Every price and availability is
 * re-read from the database when the basket page renders and again when the
 * request is submitted, so a stale tab - or an edited localStorage value -
 * cannot fix a price or claim stock that is gone.
 */

const KEY = 'asb.basket.v1';

/**
 * How long an untouched basket lives.
 *
 * The privacy page promises that baskets never ordered are cleared after 48
 * hours, and for a long time nothing here did that - the ids sat in
 * localStorage until the browser was cleared, so the published statement was
 * simply untrue. It is counted from the last change rather than from the first
 * one: a basket still being added to has not been abandoned, and "never
 * ordered" is about the ones that were.
 */
const TTL_MS = 48 * 60 * 60 * 1000;

export type Basket = Record<string, number>;

/** Only whole positive quantities against numeric ids survive a read. */
function clean(source: object): Basket {
  const out: Basket = {};
  for (const [id, qty] of Object.entries(source)) {
    const n = Number(qty);
    if (/^\d+$/.test(id) && Number.isInteger(n) && n > 0) out[id] = Math.min(n, 99);
  }
  return out;
}

/** Writes the basket down with the time, without announcing a change. */
function stamp(basket: Basket): void {
  localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), items: basket }));
}

export function read(): Basket {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

    /*
     * A basket written before this file recorded a time is a bare id-to-qty
     * map. It is somebody's real basket, so it is kept rather than dropped -
     * and stamped as we go, so it expires 48 hours from this visit instead of
     * never.
     */
    const legacy = !('items' in parsed);
    const source = legacy ? parsed : parsed.items;
    if (!source || typeof source !== 'object' || Array.isArray(source)) return {};

    const at = legacy ? Date.now() : Number(parsed.at);
    // A clock that moved backwards leaves `at` in the future, which reads as
    // negative age and is left alone - the basket is not stale, the clock is.
    if (!Number.isFinite(at) || Date.now() - at > TTL_MS) {
      localStorage.removeItem(KEY);
      return {};
    }

    const items = clean(source);
    if (legacy) stamp(items);
    return items;
  } catch {
    return {};
  }
}

function write(basket: Basket): void {
  stamp(basket);
  document.dispatchEvent(new CustomEvent('basket:change', { detail: basket }));
}

export function count(basket: Basket = read()): number {
  return Object.values(basket).reduce((n, q) => n + q, 0);
}

export function add(id: number | string, qty = 1): void {
  const basket = read();
  basket[String(id)] = Math.min((basket[String(id)] ?? 0) + qty, 99);
  write(basket);
}

/**
 * Add, but never past what the shop actually has.
 *
 * `add` accumulates, so two clicks of "add 3" with three copies in stock used to
 * put six in the basket - each click passed its own clamp and nothing ever
 * checked the total. The book page could not see it either, because it never
 * read the existing basket. This caps the *total* and reports what it did, so
 * the page can say so rather than confirming a request it quietly cut down.
 */
export function addChecked(
  id: number | string,
  wanted: number,
  available: number,
): { added: number; requested: number; total: number; capped: boolean } {
  const key = String(id);
  const basket = read();
  const held = basket[key] ?? 0;
  const ceiling = Math.max(0, Math.min(available, 99));
  const total = Math.min(held + Math.max(0, wanted), ceiling);
  const added = total - held;

  if (added > 0) {
    basket[key] = total;
    write(basket);
  }
  return { added, requested: wanted, total, capped: added < wanted };
}

export function setQty(id: number | string, qty: number): void {
  const basket = read();
  if (qty <= 0) delete basket[String(id)];
  else basket[String(id)] = Math.min(qty, 99);
  write(basket);
}

export function remove(id: number | string): void {
  setQty(id, 0);
}

export function clear(): void {
  localStorage.removeItem(KEY);
  document.dispatchEvent(new CustomEvent('basket:change', { detail: {} }));
}

/**
 * What the header badge shows when this browser is filling a group basket
 * rather than its own. Null means "count my own basket", the ordinary case.
 */
let badgeOverride: number | null = null;

export function setBadge(n: number | null): void {
  badgeOverride = n;
  paintCount();
}

function paintCount(): void {
  const n = badgeOverride ?? count();
  for (const el of document.querySelectorAll<HTMLElement>('[data-basket-count]')) {
    el.textContent = String(n);
    el.hidden = n === 0;
  }
}

document.addEventListener('basket:change', paintCount);
// Keep tabs in step - two windows on the same shop should not disagree.
window.addEventListener('storage', (e) => {
  if (e.key === KEY) paintCount();
});
paintCount();

declare global {
  interface Window {
    asbBasket: {
      read: typeof read; add: typeof add; addChecked: typeof addChecked;
      setQty: typeof setQty; remove: typeof remove; clear: typeof clear;
      count: typeof count; setBadge: typeof setBadge;
    };
  }
}
window.asbBasket = { read, add, addChecked, setQty, remove, clear, count, setBadge };
