import { IMAGE_VERSION, type PresetName } from './image-presets';

export const SITE = {
  name: 'As-Subkī Books',
  // Absolute, because email has no notion of a relative URL.
  url: 'https://assubkibooks.co.uk',
  nameAr: 'مكتبة السبكي',
  tagline: 'An affordable Islamic bookshop with a vast catalogue',
  telegram: 'https://t.me/alsubkibooks',
  email: 'subkibooks@gmail.com',
  // Business address supplied by the shop. Collection is by arrangement.
  address: {
    street: '2 Atkinson Street',
    locality: 'Leicester',
    region: '',
    postcode: 'LE5 3QA',
    country: 'GB',
  },
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

/**
 * Plain text from the owner → the same safe HTML subset the importer produces.
 * The reverse of {@link htmlToPlainText}; every description form saves through it.
 */
export function plainTextToHtml(text: string): string | null {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (!clean) return null;
  const escape = (s: string) =>
    s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
  return clean
    .split(/\n{2,}/)
    .map((para) => `<p>${escape(para).replace(/\n/g, '<br>')}</p>`)
    .join('');
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
