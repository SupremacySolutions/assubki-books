import { env } from 'cloudflare:workers';

/**
 * Resend's free-plan allowance, and how much of it has gone.
 *
 * 100 a day, resetting at midnight UTC, and 3,000 a month. Past either, every
 * send is refused until it resets. Paid plans have no daily limit; if the shop
 * ever moves to one, these are the two numbers to change.
 */
export const RESEND_DAILY_LIMIT = 100;
export const RESEND_MONTHLY_LIMIT = 3000;

export interface EmailUsage {
  /** Today (UTC), counted by the shop. */
  sentToday: number;
  refusedToday: number;
  /** This calendar month (UTC), counted by the shop. */
  sentThisMonth: number;
  /** Resend's own figures from the last send that carried them, if any. */
  resend: { daily: number | null; monthly: number | null; at: number } | null;
  /** The last time Resend refused a send for being over a limit. */
  refused: { kind: 'daily' | 'monthly'; at: number } | null;
}

export async function emailUsage(): Promise<EmailUsage | null> {
  try {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const month = day.slice(0, 7);
    const [today, monthRow, quota, refusal] = await env.DB.batch([
      env.DB.prepare('SELECT sent, refused FROM email_usage WHERE day = ?').bind(day),
      env.DB.prepare('SELECT COALESCE(SUM(sent), 0) AS sent FROM email_usage WHERE day LIKE ?').bind(`${month}-%`),
      env.DB.prepare(`SELECT value, updated_at FROM settings WHERE key = 'resend_quota'`),
      env.DB.prepare(`SELECT value, updated_at FROM settings WHERE key = 'resend_quota_refused'`),
    ]);
    const t = today.results[0] as { sent: number; refused: number } | undefined;
    const m = monthRow.results[0] as { sent: number } | undefined;
    const q = quota.results[0] as { value: string; updated_at: number } | undefined;
    const r = refusal.results[0] as { value: string; updated_at: number } | undefined;

    let resend: EmailUsage['resend'] = null;
    if (q) {
      try {
        const parsed = JSON.parse(q.value) as { daily: number | null; monthly: number | null };
        resend = { daily: parsed.daily, monthly: parsed.monthly, at: q.updated_at };
      } catch {
        /* an unreadable reading is no reading */
      }
    }

    /*
     * A refusal only matters until the limit it hit resets. Yesterday's daily
     * refusal is history, and showing it in red today would teach the owner to
     * ignore the red.
     */
    let refused: EmailUsage['refused'] = null;
    if (r) {
      const at = new Date(r.updated_at * 1000).toISOString();
      const kind = r.value === 'monthly_quota_exceeded' ? 'monthly' : 'daily';
      if ((kind === 'daily' && at.slice(0, 10) === day) || (kind === 'monthly' && at.slice(0, 7) === month)) {
        refused = { kind, at: r.updated_at };
      }
    }

    return {
      sentToday: Number(t?.sent ?? 0),
      refusedToday: Number(t?.refused ?? 0),
      sentThisMonth: Number(m?.sent ?? 0),
      resend,
      refused,
    };
  } catch {
    return null;
  }
}

/**
 * The figures to show: Resend's own where they are from today (or this month),
 * the shop's count otherwise. Resend's counts everything on the account; the
 * shop's counts only what the shop sent, so the larger of the two is the safer
 * thing to measure the limit against.
 */
export function usedAgainstLimits(u: EmailUsage): { today: number; month: number; source: 'resend' | 'shop' } {
  const now = new Date().toISOString();
  const fresh = u.resend && new Date(u.resend.at * 1000).toISOString().slice(0, 10) === now.slice(0, 10);
  const freshMonth = u.resend && new Date(u.resend.at * 1000).toISOString().slice(0, 7) === now.slice(0, 7);
  const today = Math.max(u.sentToday, fresh ? (u.resend?.daily ?? 0) : 0);
  const month = Math.max(u.sentThisMonth, freshMonth ? (u.resend?.monthly ?? 0) : 0);
  return {
    today,
    month,
    source: (fresh && (u.resend?.daily ?? 0) >= u.sentToday) || (freshMonth && (u.resend?.monthly ?? 0) >= u.sentThisMonth) ? 'resend' : 'shop',
  };
}
