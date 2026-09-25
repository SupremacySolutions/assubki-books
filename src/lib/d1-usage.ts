import { env } from 'cloudflare:workers';
import { cachedRead } from './read-cache';

/**
 * How much of D1's daily allowance the shop has spent.
 *
 * On 24 and 25 September the shop went offline for an hour each day, both times
 * because this number passed its limit and D1 stopped answering. Both times it
 * was invisible until customers were already seeing a closed sign. The cause
 * turned out to be AI crawlers - Amazonbot up 538% in days, GPTBot up 298%,
 * together 92% of all traffic - and the fix was to block them at the edge. But
 * the reason it became an outage rather than a Tuesday is that nobody was
 * watching a number that only moves when something is wrong.
 *
 * So it goes on the dashboard the owner already opens. A tile reading
 * "1.2M / 5M" on the Wednesday would have shown the crawl starting.
 *
 * This is the only thing in the portal that reads from outside Cloudflare's
 * edge, and it is deliberately incapable of breaking the page: no token, a
 * refused token, a slow API or a shape we did not expect all return `null`, and
 * the tile renders a quiet "not set up" instead. A dashboard that will not load
 * because a metrics API is having a bad morning is worse than no tile.
 */

/** The free plan's ceiling. Passing it stops D1 answering until midnight UTC. */
export const D1_DAILY_ROW_LIMIT = 5_000_000;

export interface D1Usage {
  /** Rows read so far today, counted in UTC as the allowance is. */
  rowsRead: number;
  readQueries: number;
  rowsWritten: number;
  /** Oldest first, for a sparkline. Today is the last entry. */
  days: { date: string; rowsRead: number }[];
}

const QUERY = `
  query Usage($account: string!, $db: string!, $start: Date!, $end: Date!) {
    viewer {
      accounts(filter: { accountTag: $account }) {
        d1AnalyticsAdaptiveGroups(
          limit: 100
          filter: { date_geq: $start, date_leq: $end, databaseId: $db }
          orderBy: [date_ASC]
        ) {
          sum { readQueries, rowsRead, rowsWritten }
          dimensions { date }
        }
      }
    }
  }`;

const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

interface Group {
  sum: { readQueries: number; rowsRead: number; rowsWritten: number };
  dimensions: { date: string };
}

async function readUsage(): Promise<D1Usage | null> {
  const vars = env as unknown as Record<string, string | undefined>;
  const token = vars.CLOUDFLARE_API_TOKEN;
  const account = vars.CLOUDFLARE_ACCOUNT_ID;
  const db = vars.D1_DATABASE_ID;
  if (!token || !account || !db) return null;

  try {
    const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: QUERY,
        variables: { account, db, start: day(-6), end: day(0) },
      }),
    });
    if (!response.ok) return null;

    const body = (await response.json()) as {
      data?: { viewer?: { accounts?: { d1AnalyticsAdaptiveGroups?: Group[] }[] } };
    };
    const groups = body.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups;
    if (!groups) return null;

    const days = groups.map((g) => ({ date: g.dimensions.date, rowsRead: g.sum.rowsRead }));
    const today = groups.find((g) => g.dimensions.date === day(0));

    return {
      rowsRead: today?.sum.rowsRead ?? 0,
      readQueries: today?.sum.readQueries ?? 0,
      rowsWritten: today?.sum.rowsWritten ?? 0,
      days,
    };
  } catch {
    // Unreachable, slow, or a shape that has changed. The dashboard goes on.
    return null;
  }
}

/**
 * Cached for five minutes.
 *
 * Longer than it sounds, and deliberately: the number this reports moves over
 * hours, the owner opens the dashboard all day, and Cloudflare's own figure
 * lags by a few minutes anyway. Asking per page load would spend a request on
 * an answer that has not changed.
 */
export function d1Usage(): Promise<D1Usage | null> {
  return cachedRead('d1-usage', 300, readUsage);
}

/** What the tile should say about itself, so the page holds no judgement. */
export function usageLevel(rowsRead: number): 'calm' | 'watch' | 'urgent' {
  const share = rowsRead / D1_DAILY_ROW_LIMIT;
  if (share >= 0.8) return 'urgent';
  if (share >= 0.5) return 'watch';
  return 'calm';
}

/** "1.2M", "847k", "912" - the tile has one line to say this in. */
export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}
