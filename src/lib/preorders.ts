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
  deleteChannelPost,
  type ChannelText,
} from './telegram';
import { freeSlug, isSlug, slugify } from './slug';
import { imageUrl, price, stripTags, truncate } from './format';
import { IMAGE_PRESETS, isPreset, presetSuffix, presetType, type PresetName } from './image-presets';

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
  /** Its own address. Null only until `ensurePreorderSlugs` has run. */
  slug: string | null;
  /** The cover - a copy of photo 0 in `preorder_images`, kept in step. */
  image_key: string | null;
  image_width: number | null;
  image_height: number | null;
  telegram_message_id: number | null;
  /** Every message of an album post, as JSON. Null for a single photo. */
  telegram_album_ids: string | null;
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

/**
 * A pre-order by its address, for its own page: open, or closed - a channel
 * post keeps its link after the list closes, and should land on a page that
 * says so rather than on a 404. Never a draft. No totals: see above.
 */
export async function publicPreorderBySlug(slug: string): Promise<Preorder | null> {
  if (!isSlug(slug)) return null;
  return env.DB.prepare(`SELECT * FROM preorders WHERE slug = ? AND status IN ('open','closed')`)
    .bind(slug)
    .first<Preorder>();
}

// ---------------------------------------------------------------------------
// The address
// ---------------------------------------------------------------------------

/** A free address for this pre-order, from `wanted` (usually its title). */
export async function freePreorderSlug(id: number, wanted: string): Promise<string> {
  return freeSlug(slugify(wanted), `preorder-${id}`, async (candidate) =>
    Boolean(
      await env.DB.prepare('SELECT 1 FROM preorders WHERE slug = ? AND id != ?')
        .bind(candidate, id)
        .first(),
    ),
  );
}

/**
 * Gives an address to a pre-order that has none, or a draft whose title has
 * moved. Once it is open the address is fixed: it is in the channel and in
 * people's chats by then, and a renamed title must not break those links.
 */
export async function settlePreorderSlug(id: number): Promise<void> {
  const row = await env.DB.prepare('SELECT title, slug, status FROM preorders WHERE id = ?')
    .bind(id)
    .first<{ title: string; slug: string | null; status: PreorderStatus }>();
  if (!row || (row.slug && row.status !== 'draft')) return;
  const slug = await freePreorderSlug(id, row.title);
  if (slug !== row.slug) {
    await env.DB.prepare('UPDATE preorders SET slug = ? WHERE id = ?').bind(slug, id).run();
  }
}

/**
 * Fills the address of every pre-order made before they had one. One small
 * read when there is nothing to do; a write per pre-order, once.
 */
export async function ensurePreorderSlugs(): Promise<void> {
  const { results } = await env.DB.prepare('SELECT id FROM preorders WHERE slug IS NULL')
    .all<{ id: number }>();
  for (const row of results) await settlePreorderSlug(row.id);
}

/** Where a pre-order lives. Its card on the list until it has an address. */
export const preorderPath = (p: { id: number; slug: string | null }): string =>
  p.slug ? `/preorders/${p.slug}` : `/preorders#p${p.id}`;

// ---------------------------------------------------------------------------
// The photos
// ---------------------------------------------------------------------------

export interface PreorderPhoto {
  id: number;
  preorder_id: number;
  image_key: string;
  width: number | null;
  height: number | null;
  sort: number;
}

/** The set, the spines, the inside pages. Enough to judge an edition by. */
export const MAX_PHOTOS = 8;

/**
 * Copies photo 0 onto the pre-order row, which is what everything showing a
 * single picture reads. Run in the same batch as every change to the photos.
 */
const MIRROR_COVER = `
  UPDATE preorders SET
    image_key    = (SELECT image_key FROM preorder_images WHERE preorder_id = ?1 ORDER BY sort, id LIMIT 1),
    image_width  = (SELECT width     FROM preorder_images WHERE preorder_id = ?1 ORDER BY sort, id LIMIT 1),
    image_height = (SELECT height    FROM preorder_images WHERE preorder_id = ?1 ORDER BY sort, id LIMIT 1),
    updated_at   = unixepoch()
  WHERE id = ?1`;

/** Back to 0, 1, 2… with no gaps, keeping the order they are in. */
const RENUMBER = `
  UPDATE preorder_images SET sort = (
    SELECT COUNT(*) FROM preorder_images x
     WHERE x.preorder_id = preorder_images.preorder_id
       AND (x.sort < preorder_images.sort OR (x.sort = preorder_images.sort AND x.id < preorder_images.id)))
  WHERE preorder_id = ?1`;

export async function preorderPhotos(preorderId: number): Promise<PreorderPhoto[]> {
  const { results } = await env.DB.prepare(
    'SELECT * FROM preorder_images WHERE preorder_id = ? ORDER BY sort, id',
  )
    .bind(preorderId)
    .all<PreorderPhoto>();
  return results;
}

/** Every photo of several pre-orders in one read, for the list page. */
export async function photosFor(ids: number[]): Promise<Map<number, PreorderPhoto[]>> {
  const out = new Map<number, PreorderPhoto[]>();
  if (!ids.length) return out;
  const { results } = await env.DB.prepare(
    `SELECT * FROM preorder_images
      WHERE preorder_id IN (SELECT value FROM json_each(?))
      ORDER BY preorder_id, sort, id`,
  )
    .bind(JSON.stringify(ids))
    .all<PreorderPhoto>();
  for (const photo of results) {
    const list = out.get(photo.preorder_id) ?? [];
    list.push(photo);
    out.set(photo.preorder_id, list);
  }
  return out;
}

/**
 * Adds a stored photo at the end. The first one a pre-order gets is its cover.
 *
 * The ceiling is checked inside the insert, so two uploads racing past a full
 * set cannot both land. False when the set was full; the caller then removes
 * the files it stored.
 */
export async function addPreorderPhoto(
  preorderId: number,
  photo: { key: string; width: number | null; height: number | null },
): Promise<boolean> {
  const [added] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO preorder_images (preorder_id, image_key, width, height, sort)
       SELECT ?1, ?2, ?3, ?4, COALESCE(MAX(sort) + 1, 0) FROM preorder_images WHERE preorder_id = ?1
       HAVING COUNT(*) < ?5`,
    ).bind(preorderId, photo.key, photo.width, photo.height, MAX_PHOTOS),
    env.DB.prepare(MIRROR_COVER).bind(preorderId),
  ]);
  return Boolean(added.meta.changes);
}

/** Removes one photo, files and all. The next one along becomes the cover. */
export async function deletePreorderPhoto(preorderId: number, photoId: number): Promise<boolean> {
  const [gone] = await env.DB.batch<{ image_key: string }>([
    env.DB.prepare('DELETE FROM preorder_images WHERE id = ?2 AND preorder_id = ?1 RETURNING image_key')
      .bind(preorderId, photoId),
    env.DB.prepare(RENUMBER).bind(preorderId),
    env.DB.prepare(MIRROR_COVER).bind(preorderId),
  ]);
  const key = gone.results[0]?.image_key;
  if (!key) return false;
  await deleteCover(key);
  return true;
}

/**
 * Puts a pre-order's photos in the order given, the first being the cover.
 *
 * Every photo it has, or nothing - the same rule as a listing's photos, for
 * the same reason: a list that leaves one out, repeats one or names another
 * pre-order's was made against a page that is out of date, and guessing what
 * it meant would be wrong as often as right.
 */
export async function reorderPreorderPhotos(preorderId: number, order: number[]): Promise<'ok' | 'stale'> {
  const held = new Set((await preorderPhotos(preorderId)).map((p) => p.id));
  if (
    !order.length ||
    new Set(order).size !== order.length ||
    held.size !== order.length ||
    order.some((n) => !held.has(n))
  ) {
    return 'stale';
  }
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE preorder_images
          SET sort = (SELECT CAST(j.key AS INTEGER) FROM json_each(?1) j WHERE j.value = preorder_images.id)
        WHERE preorder_id = ?2`,
    ).bind(JSON.stringify(order), preorderId),
    env.DB.prepare(MIRROR_COVER).bind(preorderId),
  ]);
  return 'ok';
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
      if (!isPreset(preset) || value.type !== presetType(preset) || value.size > MAX_BYTES) return;
      await store
        .put(`${stem}${presetSuffix(preset)}`, value.stream(), {
          httpMetadata: { contentType: presetType(preset), cacheControl: immutable },
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
    .delete([key, ...(Object.keys(IMAGE_PRESETS) as PresetName[]).map((preset) => `${stem}${presetSuffix(preset)}`)])
    .catch((err) => console.error('[preorders] R2 delete failed', err));
}

// ---------------------------------------------------------------------------
// The channel
// ---------------------------------------------------------------------------

/** Where the post's link lands: the pre-order's own page. */
export const preorderUrl = (origin: string, p: { id: number; slug: string | null }) =>
  `${origin}${preorderPath(p)}`;

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
    lines.push('', mdLink('Register interest', preorderUrl(origin, p)));
  } else {
    // A post is kept honest after the list closes, exactly as a listing's is
    // when it sells out - the link stays, the invitation does not.
    lines.push(esc('Pre-orders for this book are now closed.'));
  }
  return { text: lines.join('\n'), parse: 'MarkdownV2' };
}

/**
 * The same post, written the way a person would type it.
 *
 * Not a rendering of the markdown one, for the reason `plainCaption` gives for
 * listings: MarkdownV2 escapes every full stop, so an expected price of £12.50
 * would reach the owner as `£12\.50`. This says the same facts in the same
 * order, so what the preview shows is what the channel gets - and it sits
 * directly beneath `preorderCaption` so the two are changed together.
 */
export function plainPreorderCaption(p: Preorder, origin: string): string {
  const lines = [`Pre-order: ${p.title}`];
  const native = p.title_ar || p.title_ur;
  if (native) lines.push(native);
  if (p.author) lines.push(p.author);
  if (p.volumes && p.volumes > 1) lines.push(`${p.volumes} volume set`);
  lines.push('');

  const blurb = truncate(stripTags(p.description_html), 180);
  if (blurb) lines.push(blurb, '');

  if (p.status === 'open') {
    lines.push(
      p.price_pence !== null ? `Expected price ${price(p.price_pence)}` : 'Price to be confirmed',
    );
    lines.push('Tell us how many copies you would like, so we know how many to order.');
    lines.push('', `Register interest - ${preorderUrl(origin, p)}`);
  } else {
    lines.push('Pre-orders for this book are now closed.');
  }
  return lines.join('\n');
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

  // Every photo, as an album, in the owner's order. `social`, the square
  // variant, because that is the shape Telegram crops to.
  const photos = (await preorderPhotos(id))
    .map((photo) => imageUrl(photo.image_key, 'social'))
    .filter((url): url is string => Boolean(url))
    .map((url) => `${origin}${url}`);
  const posted = await postToChannel(caption, photos);
  if (!posted) return 'failed';

  await env.DB.prepare(
    `UPDATE preorders SET telegram_message_id = ?, telegram_album_ids = ?, telegram_posted_at = unixepoch()
      WHERE id = ?`,
  )
    .bind(posted.messageId, posted.albumIds.length > 1 ? JSON.stringify(posted.albumIds) : null, id)
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

/**
 * Takes the post down - every photo of an album, not only the one carrying the
 * caption. False when Telegram refused - older than 48 hours, say.
 */
export async function unpostPreorder(messageId: number, albumIds: string | null = null): Promise<boolean> {
  let ids = [messageId];
  try {
    const album = albumIds ? (JSON.parse(albumIds) as unknown) : null;
    if (Array.isArray(album) && album.every((n) => Number.isInteger(n))) ids = album as number[];
  } catch {
    /* A damaged list still takes the captioned message down. */
  }
  return deleteChannelPost(ids);
}
