export const SITE = {
  name: 'As-Subkī Books',
  // Absolute, because email has no notion of a relative URL.
  url: 'https://assubkibooks.co.uk',
  nameAr: 'مكتبة السبكي',
  tagline: 'An affordable Islamic bookshop with a vast catalogue',
  telegram: 'https://t.me/alsubkibooks',
  email: 'subkibooks@gmail.com',
} as const;

export function price(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}

/** Availability as the shop states it, not as the database stores it. */
export function availability(available: number): { label: string; state: 'in' | 'low' | 'out' } {
  if (available <= 0) return { label: 'Out of stock', state: 'out' };
  if (available <= 2) return { label: `Only ${available} left`, state: 'low' };
  return { label: 'In stock', state: 'in' };
}

/** "books/al-nahw-al-wadih/1.webp" → "/img/books/al-nahw-al-wadih/1.webp" */
export function imageUrl(key: string | null | undefined): string | null {
  return key ? `/img/${key}` : null;
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
