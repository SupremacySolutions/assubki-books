export const SITE = {
  name: 'As-Subkī Books',
  nameAr: 'مكتبة السبكي',
  tagline: 'An affordable Islamic bookshop with a vast catalogue',
  telegram: 'https://t.me/alsubkibooks',
  email: 'support.supremacysolutions@gmail.com',
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

export function stripTags(html: string | null | undefined): string {
  return (html ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
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
