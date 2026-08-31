import { getSetting } from './settings';

/**
 * The message shown while the shop is closed, or empty when it is open.
 *
 * Cached for half a minute. This is read on every customer request, and the
 * lesson from `categoryCounts` is still fresh: a per-request query on the
 * busiest path is how a database runs out of budget. Half a minute is short
 * enough that turning the shop back on feels immediate.
 */
let cache: { at: number; value: string } | null = null;

export async function maintenanceNotice(): Promise<string> {
  const now = Date.now();
  if (cache && now - cache.at < 30_000) return cache.value;

  let value = '';
  try {
    value = (await getSetting('maintenance')).trim();
  } catch {
    // If the database cannot be reached, the shop stays open. Closing it on an
    // error would turn a blip into an outage.
  }
  cache = { at: now, value };
  return value;
}

/** Called when the owner flips it, so it takes effect at once. */
export function forgetMaintenance(): void {
  cache = null;
}
