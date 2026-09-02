import { env } from 'cloudflare:workers';

/**
 * What people looked for and did not find.
 *
 * A search that returns nothing is a purchase request the shop never hears.
 * This is the only place that reads or writes the log, so the normalising
 * rule - the thing that decides whether two spellings are one row or two -
 * lives in one function rather than at each call site.
 */

/** Below this everything matches; above it, nobody typed it on purpose. */
const MIN = 2;
const MAX = 80;

/**
 * Trimmed, lower-cased, punctuation dropped, spaces collapsed.
 *
 * Without this "Nur al Idah", "nur al-idah" and "  Nur Al Idah " are three
 * rows saying one thing, and the panel that reads them is unreadable. Letters
 * and digits in any script survive, so Arabic normalises as well as English.
 */
export function normalise(raw: string): string | null {
  const terms = raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
  return terms.length >= MIN && terms.length <= MAX ? terms : null;
}

/**
 * Records one fruitless search.
 *
 * Never awaited by the page - the caller hands it to `waitUntil` - and never
 * throws: a log that cannot be written is not a reason to fail somebody's
 * search results.
 */
export async function recordMiss(raw: string): Promise<void> {
  const terms = normalise(raw);
  if (!terms) return;
  try {
    await env.DB.prepare('INSERT INTO searches (terms) VALUES (?)').bind(terms).run();
  } catch {
    /* the log is a convenience; the catalogue is not */
  }
}

export interface Miss {
  terms: string;
  times: number;
  lastAt: number;
}

/**
 * The most-asked-for things the shop does not have.
 *
 * Grouped, so fifteen rows are fifteen different wants rather than one
 * popular one repeated. Written to be run inside the dashboard's existing
 * `db.batch`, so the panel costs no extra round trip.
 */
export function missesQuery(days: number, limit = 15): D1PreparedStatement {
  return env.DB.prepare(
    `SELECT terms, COUNT(*) AS times, MAX(at) AS lastAt
       FROM searches
      WHERE at > unixepoch() - ?1 * 86400
      GROUP BY terms
      ORDER BY times DESC, lastAt DESC
      LIMIT ?2`,
  ).bind(days, limit);
}

/**
 * Throws away anything older than 90 days.
 *
 * A log nobody trims is a liability rather than an asset: this is free text a
 * customer typed, and people occasionally type things that identify them.
 */
export async function pruneSearches(db: D1Database, days = 90): Promise<number> {
  const result = await db
    .prepare('DELETE FROM searches WHERE at < unixepoch() - ?1 * 86400')
    .bind(days)
    .run();
  return result.meta.changes ?? 0;
}
