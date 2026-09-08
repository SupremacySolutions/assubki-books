# Running checks on an 8 GB Mac

The npm build, typecheck and test commands share a machine-local lock across checkouts. A second check exits with an explanation instead of running alongside the first. Tests keep their intentional concurrent-request assertions. The guard does not cap total RAM. Server ownership and the managed launchers are documented in [development.md](development.md).

Stop interactive dev, preview and sweeper servers before checks. E2E starts its own server and shuts it down. Run typecheck, build and test suites sequentially.

For a focused E2E run, use the suite selector already supported by the test script, for example:

```sh
npm run test:e2e -- --only=shipments
```

The E2E runner now creates and removes its own disposable database and dry-run configuration; do not start a separate server for it. Run the full suite when broader validation is needed.

The wrapper forwards interruption signals to its child process group on macOS/Linux and removes its lock on normal exit. A force-kill or reboot can leave a stale `assubki-books-check.lock` under the system temporary directory. The error prints the exact path and owner PID. Check that the owner and its test children have stopped before removing that lock. Invoking Astro or the test scripts directly bypasses the guard.

During diagnosis, the machine reported 8 GB physical RAM and approximately 16 GB swap in use. Two leftover scheduled-worker test servers on ports 4340/4341 were stopped. Several other development servers and desktop applications were running; the snapshot does not isolate the peak memory contribution of an individual test. No full suite was rerun under memory pressure merely to validate the wrapper.
