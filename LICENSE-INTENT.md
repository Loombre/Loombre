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
below kept that relicense a clean one-commit event — which it was; the
readiness checklist is in `reports/agpl-readiness.md`.

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
3. **No Jellyfin/Emby-derived material of any kind** — code, schema, API
   shapes, naming. This is both a licensing rule (GPL-2.0 incompatibility
   risk) and a product rule (docs/PLAN.md §1). CI grep-gates enforce naming.
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
| `spdx-exceptions@2.5.0` | CC-BY-3.0 | Transitive devDependency of the license checker itself (via spdx-expression-parse); dev-tooling only, never bundled into any Loombre artifact. | 2026-07-22 — unfiltered scan showed it is the only non-allow-list package of 438 |
| `spdx-ranges@2.1.1` | CC-BY-4.0 | Same category as spdx-exceptions — transitive devDep of the spdx toolchain the license checker uses; dev-tooling only, never shipped. CC-BY-4.0 IS on the allow-list, but the checker flags the version constraint; excluded for parity with spdx-exceptions. | 2026-07-24 (Wave 3 AGPL readiness) |
| `url-template@2.0.8` | BSD-3-Clause (declared as bare `"BSD"`) | Transitive devDep of `@redocly/cli` (the OpenAPI lint/codegen toolchain in @loombre/contract); dev-tooling only, never bundled. Its LICENSE file is BSD-3-Clause (three conditions incl. the non-endorsement clause, NO 4-clause advertising clause — allow-list compatible); excluded ONLY because the bare `"BSD"` string can't be SPDX-matched to `BSD-3-Clause`, not because the license is incompatible. | 2026-07-24 (Wave 3 — LICENSE read in full, clause-by-clause) |

## Provenance ledger

| Date | Source | License | What was taken | Where it lives |
|------|--------|---------|----------------|----------------|
| 2026-07-25 | Google Fonts css2 API (`fonts.gstatic.com`), upstream project https://github.com/Omnibus-Type/Archivo | SIL OFL-1.1 | Archivo variable font, latin + latin-ext subsets, `wght 100..900` + `wdth 62..125` (Phosphor retheme, U6 — self-hosted, no runtime font CDN) | `apps/web/public/fonts/archivo/` (`.woff2` + `OFL.txt`; provenance detail in that directory's `PROVENANCE.md`) |
| 2026-07-25 | Google Fonts css2 API (`fonts.gstatic.com`), upstream project https://github.com/IBM/plex | SIL OFL-1.1 | IBM Plex Mono static weights 400/500/600, latin + latin-ext subsets (Phosphor retheme, U6 — self-hosted, no runtime font CDN) | `apps/web/public/fonts/ibm-plex-mono/` (`.woff2` + `OFL.txt`; provenance detail in `apps/web/public/fonts/PROVENANCE.md`) |

## Vendored non-npm binaries (Phase 4 installers)

`license-checker` scans the npm graph only — the binaries below are fetched
at BUILD time by pinned-checksum scripts, never committed, and ship INSIDE
installer artifacts as SEPARATE EXECUTABLES spawned as child processes
(mere aggregation — never linked into Loombre's process; the AGPL work and
these programs communicate only via process boundaries/CLI/files).

| Binary | License | Source + pin | Aggregation posture |
|--------|---------|--------------|---------------------|
| ffmpeg / ffprobe | GPL-3.0-or-later (GPL builds: libx264/x265 required for software encode) | `installers/ffmpeg-manifest.json` — BtbN autobuild (linux/win), evermeet.cx (mac x64), osxexperts.net (mac arm64), sha256-pinned; see the manifest's `provenance` + `verification.notes` (incl. the flagged arm64 webpage-checksum mismatch requiring second-source re-check before public release) | Child process via job queue (CLAUDE.md invariant 6); GPLv3↔AGPLv3 compatible both directions per each license's §13; aggregation rationale recorded in the manifest |
| PostgreSQL 17.x (embedded) | PostgreSQL License (BSD-style, allow-list compatible) | `installers/embedded-pg-manifest.json` — theseus-rs/postgresql-binaries, sha256 triple-verified | Supervised child process (`@loombre/provisioning-pg`); communicates via socket |
| Node.js runtime | MIT (+ bundled deps per Node's LICENSE) | `installers/node-manifest.json` (+ per-platform fetch scripts) — official nodejs.org dist, sha256-pinned | The runtime the AGPL work runs ON; bundled unmodified |

Rule: any new vendored binary requires (a) a pinned-checksum manifest entry
with source URLs, (b) a license row here, (c) an aggregation-posture note.

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
