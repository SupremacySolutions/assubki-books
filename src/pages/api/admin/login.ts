import type { APIRoute } from 'astro';
import { checkPassword, createSessionCookie, SESSION_COOKIE } from '../../../lib/admin-auth';

export const prerender = false;

export const POST: APIRoute = async ({ request, url }) => {
  const form = await request.formData();
  const password = String(form.get('password') ?? '');
  const nextRaw = String(form.get('next') ?? '/admin');

  // Only same-site paths, so a crafted ?next= cannot bounce the owner to
  // another host after a successful sign-in.
  const next = nextRaw.startsWith('/') && !nextRaw.startsWith('//') ? nextRaw : '/admin';

  if (!(await checkPassword(password))) {
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
