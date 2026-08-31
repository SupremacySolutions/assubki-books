import { env } from 'cloudflare:workers';

/**
 * How hard someone may try to guess the portal password.
 *
 * There was no limit at all, against a portal that can read every customer's
 * name, address and phone number. A shared password with unlimited guesses is
 * a password with a shelf life measured in hours.
 *
 * Counted in D1 rather than in memory: Workers isolates are ephemeral and
 * there are many of them at once, so a module-level counter resets constantly
 * and protects nothing.
 *
 * The **address** is throttled, not the account. Locking "the owner" after
 * five failures would let anyone shut the owner out of their own shop by
 * failing on purpose.
 */

const WINDOW_SECONDS = 15 * 60;
const MAX_FAILURES = 5;
/** Attempts older than this are of no interest and are pruned as we go. */
const KEEP_SECONDS = 24 * 60 * 60;

export interface ThrottleState {
  blocked: boolean;
  failures: number;
  /** Seconds until they may try again. Only meaningful when blocked. */
  retryAfter: number;
}

/**
 * The caller's address.
 *
 * `CF-Connecting-IP` is set by Cloudflare and cannot be spoofed by the client
 * - it is overwritten at the edge. `X-Forwarded-For` deliberately is not
 * trusted: it is attacker-controlled, and using it would let one attacker look
 * like a thousand and never be throttled at all.
 */
export function callerAddress(request: Request): string {
  return request.headers.get('CF-Connecting-IP')?.slice(0, 64) ?? 'unknown';
}

export async function checkThrottle(ip: string): Promise<ThrottleState> {
  const since = Math.floor(Date.now() / 1000) - WINDOW_SECONDS;

  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n, COALESCE(MAX(at), 0) AS last
       FROM login_attempts WHERE ip = ? AND ok = 0 AND at > ?`,
  )
    .bind(ip, since)
    .first<{ n: number; last: number }>();

  const failures = row?.n ?? 0;
  if (failures < MAX_FAILURES) return { blocked: false, failures, retryAfter: 0 };

  // The window runs from the most recent failure, so someone still hammering
  // it stays locked out rather than being let back in on a fixed schedule.
  const retryAfter = Math.max(0, (row!.last + WINDOW_SECONDS) - Math.floor(Date.now() / 1000));
  return { blocked: retryAfter > 0, failures, retryAfter };
}

/** Records the attempt, and takes the opportunity to prune old ones. */
export async function recordAttempt(ip: string, ok: boolean): Promise<void> {
  const statements = [
    env.DB.prepare('INSERT INTO login_attempts (ip, ok) VALUES (?, ?)').bind(ip, ok ? 1 : 0),
    env.DB.prepare('DELETE FROM login_attempts WHERE at < ?').bind(
      Math.floor(Date.now() / 1000) - KEEP_SECONDS,
    ),
  ];

  // A success clears the run: someone who mistyped their password four times
  // and then got it right should not be one slip from being locked out.
  if (ok) {
    statements.push(
      env.DB.prepare('DELETE FROM login_attempts WHERE ip = ? AND ok = 0').bind(ip),
    );
  }

  await env.DB.batch(statements);
}

/** For the settings page: what has been tried, so the owner can see it. */
export async function recentFailures(): Promise<{ count: number; lastAt: number | null }> {
  const since = Math.floor(Date.now() / 1000) - KEEP_SECONDS;
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS n, MAX(at) AS last FROM login_attempts WHERE ok = 0 AND at > ?',
  )
    .bind(since)
    .first<{ n: number; last: number | null }>();
  return { count: row?.n ?? 0, lastAt: row?.last ?? null };
}
