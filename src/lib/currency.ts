/**
 * A visitor's own currency, as a guide beside the price in pounds.
 *
 * Pounds stay the price. Payment is a bank transfer in sterling, arranged
 * outside the site, so the figure a customer pays is the pound figure and
 * whatever their bank makes of it on the day. "About $97" next to "£77.00"
 * answers the question an overseas customer has - roughly how much is that? -
 * without promising a number the shop does not charge.
 *
 * Shared by the rates route and the page script, and kept free of anything
 * server-only so a later step can use it too: quoting a fixed total in the
 * customer's currency in the payment email, once there is an account to
 * receive it in.
 */

export const GUIDE_CURRENCIES = [
  'USD', 'EUR', 'CAD', 'AUD', 'NZD', 'ZAR', 'PKR', 'INR', 'BDT', 'MYR', 'SAR', 'AED',
] as const;

export type GuideCurrency = (typeof GUIDE_CURRENCIES)[number];

export const isGuideCurrency = (code: string): code is GuideCurrency =>
  (GUIDE_CURRENCIES as readonly string[]).includes(code);

/** For the footer's list. */
export const CURRENCY_NAMES: Record<GuideCurrency, string> = {
  USD: 'US dollars',
  EUR: 'Euros',
  CAD: 'Canadian dollars',
  AUD: 'Australian dollars',
  NZD: 'New Zealand dollars',
  ZAR: 'South African rand',
  PKR: 'Pakistani rupees',
  INR: 'Indian rupees',
  BDT: 'Bangladeshi taka',
  MYR: 'Malaysian ringgit',
  SAR: 'Saudi riyals',
  AED: 'UAE dirhams',
};

const EUROZONE = [
  'AT', 'BE', 'HR', 'CY', 'EE', 'FI', 'FR', 'DE', 'GR', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT',
  'NL', 'PT', 'SK', 'SI', 'ES',
];

/**
 * The currency to suggest for a country, from Cloudflare's guess at where the
 * visitor is. Null for the UK and anywhere not listed: no guide is better
 * than a guess in a currency they do not use.
 */
export function currencyFor(country: string | null | undefined): GuideCurrency | null {
  const c = (country ?? '').toUpperCase();
  if (EUROZONE.includes(c)) return 'EUR';
  const direct: Record<string, GuideCurrency> = {
    US: 'USD', CA: 'CAD', AU: 'AUD', NZ: 'NZD', ZA: 'ZAR', PK: 'PKR', IN: 'INR', BD: 'BDT',
    MY: 'MYR', SA: 'SAR', AE: 'AED',
  };
  return direct[c] ?? null;
}

/**
 * "about $97", "about €88.50", "about Rs 27,100".
 *
 * Rounded so it reads as the estimate it is: to the half under 100, whole
 * numbers above, and to the hundred past 10,000 - a rupee figure to the paisa
 * would look like a quote.
 */
export function formatGuide(pence: number, rate: number, code: GuideCurrency): string {
  const value = (pence / 100) * rate;
  const rounded = value >= 10000 ? Math.round(value / 100) * 100 : value >= 100 ? Math.round(value) : Math.round(value * 2) / 2;
  const whole = Number.isInteger(rounded);
  const text = new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: code,
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(rounded);
  return `about ${text}`;
}
