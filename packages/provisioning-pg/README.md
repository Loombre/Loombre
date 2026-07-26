# @loombre/provisioning-pg

Embedded PostgreSQL as a supervised child process (STATE.md P4.2). Implements
the frozen `@loombre/provisioning` data contract (types only — that package
carries no method signatures; the API below is this lane's own design,
built to consume/produce exactly those frozen types).

## What this package does NOT do

- **No `pg`/`kysely` driver import, anywhere.** CLAUDE.md invariant 4 bans
  the raw Postgres driver outside `packages/db`, and dependency-cruiser
  enforces it repo-wide. This package's health checks, dump/restore, and
  every data-touching operation shell out to the **bundled** `pg_isready`,
  `psql`, `pg_dumpall`, and `pg_controldata` binaries via `child_process`
  (`src/exec.ts`) instead of speaking the wire protocol itself.
- **No network fetch at runtime.** Binaries are fetched ahead of time by
  `scripts/fetch-embedded-pg.mjs` into a gitignored `vendor/embedded-pg/`
  directory; this package only ever reads them.
- **No provisioning from `apps/worker`.** See "Worker contract" below.

## Binary sourcing

See `installers/embedded-pg-manifest.json`'s `sourcing` block for the full
zonky-vs-EDB-vs-theseus-rs evaluation. Short version: **theseus-rs/postgresql-binaries**
(GitHub Releases) — the only candidate that ships the full client toolset
(`psql`/`pg_dump(all)`/`pg_isready`/`pg_controldata`/`pg_restore`/`pg_upgrade`)
at a reasonable size (11-51 MB per platform), under the permissive
PostgreSQL License, with real, independently-verified sha256 pins for all
five installer-lane platforms.

```
node scripts/fetch-embedded-pg.mjs --platform host --pg-version 17.10.0
```

See that script's own `--help` / header comment for the full CLI. Installer
lanes I1/I3/I4 call it at build time to vendor binaries alongside their
packaged artifact — **and MUST set `LOOMBRE_EMBEDDED_PG_VENDOR_DIR`** at
runtime once packaged (see `apps/server/src/bootstrap/provisioning.ts`'s
`defaultVendorDir()` doc comment: its dev-checkout-relative default cannot
resolve correctly once `apps/server` ships outside this monorepo's layout).

## API surface

- `EmbeddedPostgres` (`src/supervisor.ts`) — the real implementation.
  `provision()` (idempotent initdb + pg_hba + secret), `start()` (spawns
  `postgres` directly via `child_process.spawn`, health-polls via
  `pg_isready`, reaches `'ready'` or `'corrupt'`), `stop(mode)` (smart/fast
  shutdown per PostgreSQL's own SIGTERM/SIGINT convention), `upgrade(opts)`
  (see below), `getCurrentProvisioningStatus()`, `getDatabaseUrl()`.
- `ExternalPostgresProvisioner` (`src/external.ts`) — D1's "external PG via
  env var" path. Every mutating call throws `ExternalModeInertError`
  immediately; `getCurrentProvisioningStatus()` always reports `'external'`.
- `ProvisioningController` (`src/controller.ts`) — the shared interface both
  implement, for a caller that doesn't need to know which mode it got.

### ProvisioningState mapping (a documented interpretive choice)

The frozen `ProvisioningState` enum (`absent | provisioning | ready |
upgrading | corrupt | external`) has no dedicated member for "valid data
directory, cleanly not currently running" — a real, common state (right
after a graceful `stop()`, before the next `start()`). This package reports
that as `'provisioning'` with `detail: "stopped (clean shutdown)"` — the
closest available member. Flagged here for lane D's admin UI: check
`detail`, not just `state`, to distinguish "actively initializing" from
"stopped but healthy".

## Secrets (P4.7 seam)

Only `file0600` is implemented (`src/secret/file0600.ts`): a random 32-byte
password written to a 0600 file at the path named by
`SecretRef.key`. **Idempotent** — a second `generate()` call for the same
key returns the existing value rather than rotating it (critical: an
already-initialized cluster's stored scram verifier was derived from that
exact password; regenerating would desync them). `keychain`/`dpapi`/
`libsecret` throw `UnsupportedSecretBackendError` — Wave-2 (G1) work behind
this same seam (`src/secret/resolve.ts`'s single dispatch point; adding a
backend means one new file + one new case there, no other file changes).

## Listen strategy & pg_hba

`tcp-loopback` hard-codes `127.0.0.1` (never configurable to anything else —
P4.2 "localhost socket"); `unix-socket` disables TCP entirely (`-h ''`).
`pg_hba.conf` is **overwritten** (not trusted from initdb's own default,
which could drift across binary re-pins) with a minimal, deterministic
local + 127.0.0.1/32 + ::1/128, scram-sha-256-only policy (`src/hba.ts`) —
no `trust`, no replication entries.

**Real bug found and fixed while testing this**: a unix domain socket path
is capped at ~104 bytes (`sockaddr_un.sun_path`). `node:os`'s `tmpdir()` on
macOS resolves to a long per-process path that, combined with a descriptive
prefix, routinely blows the limit — postgres then fails to bind with no
obviously-socket-related error, and this package's health poll just times
out reporting a misleading `'corrupt'` status. `src/scratch-paths.ts`'s
`socketScratchBase()` fixes this for every socket-hosting scratch directory
this package creates internally (the `upgrade()` orchestration's throwaway
old/new-binaries instances). **apps/server's bootstrap seam sidesteps the
whole class of bug by defaulting to `tcp-loopback`**, not `unix-socket`, for
exactly this reason (`LOOMBRE_DATA_DIR` resolves to an OS/username/
localization-dependent app-data path with no length guarantee).

## Corruption detection

`src/corruption.ts` classifies REAL captured `pg_controldata` behavior (not
documentation-derived guesses — see the file header and this lane's report
for the exact transcripts):

- A **truncated** `pg_control` (partial write — the textbook "process
  killed / disk full mid-write" signature) → `pg_controldata` exits 1 with
  `could not read file "...": read X of Y` → classified `'incomplete-initdb'`.
- A **bit-corrupted but full-size** `pg_control` → `pg_controldata` prints
  `WARNING: Calculated CRC checksum does not match...` and **still exits
  0** → classified `'checksum-failure'`. Exit code alone is NOT sufficient;
  every classification rule inspects combined stdout+stderr text.
- Missing data dir / missing `PG_VERSION` / major-version mismatch are
  checked via plain `fs.existsSync`/file-content comparison before
  `pg_controldata` is ever invoked.

## Upgrade orchestration (P4.2 design constraint)

`upgrade()` executes `@loombre/provisioning`'s frozen `UpgradePlan.steps`
order **exactly**: `stop → backup → dumpall → initdb-new → restore → verify
→ swap → restart`. This is **boot-time orchestration inside this package,
NOT a pg-boss job** — the queue lives inside the PG being replaced, so it
cannot enqueue itself into itself. CLAUDE.md invariant 6 ("long-running
work goes through the job queue") is honored in spirit, not letter; this is
the one documented, deliberate deviation.

Why `dumpall` runs **after** `stop`, not before (the literal frozen order,
which reads oddly at first): `stop` quiesces the actively-supervised
instance so `backup`'s raw directory copy is taken from a consistent,
checkpointed state (copying a live, running data directory risks an
inconsistent snapshot). `dumpall` then **briefly restarts the OLD binaries**
against that same (now-backed-up) data directory on a private, throwaway
unix-socket scratch instance — never the publicly supervised one — purely
because `pg_dumpall` is a client tool that needs a live connection.
`restore`/`verify` do the mirror-image dance with the NEW binaries against
a sibling scratch data directory. Only `swap` (rename the scratch new dir
into the canonical path) and `restart` (the real, permanently-supervised
instance) touch the canonical `dataDir` again. Every step before `swap`
leaves the OLD data directory completely untouched — `UpgradeStepFailedError.oldClusterIntact`
tells a caller exactly when recovery is that simple vs. requiring the
`backupPath` copy.

`restore` deliberately does **not** pass `-v ON_ERROR_STOP=1` to `psql`:
`pg_dumpall`'s output always includes a `CREATE ROLE <superuser>` statement
that legitimately fails with "role already exists" against a cluster
`initdb`'d with that same superuser — this one specific error pattern is
tolerated; every other `ERROR:` line is a hard failure.

### Jobs-ledger deviation (documented, not implemented)

P4.2 implies "so admin UI history shows the upgrade". `upgrade()` returns a
rich `UpgradeResult` (every step's timing, the spot-check before/after
values, the resolved `UpgradePlan`) — but **writing an actual `jobs` table
row is NOT wired**, because it requires an additive `JobType` entry in
`packages/jobs/src/types.ts` (a closed enum this package does not own) plus
exporting `packages/jobs/src/ledger.ts`'s `createLedger` from that package's
public barrel (currently internal-only). This is a small, well-scoped
follow-up for whichever lane next touches `packages/jobs` — flagged, not
silently skipped.

## Worker contract (single-provisioner rule)

Only `apps/server` provisions/supervises the embedded PostgreSQL child
(`apps/server/src/bootstrap/provisioning.ts`, called before `NestFactory.create`).
`apps/worker` **never provisions anything** — it receives the same
`DATABASE_URL` via its own process environment, set by whichever service
manager started it (installer lanes' systemd unit / Windows service /
launchd plist / docker-compose all set `DATABASE_URL` for both the server
and worker units from the same source; this is an installer-lane
responsibility, not wired here).

**If the worker starts before the server has finished provisioning** (or
`DATABASE_URL` simply isn't reachable yet): `apps/worker/src/index.ts` gained
a small, additive `waitForDatabaseReady()` guard — the very first thing
`main()` does — that retries a real guarded query (`listLibraries`, already
imported) for up to 30s, then **fails fast** with a clear message naming the
single-provisioner rule, rather than the pre-existing behavior of silently
logging a swallowed `pg-boss` connection error and limping on with a
non-functional queue forever.

## Testing

Fast unit tests (`test/*.spec.ts`, no `.integration.` in the name) are pure
logic — no binaries, no network, run in milliseconds. The real exit-bar
suites (`test/*.integration.spec.ts`) use REAL downloaded darwin-arm64
binaries in temp dirs, gated by `test/support/real-binaries.ts`:

- On darwin-arm64 (the platform this lane's binaries/tests were proven on):
  runs for real, fetching binaries over the network on first run if not
  already vendored (`node scripts/fetch-embedded-pg.mjs` beforehand avoids
  the network hit on every `pnpm run test`).
- Elsewhere: skips loudly with a console warning naming the gap.
- `LOOMBRE_REQUIRE_PG_PROVISIONING_INTEGRATION=1` escalates that skip to a
  hard failure — for an owner-hardware CI leg, mirroring
  `apps/worker/test/transcode/vt-tonemap-args.integration.spec.ts`'s
  `LOOMBRE_REQUIRE_VT` precedent.

```
pnpm --filter @loombre/provisioning-pg run test
node --test scripts/fetch-embedded-pg.test.mjs   # pure script-logic tests
```
