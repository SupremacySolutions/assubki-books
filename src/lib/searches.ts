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
 * - **it is not a declared robot.** AI crawlers and agent browsers (GPTBot,
 *   ClaudeBot, Perplexity, headless Chrome) do run pages, follow forms and send
 *   the same-origin header a person's browser does. They name themselves in the
 *   user agent, so that is where they are turned away. A missing user agent is
 *   a script, never a browser.
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
  if (isRobot(headers.get('user-agent'))) return false;
  if ((headers.get('cookie') ?? '').split(/;\s*/).some((c) => c.startsWith(`${sessionCookie}=`))) {
    return false;
  }
  return plausible(raw);
}

/**
 * A user agent that says it is not a person.
 *
 * Deliberately broad: a false positive costs one row in a list the owner reads
 * for ideas, while a false negative is a crawler's guess at a title printed as
 * if a customer asked for it.
 */
const ROBOT =
  /bot\b|bot\/|crawl|spider|slurp|scrap|headless|phantom|puppeteer|playwright|selenium|lighthouse|pagespeed|preview|fetch|python|curl|wget|httpclient|okhttp|go-http|java\/|node-fetch|axios|undici|gpt|openai|chatgpt|claude|anthropic|perplexity|bytespider|ccbot|cohere|diffbot|amazonbot|applebot|google-extended|meta-external|facebookexternalhit|semrush|ahrefs|mj12|dotbot|yandex|baidu|petal|duckassist|youbot|timpibot|imagesift|omgili/i;

export function isRobot(userAgent: string | null): boolean {
  if (!userAgent || userAgent.trim().length < 10) return true;
  return ROBOT.test(userAgent);
}

/**
 * The same person on the same day, without knowing who they are.
 *
 * A one-way hash of the connecting address and browser, salted with a server
 * secret and today's date. Used only to count a searcher once; it cannot be
 * reversed, joined to an order, or followed from one day to the next.
 */
export async function visitorKey(request: Request, secret: string): Promise<string> {
  const ip = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for') ?? '';
  const ua = request.headers.get('user-agent') ?? '';
  const day = new Date().toISOString().slice(0, 10);
  const bytes = new TextEncoder().encode(`${secret}|${day}|${ip}|${ua}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest.slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
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
export async function recordMiss(raw: string, visitor: string | null = null): Promise<void> {
  const terms = normalise(raw);
  if (!terms) return;
  try {
    /*
     * One row per person per wording per day. The count reads distinct
     * visitors anyway, so a repeat is only a wasted write - skipped here.
     */
    await env.DB.prepare(
      `INSERT INTO searches (terms, visitor)
       SELECT ?1, ?2
        WHERE ?2 IS NULL
           OR NOT EXISTS (SELECT 1 FROM searches
                           WHERE visitor = ?2 AND terms = ?1 AND at > unixepoch() - 86400)`,
    ).bind(terms, visitor).run();
  } catch {
    /* the log is a convenience; the catalogue is not */
  }
}

/**
 * Records a miss against the person who made it.
 *
 * The salt is the portal's session secret: already private, already on every
 * deployment, and never shown to anybody.
 */
export async function recordMissFrom(request: Request, raw: string): Promise<void> {
  try {
    const secrets = env as unknown as { ADMIN_SESSION_SECRET?: string; ADMIN_PASSWORD?: string };
    const salt = secrets.ADMIN_SESSION_SECRET ?? secrets.ADMIN_PASSWORD ?? 'assubki';
    await recordMiss(raw, await visitorKey(request, salt));
  } catch {
    /* the log is a convenience; the catalogue is not */
  }
}

export interface Miss {
  terms: string;
  /** How many different people searched it - not how many times. */
  times: number;
  lastAt: number;
  /** Other spellings of the same search, grouped under this one. */
  also?: string[];
  /** Who searched it, so spellings can be merged without counting anyone twice. */
  visitors?: string[];
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
    /* One person typing two spellings is still one person. */
    const people = new Set(list.flatMap((r) => r.visitors ?? []));
    return {
      terms: lead.terms,
      times: people.size > 0 ? people.size : list.reduce((n, r) => n + r.times, 0),
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
  /*
   * People, not submissions. A row from before `visitor` existed stands for
   * itself, which is how it was counted then.
   */
  return env.DB.prepare(
    `SELECT terms, COUNT(DISTINCT COALESCE(visitor, 'r' || id)) AS times, MAX(at) AS lastAt,
            GROUP_CONCAT(DISTINCT COALESCE(visitor, 'r' || id)) AS visitors
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
