# macOS installer — filesystem layout & rationale

Lane I4, Phase 4 Wave 1. This document is the "decide and document the
layout properly" deliverable referenced in the lane brief. Every path below
is load-bearing for `pkg/postinstall`, the three LaunchDaemon plists, and
`build-pkg.mjs` — if you change one, change all of them plus this file in
the same commit.

## Summary table

| What | Where | Owner (uid:gid) | Mode |
|------|-------|------------------|------|
| Node runtime + server/worker dist + web standalone + bundled ffmpeg + embedded-PG | `/opt/loombre/<version>/` (symlinked from `/opt/loombre/current`) | `root:wheel` (read-only payload) | `0755` dirs, `0755` executables |
| Menubar controller app | `/Applications/Loombre.app` | `root:wheel` | `0755` |
| App-data ROOT (holds the IPC discovery/token files at its top level — see §4) | `/Library/Application Support/Loombre/` | `_loombre:admin` (completeness audit: group `admin` so the console user's menubar can TRAVERSE to the 0640 group-admin IPC files; root dir only, never `-R`) | `0750` |
| App-data subtrees created by postinstall (`db/`, `config/`, `ipc/`) | `/Library/Application Support/Loombre/{db,config,ipc}` | `_loombre:_loombre` | `0750` |
| Secrets (P4.7 file0600 SecretRef fallback dir) | `/Library/Application Support/Loombre/secrets/` | `_loombre:_loombre` | `0700` — never loosened |
| Embedded-PG subtree (created by the SERVER at first boot, not postinstall) | `/Library/Application Support/Loombre/postgres/` | `_loombre:_loombre` | initdb-enforced `0700` on `postgres/data`, `superuser.secret` file0600 — never loosened |
| Logs | `/Library/Logs/Loombre/` | `_loombre:_loombre` | `0755` (dir), `0644` (files, so `tail`/Console.app work for an admin without sudo) |
| LaunchDaemons (three since the completeness audit) | `/Library/LaunchDaemons/com.loombre.server.plist`, `com.loombre.worker.plist`, `com.loombre.web.plist` | `root:wheel` | `0644` |
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
  bin/loombre-web             # thin shim: exec runtime/node against web/apps/web/server.js
                              # (completeness audit — see §11 for the whole web story)
  runtime/node/bin/node      # bundled Node (fetch-node.mjs), pinned to .nvmrc's major
  runtime/ffmpeg/{ffmpeg,ffprobe}   # bundled ffmpeg (fetch-ffmpeg.mjs / placeholder)
  runtime/pg/...             # embedded-PG, vendor-layout shape (fetch-embedded-pg.mjs)
  server/{dist,node_modules,package.json}  # `pnpm deploy` output for @loombre/server,
                              # pruned to exactly these three (no src/test/*.turbo —
                              # see §9, "self-contained pnpm-deploy output, not a
                              # dist-only copy: two workspace deps ship no
                              # dist/ at all")
  worker/{dist,node_modules,package.json}  # same, for @loombre/worker
  web/                       # apps/web's Next `output: "standalone"` tree, monorepo
    apps/web/server.js       # layout — plus .next/static + public overlaid at
    apps/web/.next/static    # stage time (Next's standalone contract leaves both
    apps/web/public          # to the deployer). See build-pkg.mjs stageWeb() + §11.
    node_modules/            # standalone-pruned deps (contains RELATIVE symlinks —
                             # copied verbatimSymlinks, same rationale as server/)
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
/Library/Application Support/Loombre/          # ROOT: _loombre:admin 0750 (see §4 —
  controller-ipc.json                          #   the IPC discovery + token files
  controller-ipc.token                         #   live HERE, at the root, 0640
                                               #   group-admin, written by the server
                                               #   at every boot per the FROZEN
                                               #   transport.ts wording "under the
                                               #   platform app-data dir")
  postgres/    # embedded-PG subtree, created by the SERVER at first boot
               # (apps/server/src/bootstrap/provisioning.ts): postgres/data
               # (initdb-enforced 0700) + postgres/superuser.secret (file0600).
               # postinstall never creates or loosens this — _loombre-only.
  db/          # VESTIGIAL (completeness audit finding): postinstall still
               # creates it, but the provisioner actually uses postgres/
               # above — kept for now so upgrades don't delete anything,
               # candidate for removal once confirmed nothing references it
  config/      # loombre.env (seeded once by postinstall, upgrade-surviving)
  secrets/     # file0600 SecretRef backend fallback (P4.7) — 0700, _loombre-owned
  ipc/         # VESTIGIAL (was "RESERVED for discovery+token files"): the
               # real IPC implementation landed the files at the ROOT (see
               # above + §4) per transport.ts's literal wording; the menubar
               # was fixed to read the root accordingly. Left in place,
               # harmless, candidate for removal
```

## 3. LaunchDaemon, not LaunchAgent — and why that matters for `_loombre`

A **LaunchAgent** runs inside a logged-in user's session (`gui/<uid>`
domain) and is gated on loginwindow; it stops when that user logs out. A
**LaunchDaemon** runs in the `system` domain, starts at boot before any
login, and keeps running through logout/user-switch. Per the mission
statement ("a media server serves while logged out") this is not a close
call — server + worker MUST be LaunchDaemons. The web UI daemon
(`com.loombre.web`, added by the completeness audit — §11) follows for the
same reason: the UI must be reachable from another device on the LAN with
nobody logged in at the Mac's console.

All three daemons run as the dedicated `_loombre` system account (created by
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

## 4. IPC token-file permissions — formerly a "known gap", now RESOLVED

**RESOLUTION (installer completeness audit)** — the tension documented
below was settled by a recorded orchestrator decision (see
`apps/server/src/ipc/env.ts` + `posix-permissions.ts`): discovery + token
files are written **0640 with the file GROUP set from `LOOMBRE_IPC_GROUP`**
(a deliberate, documented widening from transport.ts's original 0600 —
still no world bits, never wider than group-read). The macOS installer's
half of the contract, implemented across this tree:

1. `bin/loombre-server` exports `LOOMBRE_IPC_GROUP=admin` (overridable in
   `config/loombre.env`) — every interactive macOS admin account is a
   member of group `admin`, and the menubar runs as that console user.
2. The server writes `controller-ipc.json` + `controller-ipc.token` at the
   app-support **ROOT** (`discovery-files.ts` follows FROZEN transport.ts
   literally: "under the platform app-data dir", no `ipc/` subdirectory —
   the menubar's `AppPaths.swift` was fixed to match) and chowns their
   group to `admin` on every boot.
3. `postinstall` makes the root dir itself `_loombre:admin` `0750` — the
   missing traversal link: group-read on a 0640 file is useless if the
   containing directory can't be entered by that group. Root dir ONLY —
   `postgres/` and `secrets/` stay `_loombre`-only 0700 (see §2's tree).
4. `bin/loombre-server` also exports `LOOMBRE_DATA_DIR` in **both**
   database modes (it used to be embedded-mode-only, which silently
   disabled the entire IPC listener for external-PG operators —
   `env.ts` gates the listener on `LOOMBRE_DATA_DIR` being set).

Non-admin console users cannot read the token (fails closed). The
historical analysis below is kept because it explains WHY the naive 0600
design could never work and what the alternatives were:

`packages/controller-ipc/src/transport.ts` originally said: the
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
         --component-plist build/component-plist.plist \
         build/loombre-component.pkg
productbuild --distribution build/Distribution.xml \
             --package-path build/ --resources pkg/resources \
             dist/loombre-<version>-macos-<arch>.pkg
```

**`--component-plist` is load-bearing — the rc.6 relocation field bug**
("install successful, app never launches or appears in Applications").
Without it, pkgbuild's automatic component analysis marks
`Applications/Loombre.app` `BundleIsRelocatable=true` (a `<relocate>`
entry in the shipped PackageInfo), and PackageKit then resolves the
bundle's install destination by asking LaunchServices/Spotlight for an
**existing** copy of `com.loombre.menubar` anywhere on the target volume
— installing over *that* instead of `/Applications`. Observed live in
`/var/log/install.log` (2026-08-08): the staged payload copy under this
very lane's `.build-cache/` swallowed four consecutive installs, while
Installer reported success and the LaunchAgent's hardcoded
`/Applications/...` path spawned nothing. Any stray copy (a build tree,
`~/Downloads`, the Trash) hijacks installs the same way — and each hijack
re-registers the stray with LaunchServices, cementing it as the next
target. `renderComponentPlist()` (build-pkg.mjs) pins the bundle
non-relocatable, with version-checking off (rc-suffixed versions don't
compare reliably; the payload is authoritative — preinstall boots the
running app out first). Guarded twice: `pkg/component-plist.test.mjs`
round-trips the plist through the real pkgbuild (gate,
`installers:test`), and `smoke.mjs` asserts the built artifact's
PackageInfo lists no relocatable bundles.

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
  **SUPERSEDED — that fuller integration has since landed**: the payload
  stages embedded-PG vendor-layout-shaped
  (`runtime/pg/<platform>/<version>` — see `build-pkg.mjs`
  `fetchRuntimes()`), `bin/loombre-server` no longer defaults
  `DATABASE_URL` (unset = the server's own bootstrap provisions +
  supervises the bundled PostgreSQL under the app-data dir's `postgres/`
  subtree, auto-migrating at boot), and external PG remains the
  one-env-var `DATABASE_URL` override in `config/loombre.env`.
  **`smoke.mjs` updated to match (AUD-A5b-006)**: the local smoke test's
  own server-boot check above (`loombre_i4` on 5442) covered only the
  external-PG path even after this landed — a regression in the embedded
  branch above would have passed that check cleanly. `smoke.mjs` now runs
  a second server-boot scenario with `DATABASE_URL` unset and a scratch
  `LOOMBRE_DATA_DIR`, asserting `/healthz` AND that a real `postgres/data`
  directory got provisioned — the out-of-the-box default now has its own
  local coverage, not just the CI release job's sudo-installer smoke.

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

## 11. Web UI serving (installer completeness audit — the third daemon)

The rc payloads shipped **no web UI at all**: server + worker were staged
and daemonized, but nothing built or served `apps/web` (the readme even
pointed users at `http://localhost:3001`, which is the API). STATE.md's
"web-serving architecture unresolved for installed deployments" Open item
was since resolved upstream — `apps/web/next.config.mjs` sets
`output: "standalone"` precisely so installers can run the web app as its
own Node service — and this installer now completes its half:

- **Build**: `build-pkg.mjs` `buildWorkspace()` runs a direct
  `npx next build --webpack` (cwd `apps/web`; same never-`pnpm run`
  rationale as every tsc call there). Standalone output is monorepo-shaped:
  `<standalone>/apps/web/server.js` + `<standalone>/node_modules`.
- **Stage** (`stageWeb()`): copy the standalone root to
  `<version>/web/`, then overlay `apps/web/.next/static` and
  `apps/web/public` — Next's standalone contract deliberately leaves both
  to the deployer. All copies use `verbatimSymlinks: true`; the standalone
  tree really does contain relative pnpm-style symlinks (measured: 22),
  so the default's absolute-path rewrite would reproduce the §1/rc.1
  `ERR_MODULE_NOT_FOUND` failure class.
- **Run**: `com.loombre.web.plist` (LaunchDaemon, `_loombre`, logs
  `/Library/Logs/Loombre/web.{out,err}.log`) → `bin/loombre-web` →
  bundled node against `web/apps/web/server.js`, `NODE_ENV=production`,
  `HOSTNAME=0.0.0.0`, port 3000.
- **PORT namespacing (deliberate, documented in all three places)**: all
  three shims source the same `config/loombre.env`, and BOTH the API
  server and Next's standalone server read a bare `PORT`. A bare `PORT`
  in `loombre.env` is therefore defined to be the **SERVER's** (3001);
  the web UI's is the namespaced `LOOMBRE_WEB_PORT` (3000), mapped onto
  `PORT` only inside `bin/loombre-web`, after sourcing.
- **Cross-service wiring**: `bin/loombre-server` exports
  `LOOMBRE_WEB_URL=http://localhost:3000` (menubar "Open Web UI" target —
  `apps/server/src/ipc/web-url.ts` would otherwise fall back to the API's
  own origin); `bin/loombre-web` exports
  `LOOMBRE_SERVER_ORIGIN=http://localhost:3001` (the web app's CSP/API
  pairing). LAN access needs `LOOMBRE_CORS_ORIGINS` (the API's allowlist
  defaults to localhost:3000 only) + `LOOMBRE_SERVER_ORIGIN` set in
  `loombre.env` — the seeded file documents both.
- **Upgrade/uninstall**: `preinstall` boots out all three labels;
  `postinstall` bootstraps all three; the homebrew cask's
  `uninstall launchctl:` stanza must list `com.loombre.web` too (cask is
  outside this audit's file ownership — flagged in its report).
