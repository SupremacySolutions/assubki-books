import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const prerender = false;

const MAX_BYTES = 8 * 1024 * 1024;

interface UploadEnv {
  UPLOADS?: R2Bucket;
}

/**
 * Keeps a cut-out the owner says came out wrong.
 *
 * For diagnosis, not for training. Fine-tuning the model would need pairs of
 * photo and hand-painted correct mask, enough of them to generalise, and a GPU
 * - and with a handful it would overfit and get worse on covers it had not
 * seen. What these are actually for is telling the three suspects apart: the
 * edge handling, the thresholds in `checkMask`, or the model itself. Only one
 * of those is expensive to change.
 *
 * Both pictures are kept, because the interesting part is usually the
 * difference between them: the photo as it was chosen, and what came back.
 *
 * Behind the same session check as everything else under /api/admin - the
 * middleware guards the whole prefix, so there is nothing to remember here.
 */
export const POST: APIRoute = async ({ request }) => {
  const bucket = (env as unknown as UploadEnv).UPLOADS;
  if (!bucket) return new Response('Photo storage is not configured.', { status: 503 });

  const form = await request.formData();
  const original = form.get('original');
  const result = form.get('result');

  if (!(original instanceof File) || !(result instanceof File)) {
    return new Response('Both pictures are needed', { status: 400 });
  }
  if (original.size > MAX_BYTES || result.size > MAX_BYTES) {
    return new Response('That is larger than 8 MB', { status: 413 });
  }

  // Sortable, so the folder listing reads in the order they happened.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const id = `${stamp}-${crypto.randomUUID().slice(0, 8)}`;
  const prefix = `reports/${id}`;

  // Whatever the page knows about how it was made. Kept as the page sent it
  // rather than picked apart here: this is a note to read later, not something
  // the site acts on, and a field added in the browser should not need a
  // matching change on the server to survive.
  let note: unknown = {};
  try {
    note = JSON.parse(String(form.get('note') ?? '{}'));
  } catch {
    note = { unparsed: String(form.get('note') ?? '').slice(0, 2000) };
  }

  await Promise.all([
    bucket.put(`${prefix}/original.webp`, await original.arrayBuffer(), {
      httpMetadata: { contentType: original.type || 'image/webp' },
    }),
    bucket.put(`${prefix}/result.webp`, await result.arrayBuffer(), {
      httpMetadata: { contentType: result.type || 'image/webp' },
    }),
    bucket.put(
      `${prefix}/note.json`,
      JSON.stringify({ id, at: new Date().toISOString(), ...(note as object) }, null, 2),
      { httpMetadata: { contentType: 'application/json' } },
    ),
  ]);

  return new Response(JSON.stringify({ id }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
