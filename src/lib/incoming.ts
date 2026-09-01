/**
 * Describing a delivery that has not arrived.
 *
 * Two parts, never a date. A shop that promises the 14th and delivers on the
 * 20th has broken a promise; one that says "mid-October" and arrives on the
 * 12th has kept it. The owner is given no way to be precise, because being
 * precise about a shipment nobody controls is how a shop ends up apologising.
 */

export const VAGUE = [
  { value: 'early', label: 'Early' },
  { value: 'mid', label: 'Mid' },
  { value: 'late', label: 'Late' },
  { value: 'sometime', label: 'Sometime in' },
] as const;

/** The next eighteen months, which is further ahead than any real order. */
export function monthOptions(from = new Date()): { value: string; label: string }[] {
  return Array.from({ length: 18 }, (_, i) => {
    const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + i, 1));
    return {
      value: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`,
      label: d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    };
  });
}

/**
 * "mid-October", or "sometime in October 2026" when the year is not this one.
 *
 * The year is dropped for months close at hand, because "mid-October 2026" in
 * September 2026 is a date stamp rather than a sentence.
 */
export function whenText(vague: string | null, month: string | null, now = new Date()): string | null {
  if (!month) return null;
  const [y, m] = month.split('-').map(Number);
  if (!y || !m) return null;

  const name = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', {
    month: 'long',
    timeZone: 'UTC',
  });
  const withYear = y === now.getUTCFullYear() ? name : `${name} ${y}`;

  switch (vague) {
    case 'early':
      return `early ${withYear}`;
    case 'late':
      return `late ${withYear}`;
    case 'sometime':
      return `sometime in ${withYear}`;
    case 'mid':
      return `mid-${withYear}`;
    default:
      return withYear;
  }
}

/** Everything a card needs to talk about a delivery, or null if there is none. */
export function delivery(book: {
  incoming: number;
  reserved_incoming: number;
  reservable: number;
  incoming_vague: string | null;
  incoming_month: string | null;
}): { coming: number; claimed: number; free: number; when: string | null } | null {
  if (!book.incoming) return null;
  return {
    coming: book.incoming,
    claimed: book.reserved_incoming,
    free: book.reservable,
    when: whenText(book.incoming_vague, book.incoming_month),
  };
}
