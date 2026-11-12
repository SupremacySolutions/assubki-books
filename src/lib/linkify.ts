/**
 * Links in a message, found without ever treating the message as markup.
 *
 * A conversation carries tracking pages, the shop's own book links and the odd
 * map pin, and as plain text every one of them had to be copied and pasted.
 * This splits a message into text and link pieces; the thread then builds each
 * piece as a text node or an `<a>`, so somebody else's words are never handed
 * to an HTML parser on either side.
 *
 * Shared by `Thread.astro` (server) and `scripts/thread.ts` (browser), so a
 * message reads the same whether it was on the page at load or arrived by the
 * poll. Nothing in here may import a Worker-only module.
 */

export type Piece = { text: string; href?: string };

/*
 * http(s) links, and bare `www.` addresses, which is how people paste them.
 * Deliberately not bare domains ("shop.co.uk"): "Vol.2" and "e.g." would
 * start turning into links.
 */
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

/** Punctuation a sentence puts after a link, which is not part of it. */
function trimTail(raw: string): string {
  let url = raw;
  for (;;) {
    const last = url.at(-1) ?? '';
    if (/[.,;:!?'"»”’]/.test(last)) {
      url = url.slice(0, -1);
      continue;
    }
    // A closing bracket belongs to the link only if the link opened one.
    if (last === ')' && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) {
      url = url.slice(0, -1);
      continue;
    }
    return url;
  }
}

/** Only addresses a browser can safely follow. */
function safeHref(url: string): string | null {
  const href = /^www\./i.test(url) ? `https://${url}` : url;
  try {
    const parsed = new URL(href);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

export function linkPieces(text: string): Piece[] {
  const found: { start: number; end: number; href: string }[] = [];

  for (const match of text.matchAll(URL_RE)) {
    const raw = trimTail(match[0]);
    const href = safeHref(raw);
    if (href) found.push({ start: match.index!, end: match.index! + raw.length, href });
  }
  for (const match of text.matchAll(EMAIL_RE)) {
    const start = match.index!;
    const end = start + match[0].length;
    // An address inside a link (a login in a URL) is part of that link.
    if (found.some((f) => start < f.end && end > f.start)) continue;
    found.push({ start, end, href: `mailto:${match[0]}` });
  }
  found.sort((a, b) => a.start - b.start);

  const pieces: Piece[] = [];
  let at = 0;
  for (const f of found) {
    if (f.start > at) pieces.push({ text: text.slice(at, f.start) });
    pieces.push({ text: text.slice(f.start, f.end), href: f.href });
    at = f.end;
  }
  if (at < text.length) pieces.push({ text: text.slice(at) });
  return pieces;
}

/** Whether a link leaves the site, so it opens in a new tab. */
export function isExternal(href: string, origin: string): boolean {
  if (href.startsWith('mailto:')) return false;
  try {
    return new URL(href).origin !== origin;
  } catch {
    return true;
  }
}
