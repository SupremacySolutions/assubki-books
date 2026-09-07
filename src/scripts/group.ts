/**
 * Which group basket this browser is part of, if any.
 *
 * Kept beside the ordinary basket rather than replacing it: someone in a class
 * order may still have their own books waiting, and losing those on joining
 * would be a poor trade for a shared list.
 */

const KEY = 'asb.group.v1';

export interface Membership {
  code: string;
  /** Whichever key this browser holds. The server says what it is worth. */
  token: string;
  name: string;
  /** Last known answer to that, so the page can paint before it asks. */
  organiser: boolean;
  /** Organisers only: the other key, the one that goes in the shared link. */
  shareToken?: string;
}

export function readGroup(): Membership | null {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (!raw || typeof raw !== 'object') return null;
    const { code, token, name, organiser, shareToken } = raw as Record<string, unknown>;
    if (typeof code !== 'string' || typeof token !== 'string' || typeof name !== 'string') return null;
    return {
      code,
      token,
      name,
      organiser: Boolean(organiser),
      shareToken: typeof shareToken === 'string' ? shareToken : undefined,
    };
  } catch {
    return null;
  }
}

export function joinGroup(member: Membership): void {
  localStorage.setItem(KEY, JSON.stringify(member));
}

export function leaveGroup(): void {
  localStorage.removeItem(KEY);
}

/**
 * The link that puts someone else in the same basket.
 *
 * An organiser must hand out the *share* key, never their own: theirs sends the
 * order. When we do not have a share key we are not an organiser, so the key we
 * hold is the shared one.
 */
export function shareLink(member: Pick<Membership, 'code' | 'token' | 'shareToken'>): string {
  const key = member.shareToken ?? member.token;
  return `${location.origin}/basket?g=${encodeURIComponent(member.code)}&k=${encodeURIComponent(key)}`;
}

/** The organiser's own link, the one worth keeping. */
export function ownerLink(member: Pick<Membership, 'code' | 'token'>): string {
  return `${location.origin}/basket?g=${encodeURIComponent(member.code)}&k=${encodeURIComponent(member.token)}`;
}

/** Pulls the code and token back out of a pasted link, or a pasted code. */
export function parseShare(input: string): { code: string; token: string } | null {
  const text = input.trim();
  try {
    const url = new URL(text);
    const code = url.searchParams.get('g') ?? '';
    const token = url.searchParams.get('k') ?? '';
    return code && token ? { code, token } : null;
  } catch {
    // Not a URL: accept "GRP-XXXXX token" for anyone retyping from a message.
    const [code, token] = text.split(/\s+/);
    return code && token ? { code, token } : null;
  }
}

/**
 * Somebody else's words, made safe to put in HTML.
 *
 * A group basket is the one place in the shop where text one customer typed is
 * rendered on another customer's screen: the organiser and every member see
 * "Added by <name>" for lines they did not add. Both the basket and the
 * checkout summary build those rows as HTML strings, so a name containing
 * markup arrived as markup - stored injection inside an invited group.
 *
 * The site's CSP allows scripts only from itself with a nonce, so the obvious
 * inline payload does not execute. That is a mitigation, not a reason to
 * interpolate a stranger's text into a template: it stops a script tag, not a
 * link, an image with an onerror-free side effect, or a name that rewrites the
 * page around it.
 *
 * Named for what it is rather than dressed up as a formatter, so a future
 * caller does not mistake it for optional.
 */
export function escapeHtml(text: string): string {
  return String(text).replace(
    /[&<>"']/g,
    (ch) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch,
  );
}
