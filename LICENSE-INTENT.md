# Licensing intent & provenance

## Current status

This repository is licensed under the **GNU Affero General Public License
v3.0 (AGPL-3.0-only)** — see the `LICENSE` file for the full text. The
relicense was applied 2026-07-24 (Phase 4, owner-authorized): the AGPL-3.0
text was added, every package's `license` field set to `AGPL-3.0-only`, and
the `SPDX-License-Identifier: AGPL-3.0-only` header applied to every source
file (via `scripts/add-license-headers.mjs`). The repository may still be
private at the time of this commit; AGPL obligations attach on conveyance/
network use once distributed.

## History

Before 2026-07-24 this repository was private and proprietary, carrying this
file as the declared intent to relicense to AGPL-3.0 at launch. Everything
below kept that relicense a clean one-commit event — which it was. The
readiness audit that preceded it (the dependency graph scanned per workspace
and found AGPL-compatible, the vendored-binary aggregation posture confirmed,
the provenance ledger confirmed empty-and-plausible, the header script
verified) is a dated internal record; its durable conclusions are the rules
and tables below.

## Rules in force from commit one

1. **Dependency compatibility.** Every dependency (direct and transitive,
   production and bundled) must carry a license compatible with AGPL-3.0.
   CI enforces this via `license-checker` with an explicit allow-list
   (MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, AGPL-3.0, GPL-3.0,
   LGPL-3.0, MPL-2.0, 0BSD, BlueOak-1.0.0, CC0-1.0, CC-BY-4.0, Unlicense,
   Python-2.0, WTFPL). Unknown or unlisted licenses fail the gate — no
   warnings, no exceptions without a provenance entry below and an
   allow-list PR.
2. **No copied third-party code without provenance.** Copying any snippet,
   file, or algorithm implementation from another project requires an entry
   in the Provenance ledger below (source, license, date, what was taken).
   Absent an entry, copied code is a review-blocking violation.
3. **No material of any kind derived from third-party media servers** —
   code, schema, API shapes, naming. This is both a licensing rule (GPL-2.0
   incompatibility risk) and a product rule (docs/PLAN.md §1). CI grep-gates
   enforce naming.
4. **Contributor provenance.** Until a CLA/DCO process exists, the sole
   contributor is the repository owner; all commits are original work or
   AI-generated work-for-hire owned by the repository owner.

## Tooling exclusions (dev-only, never shipped)

The gate is `scripts/license-check.mjs` (Phase 4 Wave 3): it runs the
allow-list check from EVERY workspace root, not just the repo root — pnpm's
isolated linker never hoists workspace-scoped prod deps to root, so a
root-only scan was structurally blind to most production dependencies
(~554 seen vs ~798 real). The exclusions below are its `--excludePackages`
entries.

| Package | License | Why excluded | Verified |
|---------|---------|--------------|----------|
| `spdx-exceptions@2.5.0` | CC-BY-3.0 | Transitive devDependency of the license checker itself (via spdx-expression-parse); dev-tooling only, never bundled into any Loombre artifact. | 2026-07-22 — unfiltered scan showed it is the only non-allow-list package of 438 (a pre-Phase-4, root-only scan — see the ~554-seen / ~798-real correction above; two further exclusions, `spdx-ranges` and `url-template`, were added to this table later) |
| `spdx-ranges@2.1.1` | (MIT AND CC-BY-3.0) | Same category as spdx-exceptions — transitive devDep of the spdx toolchain the license checker uses; dev-tooling only, never shipped. The compound expression's CC-BY-3.0 term is NOT on the allow-list (only CC-BY-4.0 is); without the exclusion the package would pass only via the checker's documented substring match finding `MIT` inside the compound string — excluded so the gate never depends on that gap. | 2026-07-24 (Wave 3 AGPL readiness; license field re-verified against the installed package's own `package.json`) |
| `url-template@2.0.8` | BSD-3-Clause (declared as bare `"BSD"`) | Transitive devDep of `@redocly/cli` (the OpenAPI lint/codegen toolchain in @loombre/contract); dev-tooling only, never bundled. Its LICENSE file is BSD-3-Clause (three conditions incl. the non-endorsement clause, NO 4-clause advertising clause — allow-list compatible); excluded ONLY because the bare `"BSD"` string can't be SPDX-matched to `BSD-3-Clause`, not because the license is incompatible. | 2026-07-24 (Wave 3 — LICENSE read in full, clause-by-clause) |

### External test-fixture tools (PATH-resolved, never vendored, never shipped)

Not `--excludePackages` entries: these are not npm packages at all, so
`license-check.mjs` never sees them (the same structural blind spot the
vendored-binaries section below records for ffmpeg). They are resolved from
`PATH` at fixture-generation time, exactly like ffmpeg is, and nothing in
any Loombre artifact links to, bundles, or invokes them at runtime.

| Tool | License | How it is used | Why it is not a distribution concern |
|------|---------|----------------|--------------------------------------|
| `dovi_tool` 2.3.3 (quietvoid/dovi_tool) | MIT | `scripts/gen-media-fixtures.mjs` calls it as a child process to build the two Dolby Vision test fixtures LD-3/LD-15 verify against (`generate`/`inject-rpu`/`mux`). Resolved via `LOOMBRE_DOVI_TOOL` or `PATH`; `LOOMBRE_DOVI_TOOL=off` forces the no-tool path. | MIT is AGPL-compatible. Dev/test only: never vendored, never fetched by an installer, never referenced by server/worker/web code, and absent from every shipped artifact. Its OUTPUT is synthetic media generated from `lavfi testsrc2` — no third-party content, no Dolby-licensed material. The fixtures themselves are gitignored (`test-fixtures/media/`) and regenerated on demand, so nothing it produces is distributed either. **Its absence is not a build or test failure:** the generator falls back to a repo-owned synthetic NAL splice, so the regression fence runs with no external tool at all. |

## Provenance ledger

| Date | Source | License | What was taken | Where it lives |
|------|--------|---------|----------------|----------------|
| 2026-07-25 | Google Fonts css2 API (`fonts.gstatic.com`), upstream project https://github.com/Omnibus-Type/Archivo | SIL OFL-1.1 | Archivo variable font, latin + latin-ext subsets, `wght 100..900` + `wdth 62..125` (Phosphor retheme, U6 — self-hosted, no runtime font CDN) | `apps/web/public/fonts/archivo/` (`.woff2` + `OFL.txt`; provenance detail in that directory's `PROVENANCE.md`) |
| 2026-07-25 | Google Fonts css2 API (`fonts.gstatic.com`), upstream project https://github.com/IBM/plex | SIL OFL-1.1 | IBM Plex Mono static weights 400/500/600, latin + latin-ext subsets (Phosphor retheme, U6 — self-hosted, no runtime font CDN) | `apps/web/public/fonts/ibm-plex-mono/` (`.woff2` + `OFL.txt`; provenance detail in `apps/web/public/fonts/PROVENANCE.md`) |
| 2026-08-06 | loombre.com website workspace's font pipeline: vendored OFL sources `site/tools/font-sources/*.ttf` → `site/tools/build-fonts.py` → `site/public/fonts/`, copied verbatim into this repo (upstream project https://github.com/Omnibus-Type/Archivo) | SIL OFL-1.1 | Archivo variable font, docs-site subset — a second, independently-subsetted vendored copy, for the documentation site (built into `docs/.vitepress/dist/fonts/` and published) | `docs/public/fonts/archivo-variable.woff2` (see `docs/public/fonts/README.md`; gap closed 2026-08-31: `docs/public/fonts/OFL.txt` now ships beside these copies, carrying both copyright notices) |
| 2026-08-06 | same website font pipeline as the row above (upstream project https://github.com/IBM/plex) | SIL OFL-1.1 | IBM Plex Mono 400/500/600, docs-site subset (second vendored copy, for the documentation site) | `docs/public/fonts/ibm-plex-mono-{400,500,600}.woff2` (same chain; same missing-`OFL.txt` gap as the Archivo row) |

## Vendored non-npm binaries (Phase 4 installers)

`license-checker` scans the npm graph only — the binaries below are fetched
at BUILD time by pinned-checksum scripts, never committed, and ship INSIDE
installer artifacts as SEPARATE EXECUTABLES spawned as child processes
(mere aggregation — never linked into Loombre's process; the AGPL work and
these programs communicate only via process boundaries/CLI/files).

| Binary | License | Source + pin | Aggregation posture |
|--------|---------|--------------|---------------------|
| ffmpeg / ffprobe | GPL-3.0-or-later (GPL builds: libx264/x265 required for software encode). Per-platform footnote: the macos-arm64 entry's manifest `license` field reads `GPL-2.0-or-later (unconfirmed vs GPL-3.0 — see licenseNote)` — osxexperts.net's published build script carries no `--enable-version3` flag, so that one platform's GPL version is unconfirmed and needs re-verification before public release; GPL-3.0-or-later is confirmed for the other platforms | `installers/ffmpeg-manifest.json` — BtbN autobuild (linux/win), evermeet.cx (mac x64), osxexperts.net (mac arm64), sha256-pinned; see the manifest's `provenance` + `verification.notes` (incl. the flagged arm64 webpage-checksum mismatch requiring second-source re-check before public release) | Child process via job queue (CLAUDE.md invariant 6); GPLv3↔AGPLv3 compatible both directions per each license's §13; aggregation rationale recorded in the manifest |
| PostgreSQL 18.x (embedded; 18.4.0 pinned — 17 survives only as the external-server floor, `PROVISIONING_REQUEST_MIN_PG_MAJOR`, and as the upgrade-test FROM pin) | PostgreSQL License (BSD-style, allow-list compatible). Second layer: theseus-rs's own packaging/build scripts carry an ISC-equivalent permissive license (build tooling only, not distributed inside any installer — see the manifest's `.sourcing.licenseNote`) | `installers/embedded-pg-manifest.json` — theseus-rs/postgresql-binaries, sha256-pinned (macos-arm64 independently re-hashed on the build host against the publisher sidecar; the other four platforms verified against the publisher `.sha256` sidecar) | Supervised child process (`@loombre/provisioning-pg`); communicates via socket |
| Node.js runtime | MIT (+ bundled deps per Node's LICENSE) | `installers/node-manifest.json` (+ per-platform fetch scripts) — official nodejs.org dist, sha256-pinned | The runtime the AGPL work runs ON; bundled unmodified |

Rule: any new vendored binary requires (a) a pinned-checksum manifest entry
with source URLs, (b) a license row here, (c) an aggregation-posture note.

**Vendor-mirror provenance note (Task #16, private-repo holding vs.
distribution).** Upstreams garbage-collect old releases — BtbN deleted our
pinned autobuild mid-rc.7-draft (repinned in b8809e7) — so this repo now
holds a deletion-proof mirror of the seven ffmpeg/ffprobe archives above,
byte-identical copies at a GitHub Release tagged `ffmpeg-mirror`
(`installers/ffmpeg-manifest.json`'s top-level `mirror` block records the
repo/tag/naming scheme; `scripts/fetch-ffmpeg.mjs` falls back to it on a
primary download failure — see that script's header). Those seven assets
are GPL-3.0 binaries (BtbN's `-gpl` builds, evermeet.cx, osxexperts.net —
same sources and licenses as the table above, same bytes, same sha256
pins). While this repository stays **private**, holding them on the
mirror release is not distribution (no GPL obligation attaches to storage
a third party cannot access) — the same posture the rest of this file
already applies to the repository as a whole (see "Current status" above:
"AGPL obligations attach on conveyance/network use once distributed").
**IF this repository goes public, the mirror assets become distributed
GPL binaries and pick up a corresponding-source obligation the moment
they do** (GPL-3.0 §6) — this must be resolved BEFORE flipping
visibility, not after: either (a) mirror each build's corresponding
source (or a source-offer per GPL-3.0 §6(b)/(c)) alongside the binary
assets on that same release, or (b) drop the `ffmpeg-mirror` release (or
re-privatize just that release, if GitHub ever supports per-release
visibility independent of the repo) before or at the same moment the repo
itself goes public. Tracked here rather than only in the manifest because
this is exactly the kind of pre-launch gate this file exists to catch.

## .NET components (Phase 4, Windows lane I3)

The Windows tray and service-host executables are C# — fully-owned
original code, AGPL-3.0 like the rest of the repo. What ships beside or
inside them (also outside `license-checker`'s npm-only scan):

| Component | License | Source + pin | Posture |
|-----------|---------|--------------|---------|
| .NET 8 runtime packs | MIT | resolved by `dotnet publish --self-contained` from nuget.org (SDK-managed) | Bundled unmodified into `LoombreServiceHost.exe` / `Loombre.Tray.exe` (single-file publish); the runtime the C# code runs ON |
| System.ServiceProcess.ServiceController 8.0.1 | MIT (© .NET Foundation) | exact-version `PackageReference`s in `LoombreServiceHost.csproj` (ServiceBase does not ship in the `-windows` TFM reference assemblies — first Windows compile evidence, diag run 30218015372) and `Loombre.Tray.csproj` (ServiceManagerProbe — SCM query + start-a-stopped-server, the IPC_SERVER_START_SEMANTICS fallback) | Compiled into the service-host and tray exes; MIT → AGPL-3.0 compatible |
| xunit 2.9.2, xunit.runner.visualstudio 2.8.2, Microsoft.NET.Test.Sdk 17.12.0 | Apache-2.0 / MIT | exact-version `PackageReference`s in the two test csprojs | Build/test-time only — never ships in any artifact |
| WiX Toolset 5.0.2 + WixToolset.Firewall.wixext 5.0.2 + WixToolset.Util.wixext 5.0.2 | MS-RL | `/.config/dotnet-tools.json` pin + lockstep extension pins in `installers/windows/build-msi.mjs` (OSMF decision — STATE.md sweep ledger) | Build tool. OWNER-REVIEW NOTE: both extensions embed their native custom-action DLLs inside the produced `.msi` (MSI Binary table; Firewall rules + RemoveFolderEx uninstall cleanup) — separate binaries aggregated in the installer container, never linked with Loombre code; same mere-aggregation posture as ffmpeg above. MS-RL is GPL-incompatible for LINKING, which is why the aggregation-only posture matters and is recorded here |

## Go components (STATE.md "Loombre Remote — embedded WireGuard + three-path wizard + reachability proof + posture card", lane WG1, RG1/RG14)

`packages/wg-native/native` is Go — fully-owned original glue code (AGPL-3.0
like the rest of the repo, `packages/wg-native/native/*.go`) compiled via
`go build -buildmode=c-shared` into a per-OS shared library
(`dist/wg-native-<platform>-<arch>.{dylib,so,dll}`) and loaded into the
Node process with `koffi` (MIT, an ordinary npm dependency already covered
by `license-checker`/`scripts/license-check.mjs`). The Go module graph
itself is invisible to `license-checker` (npm-only scan) — this is the
other half of the blind spot RG1's recon flagged, closed by
`scripts/go-licenses-check.mjs` (pinned `google/go-licenses` v1.6.0,
`pnpm gate`'s `go-licenses-check` step) walking the REAL compiled package
graph (not `go.sum`'s full module list, which for `gvisor.dev/gvisor` in
particular is much broader than what `packages/wg-native/native` actually
imports).

**Compiled-into-process posture** (unlike the ffmpeg/PostgreSQL binaries
above, which run as SEPARATE child processes — mere aggregation — this Go
code links directly into the shared library loaded in-process): every
dependency below is permissively licensed (MIT/Apache-2.0/BSD-3-Clause, all
independently AGPL-3.0-compatible for linking, not just aggregation) and
was verified BOTH by `go-licenses report` (automated, machine-readable) AND
direct inspection of each module's own LICENSE file in the local module
cache during this lane's work.

| Component | Version (pinned, `packages/wg-native/native/go.mod`) | License | Posture |
|-----------|--------------------------------------------------------|---------|---------|
| `golang.zx2c4.com/wireguard` (wireguard-go) | v0.0.0-20260522210424-ecfc5a8d5446 | MIT | The `device` + `tun/netstack` packages — the actual WireGuard protocol implementation and the in-process userspace network stack (gVisor-backed) this whole subsystem is built on (RG1). Direct dependency. |
| `gvisor.dev/gvisor` (`pkg/tcpip` and its subpackages only — NOT the `runsc` container runtime, which this module never imports) | v0.0.0-20250503011706-39ed1f5ac29c | Apache-2.0 | wireguard-go's `tun/netstack` package's own dependency — the userspace TCP/IP stack backing the single RG2 listener. Transitive. |
| `golang.org/x/crypto` | v0.37.0 | BSD-3-Clause | wireguard-go's Noise-protocol crypto primitives (chacha20poly1305, curve25519, blake2s). Transitive. |
| `golang.org/x/net` | v0.39.0 | BSD-3-Clause | wireguard-go/gvisor's low-level network primitives (bpf, dns/dnsmessage, ipv4/ipv6 socket options). Transitive. |
| `golang.org/x/sys` | v0.32.0 | BSD-3-Clause | Raw syscall access (the real OS UDP socket, RG1's "no kernel module, no root" posture — this is a normal unprivileged socket syscall, nothing more). Transitive. |
| `golang.org/x/time` | v0.7.0 | BSD-3-Clause | gvisor's internal rate-limiting (`rate` package). Transitive. |
| `github.com/google/btree` | v1.1.2 | Apache-2.0 | gvisor's internal ordered-map data structure (connection/route tables). Transitive. |
| `golang.zx2c4.com/wintun` | v0.0.0-20230126152724-0fa3db229ce2 | MIT | wireguard-go's Windows TUN driver binding — build-tag-gated (`GOOS=windows` only; never compiled into the darwin/linux artifacts, confirmed by `go list -deps` on this host showing it absent from the darwin/arm64 build). Present in `go.mod` as an indirect dependency of `golang.zx2c4.com/wireguard` regardless of target OS (Go's module graph is OS-agnostic even though the BUILD is not); only the Windows CI leg's `go-licenses-check` run actually compiles it in. |

Verification method: `go-licenses report ./native` (from
`packages/wg-native/native`) lists every one of the above with its
resolved LICENSE file URL; `scripts/go-licenses-check.mjs` enforces the
SAME allow-list `scripts/license-check.mjs` enforces for the npm graph
(`MIT;ISC;BSD-2-Clause;BSD-3-Clause;Apache-2.0;AGPL-3.0;GPL-3.0;LGPL-3.0;MPL-2.0;0BSD;BlueOak-1.0.0;CC0-1.0;CC-BY-4.0;Unlicense;Python-2.0;WTFPL`),
wired as its own `pnpm gate` step (`go-licenses-check`, right after
`license-check`). CI installs Go via `actions/setup-go` (pinned 1.26.5,
current stable — a BUILD toolchain, not a shipped runtime, so CLAUDE.md's
N2 Active-LTS Node policy does not govern this pin) on every matrix leg
and sets `LOOMBRE_REQUIRE_WG=1` on the gate step, so a missing/unbuildable
Go toolchain is a hard CI failure, never a silent skip.
