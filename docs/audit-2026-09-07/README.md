# Audit evidence and reproduction guide

Start with [REPORT.md](REPORT.md). The audit covers commit `cde261f4ea56d30a22e929fc2f9c1cd8b4efc9d1`; application source was not changed. All new files belong to this audit directory.

## Self-contained local checks

From the repository root, with its dependencies installed, Node 22.12+ and the `sqlite3` command available:

```sh
node docs/audit-2026-09-07/reproduce.mjs
python3 docs/audit-2026-09-07/benchmark.py
npm run test:reservations
npm run typecheck
npm run build
```

Run the build after stopping any dev server that shares the same Vite cache. These commands were run separately during the audit. The reproduction harness creates a temporary SQLite database from the migrations, bundles actual application functions, stubs Cloudflare bindings and notifications, and removes its own temporary directory on completion. It imposes the D1 100-bind ceiling and injects transaction failures/interleavings. It is not a complete emulator of D1 scheduling, latency or service limits.

`PASS F01` through `PASS F15` mean the current undesirable behaviour was observed. The harness catches individual non-reproductions and prints their result, so **review every result rather than relying solely on its exit code**. S01 is a positive acceptance check: 300 titles import, open and receive successfully. The benchmark prints JSON and changes only an in-memory database; candidate indexes/triggers are not migrations.

## HTTP and full workflow checks

Use only a disposable checkout with a fresh local D1 database and fake credentials. The audit used `/private/tmp/assubki-full-audit`, port 4347, migrations 0001–0036, `EMAIL_DRY_RUN=1`, `TELEGRAM_DRY_RUN=1`, and an isolated `vite.cacheDir`. Images in R2 were not copied. The password in the probe script is an intentionally public local fixture value, not a production credential.

The HTTP probe script **mutates local settings/session state** and sends malformed bodies. It refuses non-local target URLs. It must run after the full E2E suite has finished cleaning up:

```sh
E2E_SITE=http://localhost:4347 npm run test:e2e
AUDIT_SITE=http://localhost:4347 node docs/audit-2026-09-07/http-probes.mjs
```

The existing E2E script also performs database setup/cleanup: configure its local database selection to the disposable checkout, not a developer database you want to preserve. Do not use `test:e2e:prod` for this audit. Do not copy real email/Telegram credentials into the disposable environment. No actual provider messages were sent during these checks.

`endpoints.csv` contains the 62 exported route/method pairs and observed statuses. It covers endpoint boundaries; successful business cases are recorded by subsystem in the E2E log. Missing-ID probes cannot establish every valid-ID behaviour. The extra probes record malformed cookies, a login redirect, and denied proof/traversal paths.

## Production evidence

`live-checks.sql` and `read-live.mjs` document the 15 read-only D1 checks already executed. The runner restricts statements to SELECT/EXPLAIN/PRAGMA. `live-schema.json` contains schema definitions, not customer rows. `live-checks.json` contains aggregates and query plans. `d1-usage.json` contains the sampled database metrics. Configuration-presence files record names/presence, not secret values. `query-insights-summary.json` retains aggregate metrics and descriptive query labels without raw SQL literals.

`live-smoke.mjs` documents the eight read-only public URL checks. Live scripts require authenticated/network access and consume reads; they need not be rerun to read the report. Deployment metadata was inspected read-only; version dates/IDs are stated in the report, with no claimed Git mapping.

## Evidence interpretation

- `e2e-full.txt`: valid complete run, **830 passed, 0 failed**.
- `e2e-invalid-cache-run.txt`: invalid run affected by a shared dependency cache being cleared; excluded from website defect counts.
- `reservations.txt`: 18 existing regression tests passed, including the 100-reservation scenario.
- `reproductions.txt`: 15 targeted observations reproduced plus the successful 300-title test.
- `query-benchmarks.json`: synthetic SQLite plans, VM-step estimates and single-sample timings. Not D1 billing or a production load test.
- `http-probes.json`, `http-extra.json`: isolated HTTP observations, not production attacks.
- Browser observations are described in the report; no comprehensive screenshot or accessibility baseline is claimed.

The audit is a point-in-time report. Proposed fixes, schema changes and feature ideas require implementation and their own verification before release.
