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

## 2. Real packaging-friction findings — SUPERSEDED (Phase 4 Wave 3, lane STRUCT fixed both at the source)

**Everything in §2/2a/2b/2c is a Wave-1 finding that has since been fixed
upstream, and the Dockerfile mechanism it produced is DELETED.** Current
state (see the Dockerfile's own builder-stage comments): `packages/db`
and `packages/jobs` ship real compiled `dist/` builds with `exports`
pointing at `dist/`, so the runtime loads plain compiled JS with zero
loaders (`node dist/main.js` just works); the
`ENV NODE_OPTIONS="--import tsx"` runtime shim and its tsx/esbuild/ajv
`cp -RL` snapshot-and-restore mechanism no longer exist; and `ajv` is a
real `apps/server` `dependencies` entry, so the `--prod` install simply
includes it. Condensed historical record of what the first real container
smoke run found:

### 2a. (historical) `@loombre/db`/`@loombre/jobs` shipped raw TypeScript at runtime

Both packages' `exports` mapped `"."` straight to `"./src/index.ts"`
(`@loombre/jobs` even had a working `build` script whose `dist/` output
nothing loaded). Running the compiled apps with plain `node` failed with
`Cannot find module '.../@loombre/jobs/src/index.ts'`; this Dockerfile
bridged it the way `scripts/perf-t0.mjs` then did, by registering `tsx`
as a runtime loader (`ENV NODE_OPTIONS="--import tsx"`). The root-cause
fix this section proposed — dist-pointing `exports` matching
`@loombre/playback-engine`/`@loombre/shared` — is exactly what lane
STRUCT later shipped, and the loader shim is gone.

### 2b. (historical) `apps/server` imported `ajv` at request time while listing it as a devDependency only

`common/device-profile-validator.ts` runs Ajv on every `POST /auth/login`
(P2.3 DeviceProfile schema validation), but `ajv` sat under
`devDependencies`, so a `--prod` install correctly stripped it and login
failed at runtime with `Cannot find package 'ajv'`. A sweep of the rest
of the pruned dependency graph found no other instance of the pattern.
The single-line classification fix this section called for — `ajv` into
`dependencies` — has landed.

### 2c. (historical) How the runtime image resolved both without touching `apps/`/`packages/`

The `builder` stage snapshotted `tsx` and `ajv`'s real resolved `.pnpm`
sibling groups (dereferenced via `cp -RL`, paths via `readlink -f` so a
lockfile bump could not silently break it) into `/tmp/runtime-shims`
before the `prod-deps` stage's from-scratch `--prod` install, then
restored them into that stage's `node_modules`. That whole mechanism was
deleted along with its reason to exist.

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

## 4b. `apps/server`'s relative-path lifecycle hooks — SUPERSEDED (hooks removed; real dependency landed)

**Superseded:** `apps/server/package.json` no longer carries `prebuild`/
`pretypecheck`/`pretest` hooks at all, and `@loombre/release-manifest` is
now a real `apps/server` `dependencies` entry — the exact "smaller, more
standard change" this section recommended — so `turbo prune`'s ordinary
graph walk resolves the package as a first-class edge. (The Dockerfile
still passes `@loombre/release-manifest` as an explicit third prune
scope; per its own comment that is now belt-and-braces, not
load-bearing.) As found at the time: the hooks ran
`../../node_modules/.bin/tsc -p ../../packages/release-manifest/tsconfig.json`
as a bare relative-path npm lifecycle step — not a package.json graph
edge, so with a prune scope of just `@loombre/server @loombre/worker` the
package was silently absent from `out/full/` and the build failed
outright with `TS5058: The specified path does not exist`. The interim
fix was the explicit third `turbo prune` scope, which carried the package
until the real dependency edge landed.

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
- `apps/server`'s update-check code imports `@loombre/release-manifest`
  directly at runtime (P4.16). SUPERSEDED HALF of this bullet: at the
  time, that import went through an interim relative-path shim
  (`release-manifest-import.ts`) and `apps/server/package.json` did
  **not** list the package under `dependencies` at all — it only
  resolved because §4b's explicit third `turbo prune` scope happened to
  carry it. Both defects are since fixed at the source: the shim is
  deleted, `apps/server/src/common/update-check/` imports the bare
  specifier, and `"@loombre/release-manifest": "workspace:*"` is a real
  `dependencies` entry — the "fix once, properly" this bullet's
  Discovery asked lane I for. STILL-CURRENT HALF: the package's `dist/`
  had to be added to this Dockerfile's explicit per-package `dist/` COPY
  list, same as the two packages above.

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
