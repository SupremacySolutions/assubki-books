import { formatGuide, isGuideCurrency, type GuideCurrency } from '../lib/currency';

/**
 * "about $97" beside each price in pounds, for a visitor who thinks in
 * another currency.
 *
 * Any element carrying `data-gbp` (its price in pence) gets the guide after
 * it. Which currency: the one chosen in the footer if there is one, otherwise
 * the one /api/rates suggests from where Cloudflare thinks the visitor is,
 * otherwise none. The rates are asked for once per visit, and only by a page
 * that has a price on it.
 *
 * Only ever a guide. The basket, checkout, order pages and emails carry no
 * `data-gbp`, because there the figure in pounds is what is being agreed to.
 */

const CHOICE = 'asb-currency';
const SESSION = 'asb-fx';

interface Answer {
  at: number | null;
  rates: Partial<Record<GuideCurrency, number>>;
  suggest: GuideCurrency | null;
}

const prices = () => [...document.querySelectorAll<HTMLElement>('[data-gbp]')];

/** The footer's choice of currency. Found loosely, as form-controls.ts does. */
function footerSelect(): HTMLSelectElement | null {
  const el = document.getElementById('currencyGuide');
  return el instanceof HTMLSelectElement ? el : null;
}

function stored(key: string, storage: () => Storage): string | null {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
}

function keep(key: string, value: string | null, storage: () => Storage): void {
  try {
    if (value === null) storage().removeItem(key);
    else storage().setItem(key, value);
  } catch {
    /* Storage refused: the choice lasts as long as the page. */
  }
}

let answer: Answer | null = null;

function readSession(): Answer | null {
  const cached = stored(SESSION, () => sessionStorage);
  if (!cached) return null;
  try {
    return JSON.parse(cached) as Answer;
  } catch {
    return null;
  }
}

async function rates(): Promise<Answer | null> {
  if (answer) return answer;
  answer = readSession();
  if (answer) return answer;
  try {
    const res = await fetch('/api/rates');
    if (!res.ok) return null;
    answer = (await res.json()) as Answer;
    // Kept only when there was something to keep, so a bad minute at the
    // source is not remembered for the whole visit.
    if (Object.keys(answer.rates).length) keep(SESSION, JSON.stringify(answer), () => sessionStorage);
    return answer;
  } catch {
    return null;
  }
}

/** The footer's choice, then the suggestion. "GBP" means the visitor said none. */
function chosen(fallback: GuideCurrency | null): GuideCurrency | null {
  const picked = stored(CHOICE, () => localStorage);
  if (picked === 'GBP') return null;
  if (picked && isGuideCurrency(picked)) return picked;
  return fallback;
}

function guideFor(el: HTMLElement): HTMLElement {
  const next = el.nextElementSibling;
  if (next instanceof HTMLElement && next.dataset.fx !== undefined) return next;
  const span = document.createElement('span');
  span.dataset.fx = '';
  span.className = 'fx text-[13px] font-normal font-[family-name:var(--font-body)] text-[var(--color-ink-soft)] whitespace-nowrap';
  el.insertAdjacentElement('afterend', span);
  return span;
}

async function paint(): Promise<void> {
  const all = prices();
  const select = footerSelect();
  if (!all.length && !select) return;

  // A page with no prices (the basket, the policies) only needs the footer to
  // show the right choice, which never needs a request.
  if (!all.length) {
    if (select) select.value = chosen(answer?.suggest ?? readSession()?.suggest ?? null) ?? 'GBP';
    return;
  }

  const got = await rates();
  const code = chosen(got?.suggest ?? null);
  if (select) select.value = code ?? 'GBP';
  const rate = code ? got?.rates[code] : undefined;

  for (const el of all) {
    const pence = Number(el.dataset.gbp);
    const guide = guideFor(el);
    if (!code || !rate || !Number.isFinite(pence) || pence <= 0) {
      guide.hidden = true;
      continue;
    }
    guide.textContent = formatGuide(pence, rate, code);
    guide.hidden = false;
  }
}

// A price that changes in place - the book page's multi-buy total - says so by
// changing its `data-gbp`, and its guide follows.
const watcher = new MutationObserver(() => void paint());
for (const el of prices()) watcher.observe(el, { attributes: true, attributeFilter: ['data-gbp'] });

footerSelect()?.addEventListener('change', () => {
  keep(CHOICE, footerSelect()?.value ?? 'GBP', () => localStorage);
  void paint();
});

void paint();
