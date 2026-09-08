import { cpSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, openSync, closeSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, basename } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { managed, shutdownHooks } from './lib/managed-process.mjs';

const args = process.argv.slice(2);
if (args.some(a => !a.startsWith('--only='))) throw new Error('Usage: npm run test:e2e -- [--only=suite]. This suite only runs in disposable local storage.');
const root = process.cwd();
const temp = realpathSync(mkdtempSync(join(tmpdir(), 'assubki-e2e-')));
const jobs = new Set();
let interrupted = false;
const dispose = shutdownHooks(async () => {
  interrupted = true;
  await Promise.all([...jobs].map(j => j.stop()));
}, { timeoutMs: 90 * 60 * 1000 });
const token = randomUUID();
const env = { ...process.env, ASSUBKI_E2E_ROOT: temp, ASSUBKI_E2E_TOKEN: token, WRANGLER_SEND_METRICS: 'false' };
// No ambient Cloudflare environment may redirect a disposable run to remote bindings.
delete env.CLOUDFLARE_ENV;
delete env.E2E_SITE;
async function run(command, argv, options = {}) {
  if (interrupted) throw new Error('E2E interrupted');
  const job = managed(command, argv, { cwd: temp, env, ...options });
  jobs.add(job);
  const code = await job.exited;
  jobs.delete(job);
  if (code) throw new Error(`${command} exited with ${code}`);
}
let logFd;
try {
  // Copy only inputs. Never copy .dev.vars, databases, reports, git history or
  // dependency caches. Unsaved working-tree source edits are tested too.
  for (const name of ['src', 'public', 'migrations', 'scripts', 'workers', 'data', 'astro.config.mjs', 'wrangler.jsonc', 'tsconfig.json', 'package.json', 'worker-configuration.d.ts']) {
    cpSync(join(root, name), join(temp, name), { recursive: true, filter: p => !p.includes('/.wrangler') && !p.includes('/public/img/books') && !/^\.(dev\.vars|env)(\.|$)/.test(basename(p)) });
  }
  symlinkSync(join(root, 'node_modules'), join(temp, 'node_modules'), 'dir');
  writeFileSync(join(temp, '.e2e-owned'), token, { mode: 0o600 });
  // A readiness response must come from OUR build, not an unrelated listener.
  writeFileSync(join(temp, 'src/pages/e2e-owner.ts'), `export const prerender=false; export const GET=()=>new Response(${JSON.stringify(token)},{headers:{'Cache-Control':'no-store'}});`);
  writeFileSync(join(temp, '.dev.vars'), `ADMIN_PASSWORD=e2e-local-only\nCOOKIE_SECRET=e2e-cookie-secret-at-least-32-characters\nEMAIL_DRY_RUN=1\nTELEGRAM_DRY_RUN=1\nRESEND_API_KEY=local-test\nTELEGRAM_BOT_TOKEN=local-test\nTELEGRAM_WEBHOOK_SECRET=e2e-local-hook\nOWNER_EMAIL=owner@example.invalid\nTEST_CUSTOMER_EMAIL=customer@example.invalid\nTEST_TELEGRAM_CHAT_ID=5253230054\n`, { mode: 0o600 });
  console.log(`Disposable E2E environment: ${temp}`);
  mkdirSync(join(root, '.cache'), { recursive: true });
  logFd = openSync(join(root, '.cache/e2e-server.log'), 'w', 0o600);
  const wrangler = join(temp, 'node_modules/.bin/wrangler');
  await run(wrangler, ['d1', 'migrations', 'apply', 'assubki-books', '--local'], { stdio: ['ignore', logFd, logFd] });
  await run(join(temp, 'node_modules/.bin/astro'), ['build']);
  // Ask the OS for a free port. Wrangler fails rather than attaching to any
  // other service if the port is taken between reservation and startup.
  const socket = createServer();
  await new Promise((r, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', r); });
  const port = socket.address().port;
  await new Promise(r => socket.close(r));
  env.E2E_SITE = `http://127.0.0.1:${port}`;
  mkdirSync(join(root, '.cache'), { recursive: true });
  const logPath = join(root, '.cache/e2e-server.log');

  const server = managed(wrangler, ['dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', '0'], { cwd: temp, env, stdio: ['ignore', logFd, logFd] });
  jobs.add(server);
  let serverExited = false;
  server.exited.then(() => { serverExited = true; });
  let ready = false;
  for (let i = 0; i < 120 && !interrupted && !serverExited; i++) {
    try {
      const res = await fetch(`${env.E2E_SITE}/e2e-owner`, { redirect: 'manual', signal: AbortSignal.timeout(1000) });
      const body = await res.text();
      if (res.status === 200 && body === token) { ready = true; break; }
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  if (!ready) throw new Error(`E2E server did not become ready. Inspect ${logPath}`);
  await run(process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/e2e.mjs', ...args]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await Promise.all([...jobs].map(j => j.stop()));
  dispose();
  if (logFd !== undefined) closeSync(logFd);
  rmSync(temp, { recursive: true, force: true });
  console.log('E2E servers stopped and disposable storage removed.');
}
