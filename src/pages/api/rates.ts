import type { APIRoute } from 'astro';
import { cachedRead } from '../../lib/read-cache';
import { currencyFor, GUIDE_CURRENCIES, type GuideCurrency } from '../../lib/currency';

export const prerender = false;

/**
 * Today's rates from the pound, and the currency to suggest to this visitor.
 *
 * For the "about $97" beside a price - see src/lib/currency.ts. Costs no
 * database read at all: the rates come from a free public source (the
 * ExchangeRate-API open endpoint, which updates once a day and asks for a
 * credit, given in the footer) and are held in the Cache API for twelve
 * hours, so a data centre asks it twice a day whatever the traffic.
 *
 * The suggestion comes from Cloudflare's guess at the visitor's country, which
 * is why the answer is private to the browser: one visitor's suggestion must
 * not be served to the next.
 *
 * When the source cannot be reached the answer is simply no rates, and the
 * page shows no guide - never a stale or invented one.
 */

const SOURCE = 'https://open.er-api.com/v6/latest/GBP';
const KEEP_FOR = 12 * 60 * 60;

interface Rates {
  at: number;
  rates: Partial<Record<GuideCurrency, number>>;
}

let memory: { until: number; value: Rates } | null = null;

async function fetchRates(): Promise<Rates | null> {
  try {
    const res = await fetch(SOURCE, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { result?: string; time_last_update_unix?: number; rates?: Record<string, unknown> };
    if (data.result !== 'success' || !data.rates) return null;
    const rates: Rates['rates'] = {};
    for (const code of GUIDE_CURRENCIES) {
      const rate = data.rates[code];
      if (typeof rate === 'number' && Number.isFinite(rate) && rate > 0) rates[code] = rate;
    }
    return Object.keys(rates).length ? { at: data.time_last_update_unix ?? Math.floor(Date.now() / 1000), rates } : null;
  } catch {
    return null;
  }
}

export const GET: APIRoute = async ({ request }) => {
  let value = memory && memory.until > Date.now() ? memory.value : null;
  if (!value) {
    value = await cachedRead('fx-gbp', KEEP_FOR, fetchRates);
    if (value) memory = { until: Date.now() + 10 * 60 * 1000, value };
  }

  const country = (request as Request & { cf?: { country?: string } }).cf?.country ?? null;
  return Response.json(
    { at: value?.at ?? null, rates: value?.rates ?? {}, suggest: currencyFor(country) },
    { headers: { 'Cache-Control': 'private, max-age=21600' } },
  );
};
