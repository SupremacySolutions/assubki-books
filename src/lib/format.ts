import { IMAGE_VERSION, type PresetName } from './image-presets';

export const SITE = {
  name: 'As-Subkī Books',
  // Absolute, because email has no notion of a relative URL.
  url: 'https://assubkibooks.co.uk',
  nameAr: 'مكتبة السبكي',
  tagline: 'An affordable Islamic bookshop with a vast catalogue',
  telegram: 'https://t.me/alsubkibooks',
  email: 'subkibooks@gmail.com',
  /*
   * Where the shop actually is.
   *
   * Blank until somebody fills them in, and deliberately not guessed - the
   * same rule the policy pages follow. Google cross-checks a Business Profile
   * against the site, so these must end up written exactly as they are on the
   * profile, down to the punctuation.
   *
   * While they are empty the shop cannot appear in map results, and Merchant
   * Center has no contact details to find. Filling them is the single highest
   * return of anything in the SEO work.
   */
  address: {
    street: '',
    locality: 'Leicester',
    region: '',
    postcode: '',
    country: 'GB',
  },
  /*
   * Written the way a person reads it, and converted for machines below.
   *
   * There is no street address here on purpose: the shop's stock is held at
   * another bookseller's premises, under their name and their signage, so it
   * is not an address this shop can claim as its own - to Google or to anybody
   * else. A phone number and an email are what Merchant Center actually asks
   * for, and both are true.
   */
  phone: '07873 546794',
} as const;

/**
 * The phone number in the form machines expect.
 *
 * `+44` and no spaces: schema.org, `tel:` links and Google all want E.164, and
 * a UK mobile written `07873…` is only unambiguous inside the UK.
 */
export const phoneE164 = (): string => `+44${SITE.phone.replace(/\D/g, '').replace(/^0/, '')}`;

/** Whether there is enough of an address to tell Google about. */
export const hasAddress = (): boolean =>
  Boolean(SITE.address.street && SITE.address.postcode);

export function price(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}

/** Availability as the shop states it, not as the database stores it. */
export function availability(available: number): { label: string; state: 'in' | 'low' | 'out' } {
  if (available <= 0) return { label: 'Out of stock', state: 'out' };
  if (available <= 2) return { label: `Only ${available} left`, state: 'low' };
  return { label: 'In stock', state: 'in' };
}

/**
 * "books/al-nahw-al-wadih/1.webp" → "/img/books/al-nahw-al-wadih/1.webp"
 *
 * With a preset, a primary cover comes back as the shared full-bleed crop at
 * the size that place needs - the home page was serving 800px originals into
 * 84px slots, 28 of them.
 */
export function imageUrl(
  key: string | null | undefined,
  preset?: PresetName,
): string | null {
  if (!key) return null;
  return `/img/${key}${preset ? `?p=${preset}&` : '?'}v=${IMAGE_VERSION}`;
}

/** Flattens to a single line - for meta descriptions and Telegram blurbs. */
export function stripTags(html: string | null | undefined): string {
  return (html ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ',
};

/**
 * Reverses the editor's text→HTML conversion, keeping paragraph breaks.
 *
 * `stripTags` cannot be used to populate the edit form: it collapses all
 * whitespace, so two paragraphs come back as one line and re-saving silently
 * merges them. Anything that round-trips through the form must use this.
 */
export function htmlToPlainText(html: string | null | undefined): string {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|blockquote)>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&([a-z#0-9]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, text.lastIndexOf(' ', max) || max).trimEnd()}…`;
}

export function buildQuery(
  base: Record<string, string | number | boolean | null | undefined>,
  patch: Record<string, string | number | boolean | null | undefined> = {},
): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...base, ...patch })) {
    if (v === null || v === undefined || v === '' || v === false) continue;
    params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}
