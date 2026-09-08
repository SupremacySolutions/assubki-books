# Local development and testing

`npm run dev` starts Astro's fast reload server on 4321. `npm run build` followed
by `npm run preview` serves the compiled Worker on 4321, using the same runtime,
compatibility date, asset handling and CSP code as deployment. Use preview for
final browser checks. Both use local D1/R2. Local storage and catalogue contents
are independent of production; payment providers and real message delivery are
not exercised by dry runs.

Set `EMAIL_DRY_RUN=1` and `TELEGRAM_DRY_RUN=1` in your gitignored `.dev.vars`.
The dev launcher refuses unsafe notification settings. Preview and sweeper also
force both flags. For a fresh database, apply all migrations.

Apply migrations using `node_modules/.bin/wrangler d1 migrations apply
assubki-books --local` with all servers stopped. Existing manually seeded local
databases need ledger reconciliation first; see the schema guide.

## Server ownership

Use `npm run dev:status` to inspect the managed server and `npm run dev:stop` to
stop it. Ctrl-C also stops its children. `npm run dev:sweep` runs the scheduled
Worker locally on 4322 using the site's local state; it can mutate that local
state when its scheduled endpoint is triggered. Only one managed server runs in
a checkout at a time.

Astro 7's CLI auto-starts background daemons in agent environments. Our launcher
uses Astro's documented `dev()` API to keep the server in the owned foreground
process. Supported dev flags are `--port`, `--host <address>` and `--open`.

The launchers use process groups, an independent parent-death guard, and a
two-hour maximum lifetime (90 minutes for a full E2E run). These are backstops,
not permission to abandon a running task. Agents must stop servers and verify
ports before finishing. A terminal deliberately left open for a user remains
owned by that session. The implementation supports macOS and Linux.

Run `lsof -nP -iTCP -sTCP:LISTEN` after stopping; use `ps` and `lsof -a -p PID -d
cwd` to attribute unexpected listeners. Never kill other apps by matching a port
number. A machine restart/force-kill can leave disposable folders behind; these
do not prove a process is running.

## Several workspaces at once

Each checkout is independent: its own server registry, its own local D1 and R2,
its own port. Two workspaces can serve and check at the same time. Two things
follow from that.

**Give each one a port.** Both default to 4321 and `strictPort` is on, so a
second server on the same port fails loudly rather than drifting to another one
and leaving you testing against the wrong thing. `PORT=4325 npm run dev`.

**Checks share slots, and queue rather than fail.** One slot per 4 GB of RAM,
minimum two, maximum eight, overridable with `ASSUBKI_CHECK_SLOTS`. A check that
finds them all busy waits, names who is holding them, and then runs - it does
not exit non-zero, because nothing reading an exit code could tell a busy
machine from a broken build. Only a check *in the same checkout* stops that
checkout's server starting; another workspace's check is not your concern.

**`test:e2e` counts as two.** It builds the Worker and runs `wrangler dev`
beside the assertions, and two of those at once on an 8 GB machine is enough for
the OS to kill one of the servers. That surfaces as `TypeError: terminated`
followed by every later suite "crashing" - a failure with nothing to do with the
code under test, and one that takes a while to disbelieve. Weighing it at two
means a second full E2E run waits its turn while lighter checks still share the
machine. On a two-slot machine that gives E2E the machine to itself, which is
the intent.

A new worktree starts with an empty database. Apply migrations in it before the
site will serve anything, and symlink or install `node_modules`.

## Tests

```sh
npm run typecheck
npm run build
npm run test:reservations
npm run test:covers
npm run test:backup
npm run test:tooling
npm run test:e2e
npm run test:e2e -- --only=shipments
npm run test:e2e:prod
```

Run these sequentially with interactive servers stopped. Vite caches live under
`.astro/vite` per checkout rather than shared `node_modules`.

E2E creates a temporary copy of current source, applies every migration, builds
the production Worker, chooses a free loopback port and waits for readiness.
It passes one owned environment to both the HTTP client and database helpers.
It never reads your `.dev.vars` or reuses your D1. On exit, failure or interruption,
it stops its servers before removing the disposable directory. Setup/server logs
are in `.cache/e2e-server.log`. The terminal output contains assertions and the
summary. An unknown suite, failed cleanup or skipped authenticated suite fails.

The HTTP suite changes settings, deletes fixture ranges and builds artificial
inventory states. Its old production mode was unsafe; direct execution and
`--prod` now refuse before any request or database operation. `test:e2e:prod`
performs only public GET smoke checks. HTTP tests do not click UI or verify
browser layout; cover geometry/dialog tests use painted fixtures and DOM mocks.
Use a browser on the compiled preview when changing interaction or appearance.

## Covers matching production

The image route first reads a stored `-card`, `-hero`, `-detail`, `-thumb` or
`-social` variant from R2, then falls back to the original if absent. An original
scan has different borders/aspect ratio from a processed production variant.
The old local bucket had no card variants, so local fallback visibly differed.

With servers stopped, run `npm run dev:images`. This reads public photo URLs
for keys in your local catalogue and writes their exact bytes into local R2.
It copies originals and all five presets, never touches production storage,
and does not copy orders, credentials, reports or payment proofs. Re-run after
production image processing changes. `-- --check` compares without writing;
`-- --only=slug-fragment` narrows either operation. The report is saved in
`.cache/dev-image-sync.json`. Photos missing from production are reported and
local-only uploads preserved. This does not synchronise catalogue edits.

Use a hard refresh/clear localhost's image cache after the first sync: old local
responses were cached as immutable for a year at the same URL. Production image
versions still need bumping whenever production bytes change. Do not regenerate
from WordPress scans to match production's later edited crops.

References: [Astro Cloudflare preview](https://docs.astro.build/en/guides/deploy/cloudflare/),
[Cloudflare local storage](https://developers.cloudflare.com/workers/local-development/local-data/).

[Astro programmatic dev API](https://docs.astro.build/en/reference/programmatic-reference/#dev).
