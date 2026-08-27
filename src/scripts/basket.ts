/**
 * The basket is a list of intents, not a priced order.
 *
 * Only book ids and quantities are stored. Every price and availability is
 * re-read from the database when the basket page renders and again when the
 * request is submitted, so a stale tab — or an edited localStorage value —
 * cannot fix a price or claim stock that is gone.
 */

const KEY = 'asb.basket.v1';

export type Basket = Record<string, number>;

export function read(): Basket {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Basket = {};
    for (const [id, qty] of Object.entries(parsed)) {
      const n = Number(qty);
      if (/^\d+$/.test(id) && Number.isInteger(n) && n > 0) out[id] = Math.min(n, 99);
    }
    return out;
  } catch {
    return {};
  }
}

function write(basket: Basket): void {
  localStorage.setItem(KEY, JSON.stringify(basket));
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

function paintCount(): void {
  const n = count();
  for (const el of document.querySelectorAll<HTMLElement>('[data-basket-count]')) {
    el.textContent = String(n);
    el.hidden = n === 0;
  }
}

document.addEventListener('basket:change', paintCount);
// Keep tabs in step — two windows on the same shop should not disagree.
window.addEventListener('storage', (e) => {
  if (e.key === KEY) paintCount();
});
paintCount();

declare global {
  interface Window {
    asbBasket: {
      read: typeof read; add: typeof add; setQty: typeof setQty;
      remove: typeof remove; clear: typeof clear; count: typeof count;
    };
  }
}
window.asbBasket = { read, add, setQty, remove, clear, count };
