# Development and test process ownership

Read `docs/development.md` before starting any server or test. These rules apply
in this checkout and every worktree, including browser investigations.

- Use the npm commands. Do not launch bare Astro, Vite, Wrangler dev, background
  shell jobs, `nohup`, or detached servers. The managed launchers own their child
  processes and clean up on completion, interruption and loss of their parent.
- Every task that starts a server must stop it before its final response, unless
  the user explicitly asks to keep a preview running. Retain the tool/session
  handle. Use `npm run dev:stop`, wait for the handle to exit, then inspect
  `npm run dev:status` and `lsof -nP -iTCP -sTCP:LISTEN`. Check remaining listeners'
  command and working directory; do not kill unrelated applications by port.
- Run checks sequentially through `scripts/run-check.mjs` (the npm commands do
  this). Stop the interactive dev/preview/sweeper server *in this checkout*
  before checks, image sync, migrations or builds; a server or check in another
  workspace is not yours to stop. Checks queue for a shared slot when the
  machine is busy - that wait is expected, not a failure. Do not delete storage
  while a process has it open.
- `npm run test:e2e` owns a disposable checkout, migrated D1, local R2, fake
  credentials, production build, server and cleanup. Never point the mutation
  suite at production or a developer database. `--only=<suite>` narrows it.
  `npm run test:e2e:prod` is a read-only public smoke check.
- Keep both EMAIL_DRY_RUN=1 and TELEGRAM_DRY_RUN=1 for local work. Never copy
  live credentials or customer data into tests. No actual email/Telegram sends
  without the user's explicit authorization.
- For visual parity use `npm run dev:images`, then a fresh `npm run build` and
  `npm run preview`. Do not enable remote D1/R2 writes to obtain parity.
- Before finishing, report which checks actually passed, any missing coverage,
  and whether project processes/listeners remain. A started check is not a pass.
