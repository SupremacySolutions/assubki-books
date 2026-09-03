import { env } from 'cloudflare:workers';

/**
 * How often one address may do the two things a stranger can do.
 *
 * Placing an order and starting a group basket both reserve stock, make work
 * for the owner and send email or Telegram traffic. Neither had a limit, so a
 * script could take the catalogue out of stock and fill the shop's inbox in the
 * same pass.
 *
 * Counted in D1, like the login throttle, because Workers isolates are plural
 * and a counter in memory protects nothing.
 *
 * The numbers are deliberately generous. A madrasah ordering for a class, or a
 * customer who mistypes an address and tries again, must never meet this - it
 * is here for a script, not for a busy afternoon.
 */
export const LIMITS = {
  order: { perHour: 12, window: 3600 },
  group: { perHour: 6, window: 3600 },
} as const;

export type PublicAction = keyof typeof LIMITS;

/** Attempts older than this are of no interest and are pruned as we go. */
const KEEP_SECONDS = 24 * 60 * 60;

export interface ThrottleVerdict {
  blocked: boolean;
  /** Seconds until they may try again. Only meaningful when blocked. */
  retryAfter: number;
}

/**
 * Whether this address has had its allowance, and records the attempt if not.
 *
 * Recorded before the work rather than after, so a request that fails half way
 * still counts - otherwise the cheapest way past this would be to make the
 * order fail.
 *
 * Never throws: a throttle that cannot read its own table must not be the
 * reason a real customer cannot order.
 */
export async function takePublicAction(
  action: PublicAction,
  request: Request,
): Promise<ThrottleVerdict> {
  const limit = LIMITS[action];

  /*
   * Somebody the shop can actually tell apart, or no throttle at all.
   *
   * `CF-Connecting-IP` is set by Cloudflare at the edge and cannot be spoofed
   * by a client - in production this Worker is only reachable through it, so
   * the header is always there and always a real visitor.
   *
   * Two cases are not that. With no header there is nobody to count, and every
   * request would land in one bucket called "unknown" - so the thirteenth
   * visitor of the hour would be refused because of the twelve before them,
   * which is worse than not counting. A loopback address means the request came
   * from the machine running the shop, which in production cannot happen; local
   * development is the only place it does, and the test suite is not the abuse
   * this defends against.
   */
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip || ip === '127.0.0.1' || ip === '::1') return { blocked: false, retryAfter: 0 };

  try {
    const since = Math.floor(Date.now() / 1000) - limit.window;
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n, COALESCE(MIN(at), 0) AS first
         FROM public_actions WHERE action = ? AND ip = ? AND at > ?`,
    )
      .bind(action, ip, since)
      .first<{ n: number; first: number }>();

    if ((row?.n ?? 0) >= limit.perHour) {
      // From the oldest attempt still in the window: that is when a slot frees.
      const retryAfter = Math.max(
        1,
        (row!.first + limit.window) - Math.floor(Date.now() / 1000),
      );
      return { blocked: true, retryAfter };
    }

    await env.DB.batch([
      env.DB.prepare('INSERT INTO public_actions (action, ip) VALUES (?, ?)').bind(action, ip),
      env.DB.prepare('DELETE FROM public_actions WHERE at < ?').bind(
        Math.floor(Date.now() / 1000) - KEEP_SECONDS,
      ),
    ]);
    return { blocked: false, retryAfter: 0 };
  } catch (err) {
    console.error('[throttle] could not count', action, err);
    return { blocked: false, retryAfter: 0 };
  }
}
