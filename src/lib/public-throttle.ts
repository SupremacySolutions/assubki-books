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
    const now = Math.floor(Date.now() / 1000);
    const since = now - limit.window;

    /*
     * One statement decides it, because two cannot.
     *
     * Counting first and inserting afterwards is a gap: a burst from one source
     * all read the same below-limit count, all found room, and all went
     * through - which is precisely the traffic this exists to stop, and the
     * sequential test never saw it because requests arrived one at a time.
     *
     * A conditional INSERT closes it. SQLite evaluates a single statement
     * atomically, so the row is only written if the count *at the moment of
     * writing* is under the limit, and `changes` is the verdict.
     */
    const claimed = await env.DB.prepare(
      `INSERT INTO public_actions (action, ip)
       SELECT ?1, ?2
        WHERE (SELECT COUNT(*) FROM public_actions
                WHERE action = ?1 AND ip = ?2 AND at > ?3) < ?4`,
    )
      .bind(action, ip, since, limit.perHour)
      .run();

    if (!claimed.meta.changes) {
      // Only now is a second read worth making: from the oldest attempt still
      // inside the window, which is when a slot next frees.
      const oldest = await env.DB.prepare(
        `SELECT COALESCE(MIN(at), ?3) AS first FROM public_actions
          WHERE action = ?1 AND ip = ?2 AND at > ?3`,
      )
        .bind(action, ip, since)
        .first<{ first: number }>();
      return { blocked: true, retryAfter: Math.max(1, (oldest?.first ?? now) + limit.window - now) };
    }

    // Housekeeping, off the critical path of the decision above.
    await env.DB.prepare('DELETE FROM public_actions WHERE at < ?')
      .bind(now - KEEP_SECONDS)
      .run();

    return { blocked: false, retryAfter: 0 };
  } catch (err) {
    console.error('[throttle] could not count', action, err);
    return { blocked: false, retryAfter: 0 };
  }
}
