/**
 * Admin authentication.
 *
 * Cloudflare Access sits in front of /admin and puts a signed JWT on every
 * request in `Cf-Access-Jwt-Assertion`. **The presence of that header proves
 * nothing** — anyone can send a header. It has to be verified against the
 * team's published signing keys, and its audience checked against this
 * application's tag, or the whole thing is decoration.
 *
 * Before Access is configured in the dashboard there is an interim path: a
 * shared secret in `ADMIN_PASSWORD`, exchanged for a signed session cookie.
 * It is deliberately only active while `ACCESS_AUD` is unset, so switching
 * Access on retires it automatically rather than leaving a second way in.
 */

import { env } from 'cloudflare:workers';

interface AuthEnv {
  ACCESS_TEAM_DOMAIN?: string; // e.g. "supremacy.cloudflareaccess.com"
  ACCESS_AUD?: string; // Application Audience tag from the Access app
  ADMIN_PASSWORD?: string; // interim, pre-Access
  ADMIN_SESSION_SECRET?: string; // signs the interim cookie
}

const cfg = () => env as unknown as AuthEnv;

export const SESSION_COOKIE = 'asb_admin';
const SESSION_TTL_SECONDS = 60 * 60 * 12;

export interface AdminIdentity {
  email: string;
  via: 'access' | 'password';
}

// ---------------------------------------------------------------------------
// Cloudflare Access JWT
// ---------------------------------------------------------------------------

const b64urlToBytes = (s: string): Uint8Array => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}

let keyCache: { keys: Jwk[]; at: number } | null = null;

async function fetchKeys(teamDomain: string): Promise<Jwk[]> {
  // Cached briefly: Access rotates keys, so this cannot be cached forever, but
  // refetching on every admin request would add a round trip to each page.
  if (keyCache && Date.now() - keyCache.at < 3_600_000) return keyCache.keys;

  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs fetch failed: ${res.status}`);
  const { keys } = (await res.json()) as { keys: Jwk[] };
  keyCache = { keys, at: Date.now() };
  return keys;
}

async function verifyAccessJwt(token: string): Promise<AdminIdentity | null> {
  const { ACCESS_TEAM_DOMAIN, ACCESS_AUD } = cfg();
  if (!ACCESS_TEAM_DOMAIN || !ACCESS_AUD) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;

  let header: { kid?: string; alg?: string };
  let payload: { aud?: string | string[]; email?: string; exp?: number; iss?: string };
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(headerB64)));
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadB64)));
  } catch {
    return null;
  }

  // Only RS256. Accepting "none" or an HMAC alg here is the classic JWT forgery.
  if (header.alg !== 'RS256' || !header.kid) return null;

  const keys = await fetchKeys(ACCESS_TEAM_DOMAIN);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlToBytes(signatureB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`),
  );
  if (!valid) return null;

  // A valid signature from the right team is not enough: without the audience
  // check, a token minted for any *other* Access app on the same team would be
  // accepted here.
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(ACCESS_AUD)) return null;

  if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
  if (payload.iss && payload.iss !== `https://${ACCESS_TEAM_DOMAIN}`) return null;
  if (!payload.email) return null;

  return { email: payload.email, via: 'access' };
}

// ---------------------------------------------------------------------------
// Interim password session
// ---------------------------------------------------------------------------

const sessionKey = async (): Promise<CryptoKey> => {
  const secret = cfg().ADMIN_SESSION_SECRET ?? cfg().ADMIN_PASSWORD ?? '';
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
};

const toHex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function createSessionCookie(): Promise<string> {
  const expires = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const sig = await crypto.subtle.sign(
    'HMAC',
    await sessionKey(),
    new TextEncoder().encode(String(expires)),
  );
  return `${expires}.${toHex(sig)}`;
}

async function verifySessionCookie(value: string): Promise<boolean> {
  const [expiresRaw, sig] = value.split('.');
  const expires = Number.parseInt(expiresRaw ?? '', 10);
  if (!Number.isFinite(expires) || expires * 1000 < Date.now() || !sig) return false;

  const expected = toHex(
    await crypto.subtle.sign('HMAC', await sessionKey(), new TextEncoder().encode(expiresRaw)),
  );
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

/** True while the interim path is live — i.e. Access is not yet configured. */
export function passwordFallbackActive(): boolean {
  return !cfg().ACCESS_AUD && Boolean(cfg().ADMIN_PASSWORD);
}

export async function checkPassword(candidate: string): Promise<boolean> {
  const expected = cfg().ADMIN_PASSWORD;
  if (!expected || !passwordFallbackActive()) return false;

  const a = new TextEncoder().encode(expected);
  const b = new TextEncoder().encode(candidate);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function authenticate(request: Request): Promise<AdminIdentity | null> {
  const jwt =
    request.headers.get('Cf-Access-Jwt-Assertion') ??
    readCookie(request, 'CF_Authorization');

  if (jwt) {
    try {
      const identity = await verifyAccessJwt(jwt);
      if (identity) return identity;
    } catch (err) {
      console.error('[admin-auth] Access verification failed', err);
    }
  }

  if (passwordFallbackActive()) {
    const session = readCookie(request, SESSION_COOKIE);
    if (session && (await verifySessionCookie(session))) {
      return { email: 'owner (shared password)', via: 'password' };
    }
  }

  return null;
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

/** No admin auth of any kind is configured — the portal must stay shut. */
export function adminLocked(): boolean {
  return !cfg().ACCESS_AUD && !cfg().ADMIN_PASSWORD;
}
