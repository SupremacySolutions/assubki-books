// Read public production photos, write only local R2. No production binding or
// customer/order data is accessed. Stop the dev server before running this.
import { getPlatformProxy } from 'wrangler';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { IMAGE_PRESETS, IMAGE_VERSION } from '../src/lib/image-presets.ts';
const only = process.argv.find(a => a.startsWith('--only='))?.slice(7);
const check = process.argv.includes('--check');
const proxy = await getPlatformProxy({ configPath: 'wrangler.jsonc', remoteBindings: false });
try {
  const rows = await proxy.env.DB.prepare('SELECT DISTINCT image_key FROM book_images').all();
  const keys = rows.results.map(r => r.image_key).filter(k => /^(books|uploads)\//.test(k) && !k.includes('..') && (!only || k.includes(only)));
  // Two different failures, and blaming the wrong one costs an hour: an empty
  // catalogue needs migrations, whereas a filter that matched nothing is a
  // typo - or a key that only exists in production, since local D1 is seeded
  // from the migration rather than copied from the live shop.
  if (!keys.length) throw new Error(rows.results.length
    ? `No photo key contains ${JSON.stringify(only)}. Local D1 has ${rows.results.length}; it is seeded from migrations, so production-only keys are not here.`
    : 'No photos in local D1. Apply local migrations first.');
  const findings = [];
  const queue = keys.flatMap(key => ['', ...Object.keys(IMAGE_PRESETS)].map(preset => ({ key, preset })));
  const outcomes = await Promise.allSettled(Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const {key, preset} = queue.shift();
      const storedKey = preset ? `${key.replace(/\.[a-z0-9]+$/i, '')}-${preset}.webp` : key;
      const url = new URL(`/img/${key}`, 'https://assubkibooks.co.uk');
      url.searchParams.set('v', String(IMAGE_VERSION));
      if (preset) url.searchParams.set('p', preset);
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
      if (response.status === 404) { findings.push({ key: storedKey, status: 'missing on production' }); continue; }
      if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) throw new Error(`${storedKey}: HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      // A non-WebP preset response is the route's original-file fallback.
      // Preserve the miss locally rather than storing JPEG bytes as WebP.
      if (preset && !response.headers.get('content-type')?.startsWith('image/webp')) {
        const stale = await proxy.env.UPLOADS.head(storedKey);
        if (stale && !check) await proxy.env.UPLOADS.delete(storedKey);
        findings.push({ key: storedKey, status: stale && check ? 'differs' : 'original fallback' });
        continue;
      }
      const hash = b => createHash('sha256').update(Buffer.from(b)).digest('hex');
      const old = await proxy.env.UPLOADS.get(storedKey);
      const same = old && hash(await old.arrayBuffer()) === hash(bytes);
      if (!same && !check) await proxy.env.UPLOADS.put(storedKey, bytes, {
        httpMetadata: { contentType: response.headers.get('content-type') },
        customMetadata: { publicSource: url.href, imageVersion: String(IMAGE_VERSION) },
      });
      findings.push({ key: storedKey, status: same ? 'matches' : check ? 'differs' : 'updated', sha256: hash(bytes) });
    }
  }));
  const failed = outcomes.filter(r => r.status === 'rejected');
  if (failed.length) throw new AggregateError(failed.map(r => r.reason), 'Image sync failed; rerun to resume.');
  mkdirSync('.cache', {recursive:true});
  writeFileSync('.cache/dev-image-sync.json', JSON.stringify({at: new Date().toISOString(), version: IMAGE_VERSION, findings}, null, 2));
  console.log(findings.reduce((out, r) => {out[r.status]=(out[r.status]||0)+1; return out;}, {}));
  if (check && findings.some(r => r.status === 'differs')) process.exitCode = 1;
  console.log('Details: .cache/dev-image-sync.json. Missing production photos indicate different catalogue data; local-only photos are preserved.');
} finally { await proxy.dispose(); }
