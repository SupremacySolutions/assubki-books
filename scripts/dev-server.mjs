import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';
import { managed, shutdownHooks } from './lib/managed-process.mjs';
import { activeChecks } from './lib/check-slots.mjs';

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
  /*
   * Only *this* workspace's checks are a reason not to start a server.
   *
   * This used to refuse whenever any check was running anywhere on the machine,
   * which with one person at one terminal was the same statement. With several
   * workspaces it is not: a build in another checkout has its own D1, its own
   * R2 and its own port, and nothing about it makes this checkout unsafe to
   * serve. The real hazard is narrow and local - building over the state a
   * server in the same directory has open - so that is what is checked.
   */
  const ourCheck = activeChecks().find((check) => check.cwd === process.cwd());
  if (ourCheck) throw new Error(`A check is running in this checkout (PID ${ourCheck.pid}). Finish it before starting a server.`);
  if (process.env.CLOUDFLARE_ENV) throw new Error('Unset CLOUDFLARE_ENV for local managed development.');
  if (args.some(a => /^--?(remote|r|config|c|env|e|persist-to|var|env-file)(=|$)/.test(a))) throw new Error('Managed servers own their local bindings and notification settings.');
  if (mode === 'dev') {
    const vars = existsSync('.dev.vars') ? parseEnv(readFileSync('.dev.vars', 'utf8')) : {};
    if (vars.EMAIL_DRY_RUN !== '1' || vars.TELEGRAM_DRY_RUN !== '1') throw new Error('Set EMAIL_DRY_RUN=1 and TELEGRAM_DRY_RUN=1 in .dev.vars before local development.');
  }
  if (previous) throw new Error('A managed server is already running. Use npm run dev:stop first.');
  if (mode === 'preview' && !existsSync('dist/server/wrangler.json')) throw new Error('Run npm run build before preview.');
  const token = `asb-dev-${randomUUID().slice(0, 12)}`;
  process.title = token;
  mkdirSync('.cache', { recursive: true });
  writeFileSync(registry, JSON.stringify({ pid: process.pid, token, mode, cwd: process.cwd() }), { flag: 'wx' });
  const wrangler = resolve('node_modules/.bin/wrangler');
  const job = mode === 'dev'
    ? managed(process.execPath, [resolve('scripts/astro-foreground.mjs'), ...args])
    : managed(wrangler, ['dev', '--local', '--ip', '127.0.0.1', '--port', process.env.PORT || (mode === 'sweep' ? '4322' : '4321'), '--inspector-port', '0',
      '--var', 'EMAIL_DRY_RUN:1', '--var', 'TELEGRAM_DRY_RUN:1',
      ...(mode === 'sweep' ? ['-c', 'workers/expire-holds/wrangler.jsonc', '--persist-to', resolve('.wrangler/state'), '--test-scheduled'] : []), ...args]);
  const dispose = shutdownHooks(job.stop);
  try { process.exitCode = await job.exited; }
  finally {
    await job.stop(); dispose();
    if (existsSync(registry) && JSON.parse(readFileSync(registry, 'utf8')).token === token) unlinkSync(registry);
  }
}
