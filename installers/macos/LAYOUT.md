# macOS installer — filesystem layout & rationale

Lane I4, Phase 4 Wave 1. This document is the "decide and document the
layout properly" deliverable referenced in the lane brief. Every path below
is load-bearing for `pkg/postinstall`, the two LaunchDaemon plists, and
`build-pkg.mjs` — if you change one, change all three plus this file in the
same commit.

## Summary table

| What | Where | Owner (uid:gid) | Mode |
|------|-------|------------------|------|
| Node runtime + server/worker dist + bundled ffmpeg (+ future embedded-PG) | `/opt/loombre/<version>/` (symlinked from `/opt/loombre/current`) | `root:wheel` (read-only payload) | `0755` dirs, `0755` executables |
| Menubar controller app | `/Applications/Loombre.app` | `root:wheel` | `0755` |
| App-data (embedded-PG data dir, config, secrets, future IPC discovery/token files) | `/Library/Application Support/Loombre/` | `_loombre:_loombre` | `0750` |
| Logs | `/Library/Logs/Loombre/` | `_loombre:_loombre` | `0755` (dir), `0644` (files, so `tail`/Console.app work for an admin without sudo) |
| LaunchDaemons | `/Library/LaunchDaemons/com.loombre.server.plist`, `com.loombre.worker.plist` | `root:wheel` | `0644` |
| Service account | `_loombre` (system, UID < 500, `dsAttrTypeStandard:UniqueID` auto-picked in the system range) | — | — |

## 1. Binaries: `/opt/loombre`, not `/usr/local/loombre`

Both are outside SIP's protected set — Apple's own SIP documentation
explicitly carves `/usr/local` out specifically so third-party Unix-style
installers keep working, and `/opt` was never inside the protected set to
begin with. **SIP is therefore not the deciding factor here**; picking
`/opt/loombre` over `/usr/local/loombre` is a Homebrew-hygiene decision, not a
SIP one, and this doc says so plainly rather than reaching for a SIP
justification that doesn't actually distinguish the two paths.

The real reason: **on Intel Macs, Homebrew *is* `/usr/local`** — it owns
`/usr/local/bin`, `/usr/local/lib`, etc. via symlinks from its Cellar, and
`brew doctor`/`brew cleanup` actively warn about and can offer to remove
files under `/usr/local` that Homebrew doesn't recognize as its own. Loombre
ships a Homebrew **cask** (`installers/macos/homebrew/loombre.rb`) that wraps
this very `.pkg`, so the two distribution channels are used by overlapping
users — dropping `Loombre.app`-adjacent binaries into a directory tree
Homebrew considers its own turf on Intel is exactly the kind of friction
that produces "why does `brew doctor` complain about my media server"
support requests. `/opt/loombre` is a directory Homebrew never touches on
either architecture (it is not `/opt/homebrew`, and MacPorts' historical use
of `/opt/local` is a different leaf entirely), so Loombre gets a directory
tree it owns outright, on both Intel and Apple Silicon, with zero identical
naming collision with either package manager's own prefix.

Layout inside `/opt/loombre/<version>/`:
```
/opt/loombre/<version>/
  bin/loombre-server          # thin shim: exec runtime/node against server/dist/main.js
  bin/loombre-worker          # thin shim: exec runtime/node against worker/dist/index.js
  runtime/node/bin/node      # bundled Node (fetch-node.mjs), pinned to .nvmrc's major
  runtime/ffmpeg/{ffmpeg,ffprobe}   # bundled ffmpeg (fetch-ffmpeg.mjs / placeholder)
  runtime/pg/...             # embedded-PG placeholder (fetch-embedded-pg.mjs, lane B)
  server/{dist,node_modules,package.json}  # `pnpm deploy` output for @loombre/server,
                              # pruned to exactly these three (no src/test/*.turbo —
                              # see §9, "self-contained pnpm-deploy output, not a
                              # dist-only copy: two workspace deps ship no
                              # dist/ at all")
  worker/{dist,node_modules,package.json}  # same, for @loombre/worker
  VERSION                    # plain-text version stamp (see §5)
/opt/loombre/current -> <version>   # atomic upgrade swap point; LaunchDaemons
                                    # reference `current`, never a version dir,
                                    # so an upgrade = write new version dir +
                                    # swap symlink + restart daemons (no plist
                                    # edits needed on upgrade)
```

## 2. App-data: `/Library/Application Support/Loombre`, not `~/Library/...`

The lane brief is explicit: "a media server serves while logged out." A
per-user `~/Library/Application Support` directory is only reachable while
that user is logged in (and on a shared/headless Mac, there may be no
console user at all — the common homelab pattern of a Mac mini/Studio that
boots straight to loginwindow with nobody signed in). System-scope
`/Library/Application Support/Loombre`, owned by the dedicated `_loombre`
service account and readable/writable independent of any login session, is
the only location consistent with the LaunchDaemon posture chosen below.

```
/Library/Application Support/Loombre/
  db/          # ProvisioningRequest.dataDir target (embedded PG data dir, P4.2)
  config/      # future instance config (not populated by this lane)
  secrets/     # file0600 SecretRef backend fallback (P4.7) — 0700, _loombre-owned
  ipc/         # RESERVED for @loombre/controller-ipc's discovery+token files —
               # see §4, "known gap" — created empty by postinstall, not yet
               # written to by anything in this tree
```

## 3. LaunchDaemon, not LaunchAgent — and why that matters for `_loombre`

A **LaunchAgent** runs inside a logged-in user's session (`gui/<uid>`
domain) and is gated on loginwindow; it stops when that user logs out. A
**LaunchDaemon** runs in the `system` domain, starts at boot before any
login, and keeps running through logout/user-switch. Per the mission
statement ("a media server serves while logged out") this is not a close
call — server + worker MUST be LaunchDaemons.

Both daemons run as the dedicated `_loombre` system account (created by
`pkg/scripts/postinstall` via `sysadminctl -addUser`, `UniqueID` picked
automatically in the system range, `UserShell /usr/bin/false`,
`NFSHomeDirectory /var/empty` — the standard macOS "hidden service account"
recipe, e.g. `_postgres`, `_www`). Least-privilege: the daemons never run
as root, and a compromised transcode (an external `ffmpeg` process fed
attacker-controlled media, arguably the single highest-risk process Loombre
ever runs) is confined to whatever `_loombre` can reach — the app-data tree
and the media library paths the operator configures, nothing else.

```
KeepAlive          -> true (restart on crash; RunAtLoad true, boots at startup)
StandardOutPath    -> /Library/Logs/Loombre/server.out.log (worker.out.log)
StandardErrorPath  -> /Library/Logs/Loombre/server.err.log (worker.err.log)
UserName           -> _loombre
WorkingDirectory   -> /opt/loombre/current
EnvironmentVariables -> PORT / DATABASE_URL / LOOMBRE_FFMPEG / LOOMBRE_FFPROBE
                        (P1.18 resolution order: these env vars point straight
                        at the bundled binaries, never PATH lookup, matching
                        "path-isolated from any system ffmpeg" per plan §7.3)
```

## 4. Known gap, logged honestly: controller-ipc's 0600 token vs. a system daemon

`packages/controller-ipc/src/transport.ts` is explicit and FROZEN: the
bearer token file "MUST be created 0600 (owner-read/write only)." Taken
literally, only the file's owning OS user can ever read it via standard
POSIX permission bits — group bits are irrelevant at `0600` regardless of
group membership.

If a future IPC-serving process runs as `_loombre` and writes that token as
`_loombre:_loombre 0600`, an interactive admin's menubar app (which runs as
*that person's own account*, not `_loombre`) is **structurally unable** to
read it. This is not a bug I introduced and not one I can silently paper
over by loosening a FROZEN file's permission literal — the mission's own
rule ("needed change = STOP + report") applies to exactly this kind of
tension, and it is a genuine open design question rather than an installer
detail:

- No `@loombre/controller-ipc` **server-side implementation** exists
  anywhere in the tree yet (the package is "types + JSON-schema fixtures
  only — no I/O, no implementation" per its own `package.json`
  description, and no lane in the current wave lists implementing the
  actual `/ipc/v1/*` HTTP listener in its scope). This lane therefore has
  no live counterpart to integration-test against, and correctly so — it
  is out of scope here.
- `ipc/` is created by postinstall as an empty, correctly-owned directory
  and reserved for that future implementation. This lane does **not**
  fabricate a placeholder writer, because inventing file-ownership behavior
  now risks conflicting with whatever the future implementation actually
  decides (root-owned agent process that `chown`s the token to the current
  console user on each write; a completely different multi-user story;
  etc.) — a guess baked into a postinstall script is worse than no guess.
- **Flagged for whichever lane builds the real IPC server** (see report to
  orchestrator): the token file's *owner* needs to be resolvable to
  "whoever is at the console right now," which requires either (a) the IPC
  listener itself running with enough privilege to `chown` the token file
  per console-user change (e.g., a small `root`-owned control-agent
  LaunchDaemon distinct from the `_loombre` server/worker daemons — it
  already needs elevated privilege anyway, since "Start/Stop server" per
  the mission means calling `launchctl bootstrap`/`bootout` on system
  daemons, which requires root), or (b) a v2 transport (the package's own
  header comment already names Unix-domain-socket as the documented
  upgrade path, with normal socket-file group permissions instead of a
  single-owner-only token file).

This lane's menubar client (§ menubar below) is built and tested against
the **contract's fixture values**, independent of this open question — see
`installers/macos/menubar/`'s own notes for exactly what is and isn't
proven without a live counterpart.

## 5. Version stamping (interim, until lane I lands P4.11)

STATE.md P4.11 assigns single-source version stamping (root
`package.json` → build-time injection → `/system/info` + `loombre --version`
+ release manifest all reading one value) to lane I (release pipeline);
it has not landed as of this lane's work. `build-pkg.mjs` reads the root
`package.json`'s `"version"` field directly today (currently `0.0.1`) —
the same file P4.11 designates as the eventual single source — so nothing
here needs to change when lane I's build-time injection lands; this lane's
reader just starts seeing the injected value instead of the raw
`package.json` literal.

## 6. Distribution — `pkgbuild` + `productbuild`, one payload root

`build-pkg.mjs` stages one payload directory that mirrors the *absolute*
on-disk tree (`payload/opt/...`, `payload/Library/...`,
`payload/Applications/...`) and runs:

```
pkgbuild --root payload --scripts pkg/scripts --identifier com.loombre.pkg \
         --version <version> --install-location / --ownership recommended \
         build/loombre-component.pkg
productbuild --distribution build/Distribution.xml \
             --package-path build/ --resources pkg/resources \
             dist/loombre-<version>-macos-<arch>.pkg
```

One component today (no optional choices) — `productbuild` is still used
(not bare `pkgbuild` output) so the installer gets Apple's standard
Installer.app welcome/README/license panes and so future optional
components (e.g., "install Homebrew shell completions") are an additive
`<choice>` in `Distribution.xml`, not a rebuild of the whole pipeline.

## 7. `installers/sign-hook.mjs` — referenced, not owned (LANDED mid-lane)

Per the mission, `installers/sign-hook.mjs` (repo root, one level above
`installers/macos/`) is lane I1's deliverable — a shared no-op signing hook
every platform's build script calls at the end. It landed partway through
this lane's own development (this repo runs several Phase 4 lanes
concurrently against the same checkout — see §9's build-system-discovery
entries for more on that). Real shape: `signHook(artifactPath) ->
{ signed: false, reason }` (also invocable as `node installers/sign-hook.mjs
<artifact>` per its own header; `build-pkg.mjs` calls it in-process
instead, equivalent). This lane's original placeholder guessed a different
object-arg shape (`signArtifact({ filePath, platform, arch, kind })`) —
`build-pkg.mjs` now calls the real export directly. A defensive fallback
(inline no-op, logged) remains for the case where the file is absent again
in a future rerun of this script against an older checkout.

## 8. Two fetch scripts — landed mid-lane, now wired for real

Both `scripts/fetch-ffmpeg.mjs` (lane I1) and `scripts/fetch-embedded-pg.mjs`
(lane B) landed partway through this lane's development (concurrent-lane
checkout, see §9). `pkg/fetch-ffmpeg.mjs` / `pkg/fetch-embedded-pg.mjs`
call the real scripts and stage their real output into the payload; a
placeholder fallback (host ffmpeg copy / `PLACEHOLDER.txt` sentinel) is
kept for resilience against a future rerun on an older checkout where
either script is absent, but is not what a normal build exercises today.

- **ffmpeg**: `scripts/fetch-ffmpeg.mjs` is CLI-only (no programmatic
  fetch function — only its pure helpers are exported, by its own
  design). `pkg/fetch-ffmpeg.mjs` spawns it exactly as documented
  (`--platform macos-<arch> --vendor-dir vendor/ffmpeg`), then reads the
  `PROVENANCE.json` it writes to locate the vendored `ffmpeg`/`ffprobe`
  binaries and copies them into `runtime/ffmpeg/`. **Real, verified pin in
  use**: osxexperts.net's `ffmpeg81arm.zip`/`ffprobe81arm.zip` (GPL,
  `--enable-gpl --enable-libx264 --enable-libx265`, no `--enable-version3`
  → GPL-2.0-or-later per FFmpeg's own convention). **Flagged security
  caution, addressed to this lane by installers/ffmpeg-manifest.json's own
  `macos-arm64` entry and NOT fully resolved here**: the sha256 the
  manifest pins (and that `fetch-ffmpeg.mjs` correctly verifies bytes
  against — tampering after lane I1's own fetch is still caught) does
  **not** match the checksum osxexperts.net prints on its own webpage for
  the same URL. `pkg/fetch-ffmpeg.mjs` performs the one further check
  available in this lane's scope — confirming the fetched binary's own
  `ffmpeg -version` banner is internally consistent with the manifest's
  license claim (it is: gpl+libx264+libx265, no version3) — and prints the
  result loudly, but this does **not** independently re-verify against a
  second source. **This is a real, unresolved supply-chain caution for the
  owner / Wave 3 to decide on before any public release build** (re-check
  the live page, self-build from osxexperts' published script, or
  substitute a source with a verifiable checksum trail like BtbN/evermeet).
- **embedded PostgreSQL**: `scripts/fetch-embedded-pg.mjs` exports a real
  `fetchEmbeddedPg({ platform, vendorDir })` used the same way its own
  integration tests use it. `pkg/fetch-embedded-pg.mjs` calls it directly
  (pinned PostgreSQL 18.4.0, matching D1/`PROVISIONING_REQUEST_MIN_PG_MAJOR`)
  and copies the vendored `bin/lib/share` tree into `runtime/pg/` — proving
  the fetch + `packages/provisioning-pg` vendor-layout contract resolve
  correctly end to end. **Scope boundary, unchanged from the original
  placeholder plan**: this does NOT wire a running embedded-PG instance
  into the LaunchDaemon lifecycle (constructing a real
  `ProvisioningRequest`, supervising `initdb`/`postmaster` as a child of
  the server process, and the associated postinstall/plist changes are a
  separate, larger integration). The shipped LaunchDaemons stay on the
  **external-PG path** (D1) — exactly what this lane's mandated local
  smoke test exercises (`loombre_i4` on 5442) — with the vendored binaries
  staged and ready for whichever lane does that fuller integration.

## 9. Two build-system discoveries, worked around here, flagged for lane I

Neither `packages/db` nor `packages/jobs` ships compiled `dist/` via its
`package.json` `"exports"` — both point straight at `./src/index.ts`
(raw TypeScript), unlike every sibling package (`shared`, `playback-engine`,
`sdk`), which point at `./dist/index.js`. Inside the monorepo this is
invisible: pnpm workspace-links these as symlinks, and `tsx`/dev-mode Node
transpiles TS on the fly. It breaks the instant a package is materialized
as a *real*, non-symlinked `node_modules` entry — which is exactly what a
production install is — because Node 22+/24 refuses to strip TypeScript
syntax for any file whose resolved path sits inside a `node_modules`
directory (a deliberate perf/security boundary, not a bug):
`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`.

Separately, `apps/server`'s `ajv` (used at RUNTIME by
`common/device-profile-validator.js` for P2.3's DeviceProfile validation)
is declared under `devDependencies`, not `dependencies` — invisible in dev
(all deps are installed regardless of category) and invisible in every
existing test suite, but a `--prod`-only install/deploy omits it entirely,
producing `ERR_MODULE_NOT_FOUND` for `ajv` at server boot.

**Neither is this lane's to fix** (`packages/db`/`packages/jobs`/
`apps/server` are outside `installers/macos/**`, and moving a dep between
`dependencies`/`devDependencies` touches `pnpm-lock.yaml` — LOCKFILE
FROZEN this wave). `build-pkg.mjs` works around both, scoped entirely to
its own build output:
1. Runs a plain `tsc -p packages/{db,jobs}/tsconfig.json` before deploying
   (both already have `outDir: dist` configured — just no `build` script
   wired to it at the package level) — populates the *already-gitignored*
   `dist/` those packages' own `tsconfig.json` targets, then rewrites the
   **deployed copy's** `package.json` `"exports"` to point at `dist/`.
2. Vendors `ajv` (+ its 4 resolved transitive deps, byte-identical to the
   ones already resolved in `pnpm-lock.yaml` for `apps/server`'s
   `devDependencies` entry — not a fresh/unpinned fetch) into the server
   deploy's `node_modules`.

**Real recommendation for lane I / whoever owns the release pipeline**:
promote `ajv` to `apps/server`'s `dependencies`, and give `packages/db` +
`packages/jobs` a `build` script + dist-pointing `exports` matching their
siblings — small, mechanical, low-risk fixes that make every platform
lane's packaging (not just macOS) simpler, since none of this is
macOS-specific.

## 10. A third build-system discovery: a documented lockfile-freeze workaround needs packaging awareness

`apps/server/src/common/update-check/release-manifest-import.ts` (landed
mid-lane, lane I) reaches `@loombre/release-manifest` (FROZEN, Wave 0) by a
hardcoded relative import (`../../../../../packages/release-manifest/dist/
index.js`, 5 levels up from `apps/server/{src,dist}/common/update-check/`
to repo root) rather than a normal workspace `dependencies` entry — its own
header explains why: this wave's LOCKFILE FROZEN rule (lane F is sole
lockfile owner) means adding a real `"@loombre/release-manifest":
"workspace:*"` dependency isn't available to lane I right now, and the
file's header already names the correct follow-up once the freeze lifts
(add the dependency, delete this file). This is a well-reasoned, deliberate
interim tradeoff, not a bug — but it has a real packaging-time
consequence: a `pnpm deploy` output does not preserve the monorepo's
directory depth, so the relative import silently resolves to nowhere once
deployed (`ERR_MODULE_NOT_FOUND` at server boot, caught by this lane's own
smoke test). `build-pkg.mjs` stages `packages/release-manifest/dist` at
the exact depth that import expects — one level ABOVE the version dir,
i.e. `/opt/loombre/packages/release-manifest/dist/`, NOT inside
`/opt/loombre/<version>/` — purely a packaging-side accommodation, no
apps/server source touched. Flagged for lane I as a heads-up: whichever
lane packages Linux/Windows will hit the identical resolution failure and
need the same accommodation (or, better, land the real dependency once the
freeze lifts, which removes the need for any of this).

**Sharp footgun, encountered and worked around identically**: while
patching a hardlinked `pnpm deploy` output file in place (a `package.json`
`"exports"` rewrite, item 1 above) during this lane's own development,
a plain `fs.writeFileSync` **mutated the real checked-out
`packages/db/package.json` in the live git working tree** — `pnpm deploy
--legacy` hardlinks (not symlinks, not copies) files cloned from its
content-addressable store for `file:`/workspace-protocol dependencies on
this filesystem, so editing "the deploy's copy" in place silently edits
the same inode as the source. **This lane's mistaken edit was caught and
reverted** (`git checkout -- packages/db/package.json
packages/jobs/package.json`) without touching any other lane's concurrent
in-flight changes to those same directories. `build-pkg.mjs` never edits a
`pnpm deploy` output file in place again — it always `unlink`s first (a
fresh inode) before writing. **Flagged for every other lane whose
packaging script might call `pnpm deploy` against a live, shared,
multi-lane checkout**: this is a real footgun, not a macOS-only one.
