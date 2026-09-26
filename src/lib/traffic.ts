import { env } from 'cloudflare:workers';
import { cachedRead } from './read-cache';

/**
 * How many requests reached the shop, and from how many people.
 *
 * Cloudflare counts every request at the edge, including the ones that never
 * run a page - which is the whole point, because on 24 and 25 September 2026
 * about 92% of the traffic was AI crawlers and none of it was ever going to
 * appear in anything the shop counted itself.
 *
 * **Requests per visitor is the signal here.** The free plan does not sell the
 * bot classification through this API - `botScore` needs Bot Management, which
 * is a paid add-on - so there is no honest human-versus-crawler split to show.
 * But requests and unique visitors are both free, and their ratio says most of
 * it anyway: people look at a few pages, crawlers look at thousands. A day that
 * reads 8,000 requests from 40 visitors is not a busy day.
 *
 * What it cannot do is name the crawler. Cloudflare's own panel does that, and
 * puts a block toggle beside each one, so the page links there rather than
 * keeping a worse copy.
 */

/** The shop's own hostname, used to find the zone without another config value. */
const ZONE_NAME = 'assubkibooks.co.uk';

export interface Traffic {
  requests: number;
  uniques: number;
  pageViews: number;
  /** Oldest first. Today is the last entry. */
  days: { date: string; requests: number; uniques: number }[];
}

const ZONE_QUERY = `
  query Zone($name: string!) {
    viewer { zones(filter: { zoneName: $name }) { zoneTag } }
  }`;

const TRAFFIC_QUERY = `
  query Traffic($zone: string!, $start: Date!, $end: Date!) {
    viewer {
      zones(filter: { zoneTag: $zone }) {
        httpRequests1dGroups(
          limit: 100
          filter: { date_geq: $start, date_leq: $end }
          orderBy: [date_ASC]
        ) {
          sum { requests pageViews }
          uniq { uniques }
          dimensions { date }
        }
      }
    }
  }`;

const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function graphql<T>(token: string, query: string, variables: unknown): Promise<T | null> {
  try {
    const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { data?: T; errors?: unknown[] };
    /* GraphQL answers 200 with an errors array when a field is not permitted,
       which is exactly how a token without the zone scope fails. */
    if (body.errors?.length) return null;
    return body.data ?? null;
  } catch {
    return null;
  }
}

interface Group {
  sum: { requests: number; pageViews: number };
  uniq: { uniques: number };
  dimensions: { date: string };
}

async function readTraffic(): Promise<Traffic | null> {
  const token = (env as unknown as Record<string, string | undefined>).CLOUDFLARE_API_TOKEN;
  if (!token) return null;

  const zones = await graphql<{ viewer: { zones: { zoneTag: string }[] } }>(token, ZONE_QUERY, {
    name: ZONE_NAME,
  });
  const zone = zones?.viewer?.zones?.[0]?.zoneTag;
  if (!zone) return null;

  const data = await graphql<{ viewer: { zones: { httpRequests1dGroups: Group[] }[] } }>(
    token,
    TRAFFIC_QUERY,
    { zone, start: day(-6), end: day(0) },
  );
  const groups = data?.viewer?.zones?.[0]?.httpRequests1dGroups;
  if (!groups) return null;

  const days = groups.map((g) => ({
    date: g.dimensions.date,
    requests: g.sum.requests,
    uniques: g.uniq.uniques,
  }));
  const today = groups.find((g) => g.dimensions.date === day(0));

  return {
    requests: today?.sum.requests ?? 0,
    pageViews: today?.sum.pageViews ?? 0,
    uniques: today?.uniq.uniques ?? 0,
    days,
  };
}

/** Cached like the usage figures, and for the same reason. */
export function traffic(): Promise<Traffic | null> {
  return cachedRead('zone-traffic', 300, readTraffic);
}

/**
 * Requests per visitor, and what to make of it.
 *
 * Not a verdict, a prompt: the shop cannot tell a crawler from a keen customer
 * and should not pretend to. Above about twenty requests a visitor something is
 * reading the catalogue rather than shopping in it, and the crawler panel is
 * where that gets a name.
 */
export function perVisitor(t: Traffic): { ratio: number; automated: boolean } {
  const ratio = t.uniques > 0 ? t.requests / t.uniques : 0;
  return { ratio, automated: ratio >= 20 };
}
