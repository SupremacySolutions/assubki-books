import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';
import { managed, shutdownHooks } from './lib/managed-process.mjs';
import { acquireServer } from './lib/check-slots.mjs';

const [mode = 'dev', ...args] = process.argv.slice(2);
const registry = resolve('.cache/dev-server.json');
function current() {
  if (!existsSync(registry)) return null;
  const record = JSON.parse(readFileSync(registry, 'utf8'));
  try {
    const command = execFileSync('ps', ['-p', String(record.pid), '-o', 'command='], { encoding: 'utf8' });
    if (command.includes(record.token)) return record;
  } catch {}
  unlinkSync(registry);
  return null;
}
const previous = current();
if (mode === 'status' || mode === 'stop') {
  if (!previous) console.log('No managed server in this checkout.');
  else if (mode === 'status') console.log(`${previous.mode}: PID ${previous.pid}, ${previous.cwd}`);
  else {
    process.kill(previous.pid, 'SIGTERM');
    for (let i = 0; i < 100 && current(); i++) await new Promise(r => setTimeout(r, 100));
    if (current()) throw new Error('Server has not stopped; inspect the PID before continuing.');
    console.log('Managed server stopped.');
  }
} else {
  if (!['dev', 'preview', 'sweep'].includes(mode)) throw new Error(`Unknown server mode: ${mode}`);
  if (process.env.CLOUDFLARE_ENV) throw new Error('Unset CLOUDFLARE_ENV for local managed development.');
  if (args.some(a => /^--?(remote|r|config|c|env|e|persist-to|var|env-file)(=|$)/.test(a))) throw new Error('Managed servers own their local bindings and notification settings.');
  /*
   * Telegram may be let out, but only somewhere that is not the shop.
   *
   * The rule used to be "a local server never sends", enforced by pinning both
   * dry-run flags on. That is the right instinct - a local test did once post
   * to the live channel - but it is blunter than the danger: it also forbids
   * posting to a channel set up for exactly this, so the only place left to
   * try the real thing was production.
   *
   * So the guard asks which channel rather than whether to send. A `.dev.vars`
   * naming the channel `wrangler.jsonc` ships to is the accident, and is
   * pinned to a dry run with no way to opt out. A different channel is the
   * developer's own, and `TELEGRAM_DRY_RUN=0` there is honoured.
   *
   * Email has no equivalent: there is no address that is safe by construction
   * the way a separate channel is, so it stays pinned.
   */
  const vars = existsSync('.dev.vars') ? parseEnv(readFileSync('.dev.vars', 'utf8')) : {};
  const shipped = JSON.parse(
    readFileSync('wrangler.jsonc', 'utf8').replace(/^\s*\/\/.*$/gm, ''),
  ).vars ?? {};
  const ownChannel = Boolean(vars.TELEGRAM_CHANNEL_ID) &&
    vars.TELEGRAM_CHANNEL_ID !== shipped.TELEGRAM_CHANNEL_ID;
  const telegramDry = ownChannel && vars.TELEGRAM_DRY_RUN === '0' ? '0' : '1';
  if (mode === 'dev') {
    if (vars.EMAIL_DRY_RUN !== '1' || vars.TELEGRAM_DRY_RUN !== '1') {
      if (telegramDry === '1') throw new Error('Set EMAIL_DRY_RUN=1 and TELEGRAM_DRY_RUN=1 in .dev.vars before local development.');
    }
  }
  if (telegramDry === '0') {
    console.log(`Telegram is LIVE for this server, posting to ${vars.TELEGRAM_CHANNEL_ID} (not the shop's ${shipped.TELEGRAM_CHANNEL_ID}).`);
  }
  if (previous) throw new Error('A managed server is already running. Use npm run dev:stop first.');
  if (mode === 'preview' && !existsSync('dist/server/wrangler.json')) throw new Error('Run npm run build before preview.');
  const lease = acquireServer();
  process.on('exit', () => lease.release());
  try {
    const token = `asb-dev-${randomUUID().slice(0, 12)}`;
    process.title = token;
    mkdirSync('.cache', { recursive: true });
    writeFileSync(registry, JSON.stringify({ pid: process.pid, token, mode, cwd: process.cwd() }), { flag: 'wx' });
    const wrangler = resolve('node_modules/.bin/wrangler');
    const job = mode === 'dev'
      ? managed(process.execPath, [resolve('scripts/astro-foreground.mjs'), ...args])
      : managed(wrangler, ['dev', '--local', '--ip', '127.0.0.1', '--port', process.env.PORT || (mode === 'sweep' ? '4322' : '4321'), '--inspector-port', '0',
        '--var', 'EMAIL_DRY_RUN:1', '--var', `TELEGRAM_DRY_RUN:${telegramDry}`,
        ...(mode === 'sweep' ? ['-c', 'workers/expire-holds/wrangler.jsonc', '--persist-to', resolve('.wrangler/state'), '--test-scheduled'] : []), ...args]);
    const dispose = shutdownHooks(job.stop);
    try { process.exitCode = await job.exited; }
    finally {
      await job.stop(); dispose();
      if (existsSync(registry) && JSON.parse(readFileSync(registry, 'utf8')).token === token) unlinkSync(registry);
    }
  } finally { lease.release(); }
}
