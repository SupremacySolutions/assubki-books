/**
 * Pre-orders: books the owner is thinking of buying, and who would take one.
 *
 * The point of the whole feature is one number per title - how many copies
 * people have said they want - so the owner can size an order by it rather
 * than by a guess. Everything here serves that number or the promise made to
 * the people behind it.
 *
 * Registering interest is not an order. Nothing is reserved, nothing is owed,
 * and nobody is told their copy is secured; the public page says so in as many
 * words. When the books come in they go through a shipment or a listing like
 * any other, and the names here are who the owner writes to first.
 *
 * Kept away from `books` on purpose - see 0049 for why.
 */

import { env } from 'cloudflare:workers';
import {
  esc,
  mdLink,
  postToChannel,
  editChannelPost,
  deleteChannelMessage,
  type ChannelText,
} from './telegram';
import { imageUrl, price, stripTags, truncate } from './format';
import { IMAGE_PRESETS, isPreset } from './image-presets';

export type PreorderStatus = 'draft' | 'open' | 'closed';

export interface Preorder {
  id: number;
  title: string;
  title_ar: string | null;
  title_ur: string | null;
  author: string | null;
  publisher: string | null;
  volumes: number | null;
  isbn: string | null;
  description_html: string | null;
  price_pence: number | null;
  status: PreorderStatus;
  image_key: string | null;
  image_width: number | null;
  image_height: number | null;
  telegram_message_id: number | null;
  telegram_posted_at: number | null;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
}

/** A pre-order with the totals the owner sizes the order by. */
export interface PreorderWithDemand extends Preorder {
  /** People who registered. */
  people: number;
  /** Copies they asked for between them - the number that matters. */
  copies: number;
}

export interface Interest {
  id: number;
  name: string;
  email: string;
  copies: number;
  at: number;
  updated_at: number | null;
}

/** More than a madrasah ordering for a class, few enough to mean something. */
export const MAX_COPIES = 50;

/**
 * How many open registrations one address may hold across every pre-order.
 *
 * Bounded by what the owner has put up, so it is not the spam surface free
 * text is; this only stops one mailbox filling every list.
 */
const PER_EMAIL = 30;

/** How long names are kept once a pre-order closes. Stated on the privacy page. */
export const KEEP_DAYS_AFTER_CLOSE = 90;

const DEMAND = `
  (SELECT COUNT(*) FROM preorder_interest i WHERE i.preorder_id = p.id) AS people,
  (SELECT COALESCE(SUM(i.copies), 0) FROM preorder_interest i WHERE i.preorder_id = p.id) AS copies`;

/** Every pre-order, open first, for the portal. */
export async function listPreorders(): Promise<PreorderWithDemand[]> {
  const { results } = await env.DB.prepare(
    `SELECT p.*, ${DEMAND} FROM preorders p
      ORDER BY CASE p.status WHEN 'open' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END,
               p.created_at DESC`,
  ).all<PreorderWithDemand>();
  return results;
}

/**
 * What customers can register for. Open ones only, newest first.
 *
 * One small read with no totals: what other people asked for is the owner's
 * business, not a scoreboard for the page.
 */
export async function openPreorders(): Promise<Preorder[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM preorders WHERE status = 'open' ORDER BY created_at DESC LIMIT 100`,
  ).all<Preorder>();
  return results;
}

export async function getPreorder(id: number): Promise<PreorderWithDemand | null> {
  return env.DB.prepare(`SELECT p.*, ${DEMAND} FROM preorders p WHERE p.id = ?`)
    .bind(id)
    .first<PreorderWithDemand>();
}

/** Biggest asks first: those are the people whose answer moves the order. */
export async function interestFor(preorderId: number): Promise<Interest[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, name, email, copies, at, updated_at FROM preorder_interest
      WHERE preorder_id = ? ORDER BY copies DESC, at ASC`,
  )
    .bind(preorderId)
    .all<Interest>();
  return results;
}

export type InterestResult = 'added' | 'updated' | 'closed' | 'toomany' | 'bad' | 'busy';

/** What the page says back after each answer. One set of words, here. */
export const INTEREST_WORDS: Record<InterestResult, string> = {
  added: 'Thank you - you are on the list. We will write to you if we bring this book in.',
  updated: 'Thank you - we have changed your number to what you just entered.',
  closed: 'Sorry, we are no longer taking interest in this book.',
  toomany: 'That address is already registered for a lot of books. Message us and we will sort it out.',
  bad: 'Please enter your name, a working email address and a number of copies between 1 and 50.',
  busy: 'Too many attempts from here just now. Please try again in a little while.',
};

/**
 * A customer saying how many copies they would take.
 *
 * Asking again with the same address changes the number rather than adding a
 * line - the last thing somebody said is what they want, and counting both
 * would size the order on a figure nobody gave.
 *
 * The status is checked inside the write, not before it, so a pre-order closed
 * between the page loading and the button being pressed takes nothing.
 */
export async function registerInterest(
  preorderId: number,
  rawName: string,
  rawEmail: string,
  rawCopies: string,
): Promise<InterestResult> {
  const name = rawName.trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 120) return 'bad';

  const email = rawEmail.trim().toLowerCase();
  // Deliberately loose, like `askForTitle`: an address to write back to, not
  // an identity to verify.
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email) || email.length > 160) return 'bad';

  const copies = Number(rawCopies);
  if (!Number.isInteger(copies) || copies < 1 || copies > MAX_COPIES) return 'bad';

  const [held, existing] = await env.DB.batch<{ n: number }>([
    env.DB.prepare('SELECT COUNT(*) AS n FROM preorder_interest WHERE email = ?').bind(email),
    env.DB.prepare('SELECT COUNT(*) AS n FROM preorder_interest WHERE preorder_id = ? AND email = ?')
      .bind(preorderId, email),
  ]);
  const already = (existing.results[0]?.n ?? 0) > 0;
  if (!already && (held.results[0]?.n ?? 0) >= PER_EMAIL) return 'toomany';

  const done = await env.DB.prepare(
    `INSERT INTO preorder_interest (preorder_id, name, email, copies)
     SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM preorders WHERE id = ?1 AND status = 'open')
     ON CONFLICT (preorder_id, email)
     DO UPDATE SET name = excluded.name, copies = excluded.copies, updated_at = unixepoch()`,
  )
    .bind(preorderId, name, email, copies)
    .run();

  if (!done.meta.changes) return 'closed';
  return already ? 'updated' : 'added';
}

/** Taking one person off a list - they asked, or it was a test. */
export async function deleteInterest(id: number): Promise<number | null> {
  const row = await env.DB.prepare('DELETE FROM preorder_interest WHERE id = ? RETURNING preorder_id')
    .bind(id)
    .first<{ preorder_id: number }>();
  return row?.preorder_id ?? null;
}

/**
 * Forgets the names on pre-orders that closed long enough ago.
 *
 * The backstop that makes the privacy page true when the owner never gets
 * round to deleting a finished pre-order. Run by the same sweep as
 * `pruneRequests`.
 */
export async function prunePreorderInterest(
  db: D1Database,
  days = KEEP_DAYS_AFTER_CLOSE,
): Promise<number> {
  const done = await db
    .prepare(
      `DELETE FROM preorder_interest WHERE preorder_id IN (
         SELECT id FROM preorders
          WHERE status = 'closed' AND closed_at IS NOT NULL
            AND closed_at < unixepoch() - ?1 * 86400)`,
    )
    .bind(days)
    .run();
  return done.meta.changes ?? 0;
}

// ---------------------------------------------------------------------------
// The cover
// ---------------------------------------------------------------------------

interface UploadEnv {
  UPLOADS?: R2Bucket;
}

const bucket = () => (env as unknown as UploadEnv).UPLOADS;

const MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
]);

export type CoverResult =
  | { ok: true; key: string; width: number | null; height: number | null }
  | { ok: false; why: 'storage' | 'size' | 'type' };

/**
 * Stores a cover sent with the pre-order form, and the sized versions the
 * browser cut from it.
 *
 * The same rules as `api/admin/upload.ts`, because it is the same photo
 * pipeline: a random suffix so a replacement never lands on a URL somebody
 * has cached for a year, and variants accepted only under a preset name the
 * table knows, so this cannot write arbitrary keys into the bucket. A variant
 * that fails to store is passed over - `/img` falls back to the original.
 */
export async function storeCover(preorderId: number, form: FormData): Promise<CoverResult | null> {
  const file = form.get('photo');
  if (!(file instanceof File) || file.size === 0) return null;

  const store = bucket();
  if (!store) return { ok: false, why: 'storage' };
  if (file.size > MAX_BYTES) return { ok: false, why: 'size' };
  const ext = ALLOWED.get(file.type);
  if (!ext) return { ok: false, why: 'type' };

  const key = `uploads/preorders/${preorderId}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
  const immutable = 'public, max-age=31536000, immutable';
  await store.put(key, file.stream(), {
    httpMetadata: { contentType: file.type, cacheControl: immutable },
  });

  const stem = key.replace(/\.[a-z0-9]+$/i, '');
  await Promise.all(
    [...form.entries()].map(async ([field, value]) => {
      if (!field.startsWith('variant:') || !(value instanceof File)) return;
      const preset = field.slice('variant:'.length);
      if (!isPreset(preset) || value.type !== 'image/webp' || value.size > MAX_BYTES) return;
      await store
        .put(`${stem}-${preset}.webp`, value.stream(), {
          httpMetadata: { contentType: 'image/webp', cacheControl: immutable },
        })
        .catch(() => undefined);
    }),
  );

  // Hints from the browser, bounded and dropped if not sane - as upload.ts.
  const dimension = (name: string): number | null => {
    const value = Number.parseInt(String(form.get(name) ?? ''), 10);
    return Number.isInteger(value) && value > 0 && value <= 20000 ? value : null;
  };
  return { ok: true, key, width: dimension('width'), height: dimension('height') };
}

/** Removes a cover and its sized versions from the bucket. Never throws. */
export async function deleteCover(key: string | null): Promise<void> {
  const store = bucket();
  if (!key || !store) return;
  const stem = key.replace(/\.[a-z0-9]+$/i, '');
  await store
    .delete([key, ...Object.keys(IMAGE_PRESETS).map((preset) => `${stem}-${preset}.webp`)])
    .catch((err) => console.error('[preorders] R2 delete failed', err));
}

// ---------------------------------------------------------------------------
// The channel
// ---------------------------------------------------------------------------

/** Where the post's link lands: the pre-order's own card on the public page. */
export const preorderUrl = (origin: string, id: number) => `${origin}/preorders#p${id}`;

/**
 * The announcement, in the same shape as a listing's so the channel reads as
 * one shop: bold title, the native title under it, a line of description, the
 * price, and a worded link.
 *
 * "Pre-order" leads the title, because the first thing somebody scrolling the
 * channel has to understand is that this is not on the shelf.
 */
export function preorderCaption(p: Preorder, origin: string): ChannelText {
  const lines = [`*${esc(`Pre-order: ${p.title}`)}*`];
  const native = p.title_ar || p.title_ur;
  if (native) lines.push(esc(native));
  if (p.author) lines.push(esc(p.author));
  if (p.volumes && p.volumes > 1) lines.push(esc(`${p.volumes} volume set`));
  lines.push('');

  const blurb = truncate(stripTags(p.description_html), 180);
  if (blurb) lines.push(esc(blurb), '');

  if (p.status === 'open') {
    lines.push(
      p.price_pence !== null
        ? `*${esc(`Expected price ${price(p.price_pence)}`)}*`
        : esc('Price to be confirmed'),
    );
    lines.push(esc('Tell us how many copies you would like, so we know how many to order.'));
    lines.push('', mdLink('Register interest', preorderUrl(origin, p.id)));
  } else {
    // A post is kept honest after the list closes, exactly as a listing's is
    // when it sells out - the link stays, the invitation does not.
    lines.push(esc('Pre-orders for this book are now closed.'));
  }
  return { text: lines.join('\n'), parse: 'MarkdownV2' };
}

export type PreorderPostResult = 'posted' | 'updated' | 'failed' | 'not-open';

/**
 * Posts the pre-order to the channel, or brings an existing post up to date.
 *
 * Only an open pre-order is announced: a draft would send the channel to a
 * card the page does not show. An existing post is edited whatever the status,
 * so closing a pre-order can take the invitation off the post.
 */
export async function publishPreorder(id: number, origin: string): Promise<PreorderPostResult> {
  const p = await getPreorder(id);
  if (!p) return 'failed';

  const caption = preorderCaption(p, origin);
  if (p.telegram_message_id) {
    return (await editChannelPost(p.telegram_message_id, caption)) ? 'updated' : 'failed';
  }
  if (p.status !== 'open') return 'not-open';

  // `social`, the square variant, because that is the shape Telegram crops to.
  const photo = p.image_key ? imageUrl(p.image_key, 'social') : null;
  const posted = await postToChannel(caption, photo ? [`${origin}${photo}`] : []);
  if (!posted) return 'failed';

  await env.DB.prepare(
    'UPDATE preorders SET telegram_message_id = ?, telegram_posted_at = unixepoch() WHERE id = ?',
  )
    .bind(posted.messageId, id)
    .run();
  return 'posted';
}

/**
 * Keeps an existing post in step after a save, and never posts a new one.
 *
 * Posting is the owner's decision; correcting a post they already made is not
 * a decision at all. Never throws - a save must not fail on the channel.
 */
export async function syncPreorderPost(id: number, origin: string): Promise<void> {
  try {
    const p = await getPreorder(id);
    if (p?.telegram_message_id) await editChannelPost(p.telegram_message_id, preorderCaption(p, origin));
  } catch (err) {
    console.error('[preorders] could not update the channel post', err);
  }
}

/** Takes the post down. False when Telegram refused - older than 48 hours, say. */
export async function unpostPreorder(messageId: number): Promise<boolean> {
  return deleteChannelMessage(messageId);
}
