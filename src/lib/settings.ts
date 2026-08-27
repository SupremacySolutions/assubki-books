import { env } from 'cloudflare:workers';

/**
 * Small key/value store for things the owner changes without a deploy —
 * bank details, default postage, collection address. These are content, not
 * configuration, so they live in the database rather than in secrets.
 */

export type SettingKey =
  | 'payment_instructions'
  | 'default_postage_pence'
  | 'collection_address';

export async function getSetting(key: SettingKey, fallback = ''): Promise<string> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? fallback;
}

export async function getSettings(): Promise<Record<string, string>> {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all<{
    key: string;
    value: string;
  }>();
  return Object.fromEntries(results.map((r) => [r.key, r.value]));
}

export async function setSetting(key: SettingKey, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()`,
  )
    .bind(key, value)
    .run();
}

export async function defaultPostagePence(): Promise<number> {
  const raw = await getSetting('default_postage_pence', '0');
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
