import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const prerender = false;

const MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
]);

interface UploadEnv {
  UPLOADS?: R2Bucket;
}

/**
 * Photos the owner adds go to R2 under `uploads/`. The migrated covers live
 * under `books/` as immutable static assets — the prefix is what decides where
 * `/img/<key>` reads from, so the two can never collide.
 */
export const POST: APIRoute = async ({ request }) => {
  const bucket = (env as unknown as UploadEnv).UPLOADS;
  if (!bucket) return new Response('Photo storage is not configured.', { status: 503 });

  const form = await request.formData();
  const bookId = Number.parseInt(String(form.get('bookId') ?? ''), 10);
  const file = form.get('photo');

  if (!Number.isInteger(bookId)) return new Response('Missing book', { status: 400 });
  if (!(file instanceof File)) return new Response('No photo supplied', { status: 400 });
  if (file.size > MAX_BYTES) return new Response('That photo is larger than 8 MB', { status: 413 });

  const ext = ALLOWED.get(file.type);
  if (!ext) return new Response('Use a JPEG, PNG or WebP', { status: 415 });

  const book = await env.DB.prepare('SELECT slug FROM books WHERE id = ?')
    .bind(bookId)
    .first<{ slug: string }>();
  if (!book) return new Response('No such book', { status: 404 });

  // Random suffix so re-uploading never overwrites a cached image at the same
  // URL — R2 objects are served with a long cache lifetime.
  const rand = crypto.randomUUID().slice(0, 8);
  const key = `uploads/${book.slug}/${Date.now()}-${rand}.${ext}`;

  await bucket.put(key, file.stream(), {
    httpMetadata: { contentType: file.type, cacheControl: 'public, max-age=31536000, immutable' },
  });

  const nextSort = await env.DB.prepare(
    'SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM book_images WHERE book_id = ?',
  )
    .bind(bookId)
    .first<{ n: number }>();

  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO book_images (book_id, image_key, alt, sort) VALUES (?, ?, ?, ?)',
    ).bind(bookId, key, null, nextSort?.n ?? 0),
    env.DB.prepare('UPDATE books SET updated_at = unixepoch() WHERE id = ?').bind(bookId),
  ]);

  return Response.json({ ok: true, key });
};

export const DELETE: APIRoute = async ({ request }) => {
  const bucket = (env as unknown as UploadEnv).UPLOADS;
  const form = await request.formData();
  const imageId = Number.parseInt(String(form.get('imageId') ?? ''), 10);
  if (!Number.isInteger(imageId)) return new Response('Missing image', { status: 400 });

  const image = await env.DB.prepare('SELECT image_key, book_id FROM book_images WHERE id = ?')
    .bind(imageId)
    .first<{ image_key: string; book_id: number }>();
  if (!image) return new Response('No such photo', { status: 404 });

  await env.DB.prepare('DELETE FROM book_images WHERE id = ?').bind(imageId).run();

  // Only uploads live in R2. A `books/` key is a static asset shipped with the
  // deploy, so removing the row is all that can be done — and all that should
  // be: the file is version-controlled.
  if (bucket && image.image_key.startsWith('uploads/')) {
    await bucket.delete(image.image_key).catch((err) => console.error('[upload] R2 delete failed', err));
  }

  return Response.json({ ok: true });
};
