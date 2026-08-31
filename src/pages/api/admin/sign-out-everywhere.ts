import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { forgetSessionEpoch, SESSION_COOKIE } from '../../../lib/admin-auth';

export const prerender = false;

/**
 * Ends every portal session, including this one.
 *
 * The session cookie signs only its expiry, so until now a stolen one was good
 * for its full twelve hours and nothing could stop it - not even changing the
 * password, since the cookie is signed with a different secret. Raising the
 * epoch changes the signing key, so every cookie in existence stops verifying.
 *
 * For the case where the owner thinks a laptop was left signed in somewhere,
 * or the password has been shared and needs taking back.
 */
export const POST: APIRoute = async ({ url }) => {
  await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES ('session_epoch', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  )
    .bind(String(Date.now()))
    .run();

  forgetSessionEpoch();

  // Their own cookie is cleared too, so the next page is the sign-in screen
  // rather than a redirect loop against a cookie that no longer verifies.
  const secure = url.protocol === 'https:' ? ' Secure;' : '';
  return new Response(null, {
    status: 302,
    headers: {
      Location: '/admin/login?e=signedout',
      'Set-Cookie': `${SESSION_COOKIE}=; Path=/;${secure} HttpOnly; SameSite=Lax; Max-Age=0`,
    },
  });
};
