# Linux tarball layout

Produced by `installers/linux/build-tarball.mjs` as
`loombre-<version>-linux-<x64|arm64>.tar.gz`. Extracting it yields a single
top-level directory (`loombre-<version>-linux-<arch>/`) with this shape:

```
loombre-<version>-linux-<arch>/
├── VERSION                     # plain text, exact version string (root package.json's `version`)
├── install.sh                  # see below
├── uninstall.sh
├── loombre.env.template        # the env file install.sh renders to /etc/loombre/loombre.env
│                                 # (the .rpm/.deb render the SAME template — see "Native packages" below)
├── systemd/
│   ├── loombre-server.service.template
│   ├── loombre-worker.service.template
│   └── loombre-web.service.template
├── bin/
│   ├── loombre-server            # wrapper: execs the bundled node against lib/server/dist/main.js;
│   │                               # when DATABASE_URL is unset it also wires the embedded-PG env
│   │                               # (LOOMBRE_EMBEDDED_PG_VENDOR_DIR -> pg/, version derived from the
│   │                               # staged <platform>/<version> dir — mirrors the macOS shim)
│   ├── loombre-worker            # wrapper: execs the bundled node against lib/worker/dist/index.js
│   ├── loombre-web               # wrapper: execs the bundled node against web/apps/web/server.js
│   │                               # (Next standalone; PORT from LOOMBRE_WEB_PORT, default 3000)
│   └── loombre                   # wrapper: execs the bundled node against lib/server/bin/loombre.mjs (the `loombre` CLI —
│                                   # install.sh symlinks /usr/local/bin/loombre -> this file, see below)
├── runtime/
│   └── node/
│       ├── bin/node              # bundled Node runtime (installers/node-manifest.json — pinned + sha256, official nodejs.org build)
│       └── LICENSE               # that build's own LICENSE (MIT plus its bundled V8/OpenSSL/ICU/zlib/libuv texts)
├── ffmpeg/
│   ├── ffmpeg
│   ├── ffprobe
│   └── LICENSE.txt               # the vendored build's own license text (GPL — see installers/ffmpeg-manifest.json's `provenance` block)
├── lib/
│   ├── server/                   # `pnpm --filter @loombre/server deploy --prod` output: dist/, package.json, node_modules/
│   └── worker/                   # same, for @loombre/worker
├── web/                          # apps/web's Next STANDALONE output (monorepo shape: apps/web/server.js +
│   │                               # traced-minimal node_modules/), plus the .next/static and public/ overlays —
│   │                               # ~60 MB and actually runnable via bin/loombre-web (the pre-audit pnpm-deploy
│   │                               # tree was 599 MB with no way to start it). See assembleWebStandalone.
│   └── apps/web/server.js
├── pg/                            # embedded PostgreSQL payload, VENDOR-SHAPED: pg/<platform>/<version>/{bin,lib,share,...}
│   │                               # lib/ additionally carries a vendored libxml2.so.2 (+ LICENSE.libxml2.txt) — see below
│   │                               # — exactly one platform+version pair (the manifest's defaultVersion), the shape
│   │                               # resolveVendorBinaries + bin/loombre-server's derivation expect. include/ headers
│   │                               # excluded. A missing payload FAILS the build (embedded is the DATABASE_URL-unset
│   │                               # default path) — see "Embedded vs external PostgreSQL" below.
│   └── linux-<arch>/<version>/
└── packages/
    └── release-manifest/
        └── dist/                  # apps/server's documented relative-import workaround — see below
```

## Where things come from

| Path | Produced by |
|------|-------------|
| `bin/`, `install.sh`, `uninstall.sh`, `systemd/`, `loombre.env.template`, `VERSION` | this build script, generated/copied directly |
| `runtime/node/` (`bin/node` + `LICENSE`) | `installers/node-manifest.json` — official nodejs.org release, checksum-verified before extraction |
| `ffmpeg/` | `scripts/fetch-ffmpeg.mjs` + `installers/ffmpeg-manifest.json` (shared deliverable, also used by lanes I3/I4) |
| `lib/server/`, `lib/worker/` | `pnpm --filter <app> deploy <dir> --prod --legacy`, then packaging-time-only fixes — see below |
| `web/` | `apps/web/.next/standalone` (Next `output: "standalone"`) + `.next/static` and `public/` overlays + a linux-`<arch>` sharp swap — `assembleWebStandalone` in `build-tarball.mjs` |
| `pg/` | `scripts/fetch-embedded-pg.mjs` at the manifest `defaultVersion`, restaged vendor-shaped (`pg/<platform>/<version>/`); REQUIRED — the build fails without it |
| `pg/<platform>/<version>/lib/libxml2.so.2` (+ `LICENSE.libxml2.txt`) | `scripts/fetch-libxml2.mjs` + `installers/libxml2-manifest.json` — Rocky Linux 9.6's libxml2 rpm (MIT; glibc 2.34 floor, the same as the PostgreSQL binaries), sha256-verified, two files extracted. PostgreSQL links `libxml2.so.2` and its `RUNPATH $ORIGIN/../lib` resolves this copy first; libxml2 2.14 bumped the soname to `.so.16`, and Ubuntu 25.10 / 26.04 LTS ship no `.so.2` at all. Vendoring it makes the embedded database's dependency set identical on every distro and lets the .rpm/.deb derive `liblzma` instead of `libxml2` |
| `packages/release-manifest/dist/` | a copy of the live repo's own already-built `packages/release-manifest/dist/` — see below |

## Packaging-time-only fixes, each discovered by a real smoke or release run

`pnpm deploy --prod` is a mechanically correct isolation primitive, but it
faithfully reproduces whatever the SOURCE package.json files declare —
including a few things that are fine for local dev but break once
actually deployed standalone. All three are fixed here, in the build
script, without editing the source files responsible (all three are
outside this lane's ownership: `apps/`, `packages/`) — see the
corresponding functions' doc comments in `build-tarball.mjs` for the full
story:

1. **`ajv` (apps/server)** — RESOLVED UPSTREAM since: `ajv` is now a
   real `apps/server` `dependencies` entry — exactly the one-line fix
   the Orchestrator TODO here originally asked for. As found: it was
   listed under `devDependencies` while imported at runtime by
   `device-profile-validator.ts`; `--prod` correctly stripped it, so the
   deployed server crashed at boot with `ERR_MODULE_NOT_FOUND('ajv')`.
   `fixServerAjv()` vendored the already-resolved `ajv` package from
   this repo's own pnpm store into the deploy's `node_modules` (not
   `pnpm add`-ed, nothing added to the lockfile); that step still runs
   and is now the harmless no-op its own doc comment predicted — safe to
   leave in place, per that comment.
2. **`sharp` (apps/worker)** — depends on a platform-specific native
   binary package (`@img/sharp-<platform>-<arch>`) that `pnpm deploy`
   can only ever materialize for the CURRENT BUILD HOST (confirmed:
   still resolved `darwin-arm64` even with `pnpm`'s own
   `--config.supportedArchitectures` explicitly set to linux/arm64 —
   optionalDependency resolution always targets the running process, by
   npm/pnpm design, not a configurable target). Fixed by
   `fixWorkerSharp()`: removes the wrong-platform package pnpm installed
   and fetches the correct `@img/sharp-linux-<arch>` +
   `@img/sharp-libvips-linux-<arch>` straight from the npm registry, at
   the EXACT version pnpm-lock.yaml already pins, verifying each
   download's sha512 against that same lockfile's own recorded integrity
   before trusting it. No lockfile edit — the version fetched is READ
   from the lockfile, not chosen here.
3. **`@loombre/release-manifest` relative import (apps/server)** —
   RESOLVED UPSTREAM since: the lockfile freeze lifted,
   `"@loombre/release-manifest": "workspace:*"` is a real `apps/server`
   `dependencies` entry, and the interim `release-manifest-import.ts`
   shim was deleted — precisely the follow-up the Orchestrator TODO here
   originally named. As found: that shim (a deliberate, documented
   workaround from a lockfile-frozen wave) reached
   `packages/release-manifest/dist/index.js` via a relative path assuming
   `apps/server/dist` sat inside the full monorepo layout, which broke
   once `pnpm deploy` isolated apps/server into its own tree.
   `bundleReleaseManifestForServer()` — copying that package's own
   already-built `dist/` to the equivalent relative depth under the
   tarball's root, which `install.sh` copies alongside `bin/`/`lib/`/etc.
   (see its `for entry in ...` payload list) — still runs; with the real
   dependency in place it is redundant but harmless, and retiring it is
   the build-script owner's call.

4. **Platform-specific native bindings resolved for the BUILD HOST, not the
   target** — the class item 2 first exposed for `sharp`, and which two
   more packages turned out to share: `@napi-rs/keyring` (per-platform
   `keyring-<platform>-<libc>` packages; `fixKeyringBinding()` removes the
   build host's and vendors the lockfile-pinned `linux-<arch>-gnu` one)
   and, found by the first v1.0.0-beta.2 release run, `koffi`
   (packages/wg-native's FFI layer; per-platform
   `@koromix/koffi-<platform>-<arch>` packages resolved by koffi as a
   SIBLING scope directory of its own package, not a nested
   node_modules). A macOS-built Linux tarball used to carry only the
   darwin koffi binary. `fixKoffiBinding()` vendors the lockfile-pinned
   `@koromix/koffi-linux-<arch>` next to koffi, removes every other
   platform's entry, and drops the package's `musl_<arch>/` build: koffi
   ships a glibc and a musl addon side by side (chosen at load time by
   the host's ELF interpreter), and a musl-linked ELF is exactly what the
   `.rpm`/`.deb` dependency derivation must never see as a requirement
   (`lib/elf-deps.mjs` also treats such files as foreign — belt and
   braces).

## Why `pnpm deploy` alone is not enough

`pnpm --filter <pkg> deploy <dir> --prod --legacy` isolates the TARGET
package (server, worker, or web) into a real, independent directory —
confirmed by inode comparison against the live `apps/*` source, they are
genuinely different files, not hard links. It does **not**, however,
isolate `"workspace:*"`/`"file:"` **dependencies** resolved inside that
deploy's own `node_modules`: those are hard-linked straight back to the
live `packages/*` source directories. Writing through that path would
mutate the live repository — this was caught during development (see the
safety comment block at the top of `installers/linux/build-tarball.mjs`,
above `buildPrecompiledWorkspaceDep`) and the build script never writes
through a deploy-resolved workspace-dependency path as a result. All
mutation happens in a private staging copy made with an explicit `cp -R`
of only `src/` + `package.json` + `tsconfig.json` (a genuine, non-hard-linked
copy), and a deploy's hard-linked copy is only ever *deleted-and-replaced*
(safe: unlinking a directory entry never touches data other hard links to
the same inode still reference) with the precompiled result.

## Why `@loombre/db`/`@loombre/jobs` are compiled to plain JS for this tarball

HISTORICAL PREMISE, SINCE FIXED UPSTREAM (Phase 4 Wave 3, lane STRUCT):
when this was written, `packages/db` and `packages/jobs` shipped
TypeScript source only (`exports` pointing at `./src/index.ts`), and
every in-repo consumer bridged that at import time via `tsx`'s
esbuild-backed loader. `tsx` is a devDependency (correctly excluded by
`--prod`), and even vendoring it by hand runs into `esbuild`'s
per-platform native binary, which resolves for the **build host** —
wrong when cross-building the Linux tarball from a developer's macOS
machine. Hence this build compiled `@loombre/db` and `@loombre/jobs` to
plain ESM JavaScript itself, once, as a packaging-time-only step. Both
packages now ship real compiled `dist/` builds with dist-pointing
`exports` at the source, so the premise is gone; the packaging-time
compile step still runs (the packages' own source is never touched — see
above) and is now redundant but harmless. Either way the shipped
`bin/loombre-server` and `bin/loombre-worker` need nothing beyond the
bundled Node binary itself: no `tsx`, no `esbuild`, no native binary of
any kind for this part of the stack. Proven end-to-end: a compiled
`apps/worker` `dist/index.js` booting through `@loombre/jobs` →
`@loombre/db` → `kysely` → `pg`, reaching a real `pg-boss` connection
attempt against an intentionally unreachable address (`ECONNREFUSED`) —
i.e. the entire module graph resolves and executes for real; only the
final network hop was pointed at a dead port on purpose, to prove this
without touching any real database (including, deliberately, without
ever defaulting to the shared dev Postgres database other Phase-4 lanes
were using concurrently).

## Bundled Node runtime

Pinned in `installers/node-manifest.json`: Node 24.18.0 ("Krypton" Active LTS),
official nodejs.org prebuilt tarball, sha256-verified against nodejs.org's
own published `SHASUMS256.txt` before extraction. Only `bin/node` itself
is bundled (not `npm`/`npx`/`corepack`/headers/docs) — this tarball ships a
runtime, not a development toolchain.

## Bundled ffmpeg/ffprobe

See `installers/ffmpeg-manifest.json` for exact pinned versions, source
URLs, sha256 checksums, and a `provenance` block explaining the GPL/AGPL
aggregation posture (ffmpeg/ffprobe run as separate child processes,
never linked into any Loombre binary). `LOOMBRE_FFMPEG`/`LOOMBRE_FFPROBE`
env vars (set by `bin/loombre-server`/`bin/loombre-worker`) point at the
bundled binaries; `PATH` also includes `ffmpeg/` as a fallback.

## Embedded vs external PostgreSQL

**Embedded is the out-of-the-box default** (installer completeness audit):
with `DATABASE_URL` unset, `bin/loombre-server` exports
`LOOMBRE_EMBEDDED_PG_VENDOR_DIR=$PREFIX/pg` and derives
`LOOMBRE_EMBEDDED_PG_VERSION` from the single `pg/<platform>/<version>`
pair staged by the build (same wiring as the macOS shim,
`installers/macos/pkg/bin/loombre-server`); apps/server's bootstrap then
provisions the cluster under the data dir, **auto-migrates at every
boot** (`@loombre/db/migrate` ships inside the deploy), and supervises
it. External PostgreSQL (`DATABASE_URL` set — P4.2's "external-PG env var
path", first-class and equally tested) always wins when configured.

Because embedded is the default path, the payload is REQUIRED:
`assemblePg` invokes `scripts/fetch-embedded-pg.mjs` with the manifest's
`defaultVersion` explicitly and HARD-FAILS the build if the vendored
binaries are absent — the old placeholder-README fallback (and the flat
`pg/<version>` shape, and the ship-every-vendored-version bloat) is gone;
see `assemblePg`'s header comment for the audit evidence.

## `bin/loombre-server` / `bin/loombre-worker` / `bin/loombre-web` / `bin/loombre`

Small generated bash wrapper scripts. All four resolve their own
location (`$APP_ROOT`, independent of the caller's cwd or how the tarball
was extracted), set `LOOMBRE_FFMPEG`/`LOOMBRE_FFPROBE`/`PATH` for the
bundled ffmpeg, and `exec` the bundled `runtime/node/bin/node` against
`lib/server/dist/main.js` / `lib/worker/dist/index.js` /
`web/apps/web/server.js` / `lib/server/bin/loombre.mjs` respectively. No
system Node required at any point (docs/PLAN.md §11: "Single Node runtime
bundled per platform (no user-installed Node)").

`bin/loombre-server` additionally wires embedded PostgreSQL when
`DATABASE_URL` is unset (see "Embedded vs external PostgreSQL" above) and
always exports `LOOMBRE_WEB_URL` (default `http://localhost:3000` — where
`bin/loombre-web` serves). `bin/loombre-web` unconditionally overrides
`PORT` from `LOOMBRE_WEB_PORT` (default 3000; the shared env file's
`PORT` belongs to the server) and `HOSTNAME` to `0.0.0.0` (bash pre-sets
`HOSTNAME` to the machine name in every shell — a `:-` default would
silently bind to that), and defaults `LOOMBRE_SERVER_ORIGIN` to
`http://localhost:3001` for apps/web's CSP tightening.

`bin/loombre` (the `loombre` CLI — L2, the H2-recovery invocability fix)
is the one of the three meant to be reached through a SYMLINK once
installed (`install.sh` points `/usr/local/bin/loombre` at it — see
below), so unlike its siblings it resolves its own PHYSICAL path first
(`readlink -f` on `${BASH_SOURCE[0]}`, GNU coreutils, before deriving
`$APP_ROOT`) — the siblings' cheaper `dirname "${BASH_SOURCE[0]}"` idiom
would otherwise resolve to the symlink's own directory
(`/usr/local/bin`), not this file's real location. The siblings are never
symlinked, so they keep that cheaper idiom.

## `install.sh` / `uninstall.sh` / `systemd/`

See those files directly and `docs/install/linux.md` for the operator-
facing walkthrough. Short version: `install.sh` creates a system user
(`loombre` by default), copies this payload to `/opt/loombre` (default,
`--prefix` to change), creates `/var/lib/loombre` (default, `--data-dir`)
as the app-data directory, writes `/etc/loombre/loombre.env` (default,
`--config-dir`) with a documented, commented-out `DATABASE_URL` and other
knobs, places a `/usr/local/bin/loombre` symlink to `$PREFIX/bin/loombre`
(replacing a stale symlink from a prior install/upgrade outright; warning
and continuing — never failing the install — if that path is unwritable
or already occupied by a foreign, non-symlink file), and (unless
`--no-systemd`) installs+enables the three systemd units (server, worker,
web — the web unit's `ReadWritePaths` also covers the Next runtime-cache
dir install.sh pre-creates under `web/apps/web/.next/cache`, the one
writable spot in the otherwise read-only payload). `uninstall.sh`
reverses this — a clean uninstall leaves NO FILES OUTSIDE THE DATA DIR
(app payload, config dir/env file, system user, systemd units, AND the
`/usr/local/bin/loombre` shim are all removed; only the data dir
survives), and `--purge` removes that too. The shim is only ever removed
if it's still a symlink resolving into this install's own `$PREFIX` — a
foreign file, or a symlink pointing at a different install/program
entirely, is left untouched. Both scripts run from wherever the tarball
was extracted — they read the payload from their own directory, not from
a fixed path.

## Native packages (`.rpm` / `.deb`)

`build-rpm.mjs` and `build-deb.mjs` do **not** build anything: each takes an
already built `loombre-<version>-linux-<arch>.tar.gz` as its only input,
stages the payload above under `/opt/loombre` unchanged, renders the
checkout's `systemd/*.service.template` and `loombre.env.template` around
it, derives the package's shared-library requirements from the payload's
own ELF files (`lib/elf-deps.mjs`), and hands the tree to `rpmbuild` /
`dpkg-deb`. One payload, three containers: the tarball, the `.rpm` and the
`.deb` of one version can never disagree. `lib/native-package.mjs`'s header
is the authoritative statement of the design, of every deliberate
difference from the tarball channel, and of the scriptlet lifecycle
summarized below — read it there rather than trusting a second copy here.

Both formats stage the same FHS tree (`assemblePackageRoot`):

```
/opt/loombre/                          # the tarball's payload entries, verbatim:
                                       # bin/ lib/ runtime/ ffmpeg/ web/ pg/ packages/ VERSION
/usr/lib/systemd/system/loombre-{server,worker,web}.service   # rendered units (package-owned)
/usr/lib/sysusers.d/loombre.conf       # systemd-sysusers declaration of the service account
/usr/bin/loombre -> /opt/loombre/bin/loombre                  # the CLI shim (NOT /usr/local)
/usr/share/loombre/loombre.env         # the rendered env-file DEFAULT (see the scriptlets below)
/etc/loombre/                          # package-owned, empty — where the env file lands
/var/lib/loombre/                      # empty, 0750; owned by `loombre` via rpm %attr / dpkg-statoverride
/usr/share/doc/loombre/copyright       # DEP-5 aggregation notice, generated from the payload's
                                       # own npm license inventory + the AGPL/MIT/PostgreSQL texts
/usr/share/doc/loombre/changelog.gz    # .deb only (lintian hygiene; one entry, not CHANGELOG.md)
/usr/share/licenses/loombre/LICENSE    # the AGPL text
```

**What is NOT in a package.** `install.sh`, `uninstall.sh`, `systemd/` and
`loombre.env.template` are tarball-channel files and never ship inside a
package (`TARBALL_ONLY_ENTRIES`) — the package *is* the installer, and its
templates are rendered at package-build time. The writable Next
runtime-cache directory (`/opt/loombre/web/apps/web/.next/cache`, the one
spot the hardened `loombre-web` unit may write to) is not shipped either:
the install scriptlets create it owned by the service user, exactly as
`install.sh` does, and the erase/remove scriptlets delete it — a package
manager never removes a directory holding files it did not ship.

**Scriptlet lifecycle**, one line per moment (rpm `%pre`/`%post`/`%preun`/
`%postun`/`%posttrans`; deb `preinst`/`postinst`/`prerm`/`postrm`):

| Moment | What happens |
|---|---|
| fresh install, before any file lands | refuse if an unpackaged (tarball) Loombre is present; create the `loombre` user/group, adopting an orphaned `/var/lib/loombre` uid |
| fresh install, after unpack | create the Next cache dir; re-own the data dir if a previous install left it under another account; copy `/usr/share/loombre/loombre.env` to `/etc/loombre/loombre.env` **only if absent** (`root:loombre`, 0640); enable the three units (offline-safe, so a chroot-built image boots with them on); start them unless `/etc/loombre/no-autostart` exists or there is no live systemd; warn about a shadowing `/etc/systemd/system` unit copy |
| upgrade | stop-before-unpack: record which units are active in a `/run` marker and stop them; the NEW package's last scriptlet starts exactly those. The env file is never touched |
| erase / remove | stop + disable the units, delete the scriptlet-created cache dir and the now-empty payload chain, keep the data dir, the env file and the user (deb additionally masks the units) |
| purge (deb only) | remove the data dir (unless it is a mount point), the config dir, the statoverrides and the user |

`smoke-packages.mjs` walks every one of those moments inside real
`fedora:44` / `rockylinux:9` / `debian:12` / `ubuntu:24.04` containers;
`native-package.test.mjs` pins the rendered units and env file
byte-identical against `install.sh`'s own `sed` expressions.
