# installers/docker/BUILD-NOTES.md

Lane I2 (Phase 4 Wave 1) build/verification log — native-module and
packaging findings from actually building this Dockerfile for
linux/amd64 + linux/arm64 via buildx, and running the automated smoke
test. Kept here (not just in the orchestrator report) because several of
these findings are load-bearing for OTHER lanes (I1's tarball build hits
the exact same TypeScript-runtime-resolution issues; lane I's release
pipeline needs the image-size numbers and the sign-hook location).

## 1. ffmpeg sourcing: static per-manifest, not distro (plan deviation from the original brief)

This lane's brief said "ffmpeg+ffprobe from the distro (document version)
or static per `installers/ffmpeg-manifest.json` if lane I1 has landed it
(check; else distro ffmpeg + report)". At the time this lane started,
neither `installers/ffmpeg-manifest.json` nor `scripts/fetch-ffmpeg.mjs`
existed. Both landed mid-session (lane I1, concurrently). Once they did,
this Dockerfile switched to consuming them (a dedicated `ffmpeg-fetch`
build stage calls `scripts/fetch-ffmpeg.mjs --platform linux-x64|linux-arm64`
per `$TARGETARCH`) rather than `apt-get install ffmpeg` — this gets a
newer, GPL-3.0 statically-linked-libx264/libx265 build (ffmpeg **8.1.2**)
instead of Debian bookworm's distro package (**5.1.9-0+deb12u1**, confirmed
by actually installing it and running `ffmpeg -version` before the manifest
landed), with the checksum verification and AGPL "mere aggregation"
provenance already documented in the manifest.

Two build-time-only findings from wiring this in:

- Debian bookworm-slim's `tar` does **not** ship `xz` support out of the
  box — `tar -xJf` fails with `xz: not found` (GNU tar shells out to a
  standalone `xz` binary for `-J`, it does not link liblzma directly on
  this image). The `ffmpeg-fetch` stage installs `xz-utils` (+`unzip`,
  for platforms whose manifest entries use `.zip`, not needed for Linux
  but kept for consistency with the script's own two supported formats).
- `installers/ffmpeg-manifest.json`'s linux-arm64 entry was verified by
  lane I1 via `publisher-checksums-file` (not independently re-downloaded
  by that lane — its own dev host is x86_64). This lane's arm64 buildx
  build **is** that independent re-verification: `scripts/fetch-ffmpeg.mjs`
  re-hashes the actual downloaded bytes against the pinned sha256
  regardless of how that pin was originally sourced, and the arm64 image
  build (§3 below) exercised that path for real, under QEMU, and passed.

## 2. Real packaging-friction findings (this lane's actual purpose)

Found by trying to run the **compiled** `apps/server/dist/main.js` /
`apps/worker/dist/index.js` directly with plain `node`, the way a
straightforward Dockerfile would default to, and watching it fail three
different ways in sequence. Reported here VERBATIM per this lane's brief.

### 2a. `@loombre/db` and `@loombre/jobs` ship raw TypeScript at runtime, not compiled dist — despite `jobs` HAVING a working build script

Both packages' `package.json` `"exports"` map `"."` straight to
`"./src/index.ts"`. `@loombre/db` has no `build` script at all (consistent
— nothing to point at instead). `@loombre/jobs` **does** have a working
`"build": "tsc -p tsconfig.json"` script that produces a perfectly good
`dist/` — but its `exports` field was never updated to point at it, so
that `dist/` is silently dead weight nobody loads. Confirmed by testing:
copying only `packages/jobs/dist` into an assembled runtime tree makes
`apps/server/dist/main.js` fail with
`Cannot find module '.../apps/server/node_modules/@loombre/jobs/src/index.ts'`
— copying `packages/jobs/src` instead (and dropping the unused `dist`
copy) fixes it.

This repo's own `scripts/perf-t0.mjs` already documents the `@loombre/db`
half of this exactly (see its `spawnServer()` comment: *"node dist/main.js
404s inside @loombre/db before /healthz ever answers"*) and works around it
by registering `tsx` as a loader via `NODE_OPTIONS=--import tsx` for the
child process it spawns. This Dockerfile's runtime image does the same
(`ENV NODE_OPTIONS="--import tsx"`) — same precedent, now load-bearing for
a real deployment artifact, not just a perf-harness child process.

**Discovery for lane I1** (Linux tarball): a tarball install running
`node apps/server/dist/main.js` directly will hit the identical failure
unless it also ships `tsx` and sets `NODE_OPTIONS`, or the systemd unit's
`ExecStart` is written accordingly. Worth confirming I1 either already
does this or picks it up from this note.

**Root-cause fix (out of this lane's scope — `apps/`/`packages/` frozen
for I2):** either give `@loombre/jobs`'s `exports` field the same treatment
as `@loombre/playback-engine`/`@loombre/shared` (point at `dist/index.js`,
delete the dead-weight-avoidance question entirely), or — if raw-TS-at-
runtime for `@loombre/db`/`@loombre/jobs` is an intentional simplicity
choice — drop `@loombre/jobs`'s unused `build` script and document the
`tsx`-loader requirement as an explicit, first-class runtime dependency
rather than a devDependency-in-name-only.

### 2b. `apps/server` imports `ajv` at real request time; `apps/server/package.json` lists it as a devDependency ONLY

`apps/server/src/common/device-profile-validator.ts` does
`import { Ajv } from "ajv"` and runs it on every `POST /auth/login` (P2.3
DeviceProfile schema validation, 422 on malformed). `apps/server/package.json`
lists `ajv` under `devDependencies` exclusively. A `pnpm install --prod`
correctly (per that classification) removes it — and login then fails at
runtime with `Cannot find package 'ajv'`. Confirmed by reproducing the
exact failure, then fixing it by restoring `ajv` (+ its own dependency
group: `fast-deep-equal`, `fast-uri`, `json-schema-traverse`,
`require-from-string`) alongside the `tsx` shim below.

Swept the rest of the pruned dependency graph (`apps/worker`,
`packages/db`, `packages/jobs`, `packages/playback-engine`,
`packages/shared`) for the same pattern — grepped every devDependency name
against each package's own `src/` (excluding `.spec.ts`/`test/`) — and
found no other instance. This is an isolated, single-line classification
bug: `ajv` belongs in `apps/server/package.json`'s `dependencies`, not
`devDependencies`.

### 2c. How the runtime image resolves both without touching `apps/`/`packages/`

`pnpm install --prod` is correct given the package.jsons as they stand
today — the fix belongs in those files (out of scope this lane), not in
working around a correct prune. The Dockerfile's `builder` stage instead
snapshots `tsx` and `ajv`'s real resolved directories (each package's own
`.pnpm/<name>@<version>/node_modules/` sibling group — dereferenced with
`cp -RL`, not just the top-level symlink, since `tsx` needs `esbuild`
+ `esbuild`'s own platform-specific `@esbuild/<os-arch>`
optionalDependency, and `ajv` needs its four listed siblings) into
`/tmp/runtime-shims` **before** the separate `prod-deps` stage's
`--prod` install runs, then restores them into that stage's `node_modules`
afterward. Path resolution uses `readlink -f`, not a hardcoded
`@<version>` string, so a future lockfile bump doesn't silently break it.

Two resolution-location gotchas worth recording since they weren't
obvious going in:

- `tsx` resolves at the **root** `node_modules/tsx` (multiple pruned
  workspace members declare it as a devDependency, so pnpm links it
  there).
- `ajv` resolves **only** at `apps/server/node_modules/ajv` — it is not
  hoisted to root (only `apps/server` declares it at all). The restore
  logic in the Dockerfile reads from that path specifically, not root.

## 3. `pnpm install --prod` mutating an existing install does NOT shrink the store the way it looks like it should

Measured directly: a full (`devDependencies` included) install's
`node_modules` was 238 MB. Running `pnpm install --frozen-lockfile --prod`
**in place** against that same tree reported "-347 packages" removed —
but the resulting `node_modules` measured **252 MB**, not smaller. pnpm's
`--prod` prune removes the top-level convenience symlinks but does not
garbage-collect the underlying content-addressable `.pnpm` store, so
every byte those 347 packages occupied stays on disk regardless.

Fix: the Dockerfile's `prod-deps` stage is a **separate, from-scratch**
install using only the turbo-pruned `dependencies` (never installs
`devDependencies` in that stage at all), sharing download bytes with the
`builder` stage only via a BuildKit cache mount
(`--mount=type=cache,id=loombre-pnpm-store,...`), never via a shared
`node_modules`. Same measurement redone this way: **54 MB**, 149 packages
— reflects what "prod-only" should actually mean. This is the standard
Vercel-turborepo-Docker pattern for exactly this reason; recording the
measured before/after here because the failure mode is silent (the
`-347 packages` line looks like success) unless you actually check the
resulting size.

## 4. `turbo prune`'s `out/full/` does not include root-level config files outside the pruned packages' own directories

Every pruned package except `@loombre/db` and `@loombre/sdk` has a
`tsconfig.json` that does `"extends": "../../tsconfig.base.json"`.
`turbo prune --docker`'s `out/full/` only contains the pruned packages'
own directories — `tsconfig.base.json` at the monorepo root is not one of
them, so the `builder` stage's `tsc` invocations would fail on a missing
extends target. Fixed with one explicit
`COPY --from=pruner /repo/tsconfig.base.json ./tsconfig.base.json` (the
`pruner` stage's own `/repo` still has it, from that stage's un-pruned
`COPY . .`) placed after the `out/full/` copy. Small, but easy to lose an
hour to if you don't know to look for it — recording it since lane I's
release-pipeline Docker builds (and any future Dockerfile changes here)
will hit the same thing if this pattern is copied elsewhere.

## 4b. `apps/server`'s `prebuild`/`pretypecheck`/`pretest` hooks reference a sibling package by relative path, invisible to `turbo prune`'s graph

Found live, mid-lane-I's-own-work (this landed on disk during this lane's
session, after the §4 finding above was already written): `apps/server/
package.json` runs `../../node_modules/.bin/tsc -p
../../packages/release-manifest/tsconfig.json` as its `prebuild`/
`pretypecheck`/`pretest` step — type-checking `@loombre/release-manifest`
as a bare relative-path npm lifecycle hook, NOT as a `dependencies`/
`devDependencies` graph edge. `turbo prune`'s scope resolution walks the
package.json dependency graph only, so with a prune scope of just
`@loombre/server @loombre/worker`, `@loombre/release-manifest` is silently
absent from `out/full/` and the `prebuild` hook fails with `TS5058: The
specified path does not exist: '../../packages/release-manifest/
tsconfig.json'` — a full build failure, not a warning.

Fixed by adding `@loombre/release-manifest` as an explicit third scope to
the `pruner` stage's `turbo prune` invocation (`turbo prune @loombre/server
@loombre/worker @loombre/release-manifest --docker`) — turbo prune accepts
multiple explicit workspace scopes, not just one root; this pulls the
package's source + `package.json` into `out/full/`/`out/json/` the same
as any real dependency would, with no other Dockerfile change needed
(its own `tsconfig.json` extends the same root `tsconfig.base.json`
already being copied in for the §4 fix, so no second config-file gap).

**Discovery for lane I / whoever owns this hook long-term:** a relative-
path npm lifecycle script that reaches outside its own package directory
is invisible to every monorepo tool that reasons about the dependency
graph structurally (`turbo prune` here; likely also affects `turbo`'s own
task-graph caching/invalidation for `@loombre/server`'s `build`/
`typecheck`/`test` tasks, which won't know to invalidate their cache when
`@loombre/release-manifest`'s source changes, since that's not a declared
`dependsOn` edge either). If this pre-build type-check is meant to stay
long-term, making `@loombre/release-manifest` a real `dependencies` (or at
least `devDependencies`) entry of `@loombre/server` would fix both this
Dockerfile's need for a manual extra prune scope AND give turbo's own
cache the dependency edge it's currently blind to — a smaller, more
standard change than the relative-path hook it would replace.

## 4c. Two more workspace packages landed as real runtime imports mid-lane, needed their `dist/` added to the explicit COPY list

Also found live, via the same "keep re-running the smoke test against the
live tree" process, as two more concurrently-landing lanes (B: embedded-PG
provisioning; I: update-check) wired their packages into `apps/server`'s
actual runtime import graph:

- `apps/server/src/bootstrap/provisioning.ts` imports `@loombre/provisioning-pg`
  (and transitively `@loombre/provisioning`) — both are now real
  `dependencies` entries in `apps/server/package.json` (confirmed), so
  `turbo prune`'s graph walk picked them up into `out/full/`/`out/json/`
  automatically with no Dockerfile change needed there. The gap was
  narrower: this Dockerfile's runtime stage copies `dist/` per-package by
  an **explicit list** (deliberately — see the builder-stage comment on
  why raw `src/` isn't copied wholesale for every package), and that list
  simply didn't know these two packages existed yet when first written.
  Both are FROZEN contracts this lane never edits (`packages/provisioning`,
  `packages/provisioning-pg` are named in this lane's own frozen-contracts
  list) but still had to be *packaged* correctly once something else
  started importing them for real. The embedded-PG code paths inside
  `provisioning-pg` stay dormant in this image (DATABASE_URL/external-PG
  is the only mode this Docker distribution supports — see this
  Dockerfile's own header), but the module still has to **resolve** at
  import time regardless of which path executes at runtime.
- `apps/server/src/common/update-check/release-manifest-import.ts` imports
  `@loombre/release-manifest` directly at runtime (P4.16) — but, unlike the
  two above, `apps/server/package.json` does **not** list it under
  `dependencies` anywhere (checked directly). It only resolves at all in
  this image because §4b's fix already added `@loombre/release-manifest`
  as an explicit third `turbo prune` scope for the unrelated `prebuild`-
  hook reason — meaning that fix's side effect papered over a second,
  independent gap (this package needed its `dist/` in the explicit COPY
  list too). Had §4b's fix not already existed, this would have been a
  full `turbo prune` scope miss on top of a missing-`dist`-copy miss.
  **Discovery for lane I**: `@loombre/release-manifest` should be a real
  `dependencies` entry of `@loombre/server`, the same conclusion §4b
  reaches for the unrelated `prebuild` hook — two separate call sites in
  the same app importing/type-checking the same package with NEITHER
  going through a declared dependency edge is worth fixing once, properly,
  rather than this Dockerfile continuing to compensate for it.

Both fixed with one `COPY --from=builder .../dist ./packages/<name>/dist`
line each, same pattern as every other dist-shipping package. Recorded
here specifically to make the point in §9 below concrete: this is not a
one-time "the tree was broken, now it's fixed" story — it is several
independent, real, currently-landing features each adding a genuine new
runtime dependency edge mid-session, and this Dockerfile needed a small,
correct update for each one. The fixes are durable (they package
whatever these apps actually import); they are not workarounds for
something expected to change back.

## 5. `pnpm install --prod` refuses to run without a TTY unless `CI=true`

`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` — pnpm asks for interactive
confirmation before removing `node_modules` contents when switching
install modes, and refuses non-interactively unless `CI=true` (or
`confirmModulesPurge: false` in `.npmrc`) is set. The `base` stage sets
`ENV CI=true` for exactly this reason (every `RUN pnpm install` in every
downstream stage inherits it). Not a Loombre-specific issue, but exactly
the kind of thing that produces a confusing one-line failure in an
unattended build if you haven't hit it before.

## 6. Native-module / prebuilt-binary behavior under multi-arch buildx (QEMU)

Built both `linux/amd64` and `linux/arm64` for real via `docker buildx bake`
(Docker Desktop's built-in QEMU emulation — no separate binfmt setup
needed on this host), twice: once early against a stable snapshot (§9
below explains why a snapshot was needed at that point in the session),
and once more at the very end against the CURRENT live tree with every
fix in this document applied (`loombre:0.9.0-amd64`/`loombre:0.9.0-arm64`,
`org.opencontainers.image.revision=cd3a6dd` — verified via `docker
inspect`'s own Labels output, confirming the OCI version-labeling
mechanism itself works end to end). Final image sizes (§7) are from this
second, final run. **No native-module friction of any kind** — every
prebuilt binary resolved cleanly per target architecture with zero manual
intervention:

- **sharp** (`@img/sharp-linux-x64`/`@img/sharp-linux-arm64` +
  corresponding `-libvips-*` optionalDependencies): pnpm resolved the
  correct platform variant automatically in each `RUN pnpm install`, in
  both the `amd64` and `arm64` builder/prod-deps stages, running under
  QEMU emulation. `sharp`'s own `install/check.js` postinstall step
  printed `Done` (no rebuild-from-source fallback triggered) on both
  arches.
- **esbuild** (transitively via `tsx`, restored as a runtime shim — see
  §2/§2c above): same story — `@esbuild/linux-x64` / `@esbuild/linux-arm64`
  resolved correctly per arch; the shim-restore logic in the `builder`
  stage (which reads real resolved paths via `readlink -f`, never a
  hardcoded arch string) worked identically on both without any
  arch-specific branching needed.
- **hash-wasm** (argon2id) and **xxhash-wasm** (file-identity hashing):
  pure WASM, arch-agnostic by construction — nothing to verify per-arch,
  confirmed by both builds simply succeeding.
- **ffmpeg/ffprobe**: the `ffmpeg-fetch` stage's `$TARGETARCH` ->
  manifest-platform mapping (`amd64` -> `linux-x64`, `arm64` ->
  `linux-arm64`) fetched and checksum-verified the correct BtbN static
  build for each target automatically; confirmed both binaries are the
  right architecture inside each image (`file` on the extracted binary
  matches the target arch, and each image's own `node -e
  "console.log(process.arch)"` reports the expected `x64`/`arm64`).

In short: this repo's stated native-module policy ("pure-JS or prebuilt
binaries only — no node-gyp at install time", docs/PLAN.md §9.2) held up
completely under a real multi-arch build. Nothing here needed a
`--platform`-specific Dockerfile branch beyond the one line
(`$TARGETARCH` -> ffmpeg manifest platform key) this Dockerfile already
has for the same reason every other native dependency needed zero
branches: pnpm/npm's own optionalDependencies-per-platform mechanism
handled it.

## 7. Image sizes

Measured via `docker save <tag> | wc -c` (the unambiguous ground-truth —
`docker images`' own SIZE column double-counts shared/attestation layers
inconsistently across single- vs multi-platform local loads and is NOT
what was used for these numbers):

| Platform | Size |
|---|---|
| linux/amd64 | 226,432,000 bytes ≈ **226 MB** (216 MiB) |
| linux/arm64 | 218,462,208 bytes ≈ **218 MB** (208 MiB) |

Final numbers, from the final build against the live tree with every fix
in this document applied (`LOOMBRE_VERSION=0.9.0`, `VCS_REF=cd3a6dd`, via
`installers/docker/build.sh`'s bake targets — a slightly earlier snapshot
run mid-session, before §4c's three extra `dist/` copies existed, measured
225 MB/217 MB; the ~1 MB difference is exactly those three small
packages' compiled output, as expected). The ~8 MB delta between
architectures is consistent with the two vendored
ffmpeg/ffprobe binaries' own per-arch size difference (BtbN's linux-x64
archive is ~125 MB vs linux-arm64's ~107 MB compressed — the extracted
binaries follow the same ratio) plus minor per-arch differences in
sharp/esbuild's native binary sizes; everything else (Node.js runtime
base layer, `node_modules` JS, `apps/*/dist`) is effectively
architecture-size-neutral.

For scale: the two vendored ffmpeg/ffprobe executables alone are
~144.9 MB (ffmpeg) + ~144.7 MB (ffprobe) UNCOMPRESSED on linux-x64 (BtbN's
`-gpl` variant statically links libx264/libx265, which dominates their
size) — meaning **the ffmpeg/ffprobe pair is the single largest
contributor to final image size** by a wide margin; everything else
(Node 24 bookworm-slim base, all of `node_modules`, both apps' compiled
`dist/`, `@loombre/db`/`@loombre/jobs` raw source) is comparatively small.
A future size-reduction pass, if ever warranted, should start there (e.g.
a leaner ffmpeg build without every optional codec BtbN's default `-gpl`
variant enables) — not at the Node/pnpm layer, which is already using the
from-scratch prod-only install this lane's own measurement (§3 above)
confirms is minimal.

Build context transferred to the `pruner` stage (the only stage that does
a full `COPY . .`): **5.27 MB** (a cache-warm rebuild's `[internal] load
build context` step; the cold-cache first build transferred **330.98 MB**
before `.dockerignore` savings could apply — see note below). `du -sh .`
on the full repo directory (uncommitted working tree, before
`.dockerignore` filtering) is ~1.9 GB dominated by `node_modules`
(958 MB) — `.dockerignore` excluding `node_modules/`, `dist/`, `.git/`,
`vendor/`, and the other patterns listed in that file is what gets a
1.9 GB directory down to a 5.27 MB context on a cache-warm build. The one
outlier (330.98 MB on a cold build) reflects Docker's context-transfer
step reading the directory tree structure itself before `.dockerignore`
patterns are fully applied to large already-gitignored-but-present local
directories (e.g. a stale local `dist/`/`.turbo/` from prior `pnpm build`
runs) — confirms `.dockerignore` is doing real, substantial work, not
just documenting intent.

## 8. One-image-vs-two-images decision

Went with **one image, two containers** (`server`/`worker` both run from
the same built image, selected by `command:` in `docker-compose.prod.yml`
— default `CMD` is the server, worker overrides it). Reasoning:

- Every layer above the two apps' own ~small `dist/` directories is
  **identical** between them — same `node_modules` (both depend on
  `@loombre/db`, `@loombre/jobs`, `@loombre/playback-engine`, `@loombre/shared`
  transitively), same vendored ffmpeg/ffprobe (the worker's transcode
  runtime needs them; harmless, tiny relative cost for the server to carry
  too), same base OS layer. A second image would duplicate essentially
  everything except a few hundred KB of compiled JS.
- Solo-maintainer, AGPL-relicense-track project (LICENSE-INTENT.md):
  keeping server and worker permanently in exact version lockstep (one
  tag, one digest, one build, one signature once lane I's cosign step
  lands) removes an entire class of "which worker image goes with which
  server image" operator question that a split would introduce for no
  runtime benefit (nobody scales worker and server independently on the
  Tier-0/Tier-1 hardware this project targets first — docs/PLAN.md §9.1).
- The marginal pull-size saving a split would buy (not re-pulling the
  unused role's `dist/`) is on the order of hundreds of KB against an
  image whose dominant cost is `node_modules` + two vendored ~145 MB
  ffmpeg/ffprobe binaries either way.

Documented as the explicit call this lane's brief asked for, in case a
future lane revisits it once independent worker scaling becomes a real
requirement (Tier-2 "worker scale-out" in docs/PLAN.md §9.1 — post-v1
territory today).

## 9. Verification methodology: a stable snapshot first, live tree at the end

Phase 4 Wave 1 runs many lanes in parallel against this same checkout.
For a meaningful stretch of this lane's session, `packages/jobs/tsconfig.json`
sat mid-edit on disk (uncommitted, another lane's WIP) with `"extends":
"./tsconfig.base.json"` pointing at a file that did not exist yet at that
path — a genuine, reproducible build break, unrelated to anything this
lane owns or touched (`packages/` is frozen for this lane). It did not
resolve within a 10-minute watch.

Rather than either blocking indefinitely on someone else's in-progress
edit or reporting a false "Dockerfile is broken" finding, the FIRST
round of build/buildx/smoke-test verification in this document was run
against a **snapshot**: `git archive` of the last clean commit (`34979cb`,
STATE.md-verified `pnpm gate` ALL STEPS PASSED at that point) with this
lane's own new files copied in, plus the two specific files this lane's
Dockerfile depends on from lane I1's concurrently-landing work
(`installers/ffmpeg-manifest.json`, `scripts/fetch-ffmpeg.mjs` — both
already complete and stable by the time this lane needed them, verified
independently in §1). That snapshot round is what §6/§7's FIRST set of
numbers (since superseded — see below) and the bake mechanics were
proven against.

Once `packages/jobs/tsconfig.json` settled on its own (no action taken by
this lane), verification moved to the **live working tree** for the rest
of the session, and stayed there — this is the methodology that actually
matters for the final state of this lane's deliverables. Re-running
`node installers/docker/smoke.mjs` against the live tree surfaced three
MORE real, currently-existing integration gaps as other lanes' features
landed mid-session (§4b, §4c) — each fixed for real in this Dockerfile,
not worked around. The **final** `installers/docker/smoke.mjs` run in
this session (build → up → both healthchecks → real migrate+seed
one-shot → login → catalog GET → worker SIGTERM clean-shutdown assertion
→ `down -v` cleanup) went fully green **against the live tree**, and the
final multi-arch buildx run (§6/§7's reported numbers) was likewise
against the live tree at `VCS_REF=cd3a6dd` with `LOOMBRE_VERSION=0.9.0`.

**One remaining environmental flakiness, not a Dockerfile defect:** the
final round of amd64 buildx rebuilds hit intermittent
`[Internal errors encountered: error with cache: Failed to replay logs:
Cannot write logs: failed to create directory '.../.turbo']` failures —
turbo (a Rust binary) failing to create its own log directory with
`Interrupted system call` (EINTR), under QEMU user-mode emulation, under
concurrent host load from other Wave-1 lanes' own simultaneous Docker
activity. This is a transient QEMU/turbo interaction (Rust's directory-
creation call not retrying on EINTR under heavy signal-delivery load
while emulated — not specific to this repo or this Dockerfile), and
resolved on retry / did not affect the native `linux/arm64` builds at
all. The reported §7 sizes are from a run that completed clean for both
architectures; flagged here in case lane I's CI pipeline builds amd64
under QEMU on a shared/loaded runner and hits the same thing — a retry
(or `--platform=linux/amd64` on a REAL amd64 runner, avoiding emulation
entirely, which GitHub Actions' `ubuntu-latest` provides natively) is the
practical mitigation, not a Dockerfile change.

This lane's own files (`Dockerfile`, `.dockerignore`,
`docker-compose.prod.yml`, `installers/docker/**`,
`docs/install/docker.md`) are complete, were not the cause of any of the
transient failures recorded above, and are verified green against the
live tree as of this session's end.
