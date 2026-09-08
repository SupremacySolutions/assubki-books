# Running checks on an 8 GB Mac

The npm build, typecheck and test commands share a small number of machine-local check slots across checkouts, so several workspaces can run their own checks at once without all of them building at the same moment. One slot per 4 GB of RAM, never fewer than two and never more than eight; `ASSUBKI_CHECK_SLOTS` overrides it. `test:e2e` costs two slots, because two of them at once will get one of their servers killed by the OS on this machine - which reads as a cascade of crashed suites rather than as the memory problem it is. A check that arrives when every slot is busy **waits** and then runs - it does not fail, because an exit code cannot distinguish a busy machine from broken code. Tests keep their intentional concurrent-request assertions. The guard does not cap total RAM. Server ownership and the managed launchers are documented in [development.md](development.md).

Stop the interactive dev, preview or sweeper server **in the checkout you are checking**; a server in another workspace is unrelated and is not a reason to wait. E2E starts its own server and shuts it down. Within one workspace, run typecheck, build and test suites sequentially.

For a focused E2E run, use the suite selector already supported by the test script, for example:

```sh
npm run test:e2e -- --only=shipments
```

The E2E runner now creates and removes its own disposable database and dry-run configuration; do not start a separate server for it. Run the full suite when broader validation is needed.

The wrapper forwards interruption signals to its child process group on macOS/Linux and releases its slot on normal exit. Slots live in `assubki-books-checks/` under the system temporary directory, one file each, recording the owning PID and checkout. A slot whose owner is gone is reclaimed automatically, so a force-kill or reboot no longer leaves a lock for somebody to clear by hand. Invoking Astro or the test scripts directly bypasses the guard.

During diagnosis, the machine reported 8 GB physical RAM and approximately 16 GB swap in use. Two leftover scheduled-worker test servers on ports 4340/4341 were stopped. Several other development servers and desktop applications were running; the snapshot does not isolate the peak memory contribution of an individual test. No full suite was rerun under memory pressure merely to validate the wrapper.
