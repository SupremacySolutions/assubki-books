import { env } from 'cloudflare:workers';
import { closeMatches } from './db';
import { foldKey } from './fuzzy';

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
 * Whether a search came from a person using the shop's own search box.
 *
 * The log was mostly not people. In the first two months, 159 of 465 entries
 * were "search term string" - the placeholder in the search-box description
 * the home page gives Google, fetched as a literal by crawlers - and about 60
 * were a security scanner posting fragments of markup ("'><asdf alt=...") at
 * the box in every encoding it knew. Neither is anybody telling the owner what
 * to stock, and together they buried the ones that were.
 *
 * So a search counts only when:
 *
 * - **the browser says it came from this site.** A form submitted from one of
 *   the shop's pages arrives with `Sec-Fetch-Site: same-origin`; every current
 *   browser sends it, and crawlers and scanners requesting the URL directly do
 *   not. A browser too old to send it is accepted on a same-site `Referer`.
 *   A link pasted into a chat or typed into the address bar is not counted -
 *   rare for a search, and indistinguishable from a robot.
 * - **it is not the owner.** Anybody holding a portal session is testing the
 *   shop, and "test" was the second most common entry.
 * - **it reads like words.** Markup, percent-escapes and long runs of hex are
 *   what probes look like; a title somebody wants does not contain `<` or
 *   `%3E`, and the normaliser would otherwise turn them into plausible-looking
 *   rows of letters.
 */
export function isHumanSearch(request: Request, raw: string, sessionCookie: string): boolean {
  const headers = request.headers;
  const site = headers.get('sec-fetch-site');
  const own = new URL(request.url).host;
  let fromHere = site === 'same-origin';
  if (site === null) {
    try {
      fromHere = new URL(headers.get('referer') ?? '').host === own;
    } catch {
      fromHere = false;
    }
  }
  if (!fromHere) return false;
  if ((headers.get('cookie') ?? '').split(/;\s*/).some((c) => c.startsWith(`${sessionCookie}=`))) {
    return false;
  }
  return plausible(raw);
}

/** Words somebody might type, rather than a probe or a template placeholder. */
export function plausible(raw: string): boolean {
  if (/[<>"=\\{}]|%[0-9a-f]{2}|&#?[a-z0-9]+;|\\x[0-9a-f]{2}/i.test(raw)) return false;
  // Hex is letters and digits mixed; an ISBN is digits alone and is a search.
  if (/(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{12,}/i.test(raw.replace(/\s+/g, ''))) return false;
  if (/search[\s_]*term[\s_]*string/i.test(raw)) return false;
  return /\p{L}{2,}/u.test(raw) || /^\s*[\d-]{10,17}\s*$/.test(raw);
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
  /** Other spellings of the same search, grouped under this one. */
  also?: string[];
}

/**
 * The log, as the owner should read it.
 *
 * Spellings of one search become one line: "binaya", "binayah" and "al
 * binayah" are one person's want written three ways, and listed apart each
 * looked too rare to act on. They are grouped by the same sound-skeleton the
 * catalogue's close-spelling search uses, under whichever spelling was typed
 * most.
 *
 * And a search the shop can now answer is set aside: the owner has stocked it
 * since, or the close-spelling search finds it. Left in the list it read as
 * stock the shop was missing when it was stock the shop had.
 */
export async function readMisses(rows: Miss[], limit = 15): Promise<{ open: Miss[]; answered: Miss[] }> {
  const groups = new Map<string, Miss[]>();
  for (const row of rows) {
    const key = foldKey(row.terms) || row.terms;
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }

  const merged: Miss[] = [...groups.values()].map((list) => {
    const [lead, ...rest] = [...list].sort((a, b) => b.times - a.times || b.lastAt - a.lastAt);
    return {
      terms: lead.terms,
      times: list.reduce((n, r) => n + r.times, 0),
      lastAt: Math.max(...list.map((r) => r.lastAt)),
      also: rest.map((r) => r.terms),
    };
  });
  merged.sort((a, b) => b.times - a.times || b.lastAt - a.lastAt);

  const open: Miss[] = [];
  const answered: Miss[] = [];
  for (const miss of merged) {
    if (open.length >= limit && answered.length >= limit) break;
    const found = (await closeMatches(miss.terms, 1)).length > 0;
    if (found) {
      if (answered.length < limit) answered.push(miss);
    } else if (open.length < limit) {
      open.push(miss);
    }
  }
  return { open, answered };
}

/**
 * The most-asked-for things the shop does not have.
 *
 * Grouped, so fifteen rows are fifteen different wants rather than one
 * popular one repeated. Written to be run inside the dashboard's existing
 * `db.batch`, so the panel costs no extra round trip.
 */
export function missesQuery(days: number, limit = 80): D1PreparedStatement {
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
