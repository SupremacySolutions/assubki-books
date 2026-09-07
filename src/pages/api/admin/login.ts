import type { APIRoute } from 'astro';
import { checkPassword, createSessionCookie, SESSION_COOKIE } from '../../../lib/admin-auth';
import { callerAddress, checkThrottle, recordAttempt } from '../../../lib/login-throttle';

export const prerender = false;

export const POST: APIRoute = async ({ request, url }) => {
  const form = await request.formData();
  const password = String(form.get('password') ?? '');
  const nextRaw = String(form.get('next') ?? '/admin');

  /*
   * Only same-site paths, so a crafted `next` cannot bounce the owner to
   * another host after a successful sign-in.
   *
   * Checking the string for a leading slash was not enough. A browser
   * resolving `/\evil.invalid` normalises the backslash to a slash, so the
   * value passed a test looking for `//` and then became a protocol-relative
   * jump to somebody else's site - with the owner arriving there straight from
   * a successful login, which is exactly when they are least suspicious.
   *
   * Resolved against this origin instead, and only the path is kept. Anything
   * that lands on another origin, or will not parse at all, goes to /admin.
   */
  let next = '/admin';
  try {
    const target = new URL(nextRaw, url.origin);
    if (target.origin === url.origin) next = `${target.pathname}${target.search}${target.hash}`;
  } catch {
    /* unparseable: /admin, as above */
  }

  /*
   * Guessing is limited before the password is even looked at.
   *
   * Checked first so a locked-out address cannot keep exercising the
   * comparison, and so the answer costs the same whether the guess was close
   * or nonsense.
   */
  const ip = callerAddress(request);
  const throttle = await checkThrottle(ip);
  if (throttle.blocked) {
    return new Response(null, {
      status: 302,
      headers: {
        Location: `/admin/login?e=throttled&wait=${Math.ceil(throttle.retryAfter / 60)}&next=${encodeURIComponent(next)}`,
        'Retry-After': String(throttle.retryAfter),
      },
    });
  }

  const ok = await checkPassword(password);
  await recordAttempt(ip, ok);

  if (!ok) {
    return new Response(null, {
      status: 302,
      headers: { Location: `/admin/login?e=1&next=${encodeURIComponent(next)}` },
    });
  }

  const cookie = await createSessionCookie();
  const secure = url.protocol === 'https:' ? ' Secure;' : '';

  return new Response(null, {
    status: 302,
    headers: {
      Location: next,
      'Set-Cookie': `${SESSION_COOKIE}=${cookie}; Path=/;${secure} HttpOnly; SameSite=Lax; Max-Age=43200`,
    },
  });
};
