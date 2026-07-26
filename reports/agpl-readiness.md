# AGPL-3.0 Relicense Readiness Report — P4.8

**Phase:** 4, Wave 3, lane W3-agpl
**Date:** 2026-07-24
**Scope:** STATE.md D12 / P4.8 — "Relicense readiness = a CHECKLIST DELIVERABLE
(reports/agpl-readiness.md): license-checker clean, provenance log complete,
headers script ready, LICENSE swap PR drafted-not-merged; going public
remains an owner decision outside this phase."
**Base commit audited:** `8a473be` (main, HEAD at dispatch time)
**Swap branch:** `chore/agpl-relicense` @ `5d025cf` — pushed to `origin`, **not merged**

## Verdict

**READY, with one structural GAP in the license-checker gate itself (found
and characterized, not silently worked around) and two small documentation
gaps (fixed additively in LICENSE-INTENT.md).** Once the gate's blind spot
is accounted for by scanning every workspace (not just root — see item 1),
every production and bundled dependency in the real, complete dependency
graph is AGPL-3.0-compatible. No uncredited copied third-party code was
found. The headers script is built, tested, and its dry-run is captured
below. The swap branch exists, is pushed, typechecks clean (22/22), and
grep-gates clean (1488 files, 0 violations) — see item 5.

| # | Checklist item | Verdict |
|---|---|---|
| 1 | License-checker clean | **GAP** (gate coverage blind spot — dependency tree itself is clean once scanned correctly) |
| 2 | Vendored-binary licensing | **PASS** (two pre-existing/newly-noted loose ends, already tracked, don't change the conclusion) |
| 3 | Provenance ledger complete | **PASS** |
| 4 | Headers script ready | **PASS** |
| 5 | License swap PR drafted-not-merged | **PASS** |

---

## 1. LICENSE-CHECKER CLEAN

### 1.1 The gate as documented vs. the gate as it actually behaves — GAP

`pnpm license-check` (root `package.json`) runs
`license-checker-rseidelsohn` from the repo root. **I could not run that
exact command safely**: mid-audit, a concurrent Wave-3 lane
(`W3-struct`) had uncommitted edits to `packages/db/package.json` /
`packages/jobs/package.json` / tsconfigs in the shared checkout, and
`pnpm <script>` on pnpm 11 runs a deps-status check first that — per
STATE.md's own documented "shared-checkout pnpm foot-gun" — can trigger a
destructive `pnpm install --production` reinstall. It safely **aborted**
instead (`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`, no TTY present) —
confirmed via `git status` before/after that nothing was touched. I
switched to invoking the underlying binary directly
(`node_modules/.bin/license-checker-rseidelsohn` with the **identical**
flags from the `license-check` script) — a read-only operation — for every
check in this report, and later reproduced the same command cleanly on the
isolated swap branch (§5) where no concurrency hazard exists.

Doing that surfaced a real finding: **run from repo root, the tool sees
554–558 packages. Run per-workspace and unioned, the true graph is 798
packages.** Root-only misses, by name, at minimum:

`@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express`, `acme-client`,
`hash-wasm`, `jose`, `reflect-metadata`, `rxjs` (all direct deps of
`apps/server` — **the NestJS framework itself is invisible to the
root-scoped scan**), `blurhash`, `hls.js`, `lucide-react` (`apps/web`),
`blurhash`, `music-metadata`, `xxhash-wasm` (`apps/worker`), `pg-boss`
(`packages/jobs`), `@napi-rs/keyring` (`packages/secrets`).

**Root cause:** pnpm's `node-linker: isolated` store means these packages
exist only as symlinks inside each workspace package's *own*
`node_modules` (e.g. `apps/server/node_modules/acme-client ->
../../../node_modules/.pnpm/acme-client@5.4.0/...`), never hoisted to the
repo-root `node_modules` (which has 10 entries total, essentially none
hoisted). Root `package.json` also has no npm/yarn-style `"workspaces"`
field (workspaces are declared only in `pnpm-workspace.yaml`), which is
plausibly why `license-checker-rseidelsohn`'s arborist-based traversal
doesn't independently discover each workspace project's own dependency
declarations when started from root. (Confirmed empirically, not just
theorized: running the identical tool **from `apps/server/`** finds
`acme-client@5.4.0` immediately — 534 packages from that one workspace
alone.) A handful of packages (`node-forge`, the `pg` family, `sharp`,
`postcss`) *do* show up in the root scan despite the same non-hoisted
layout, most likely because they're also reachable via some other
resolved edge the traversal does follow — the point isn't that the root
scan finds nothing, it's that its coverage is **silently partial** and the
gap includes core, unambiguously-shipped dependencies.

**Remediation (not applied here — a `package.json`/`scripts/` change is
outside this lane's ownership; ports the fix to whoever owns the gate
script next):**
```
# scripts/license-check.mjs (new) — replace the single root-scoped
# license-check with a loop over every pnpm-workspace project, union the
# results, then apply --onlyAllow / --excludePackages over the union. The
# per-workspace CLI invocation already works today (proven above); this
# is aggregation, not a new capability.
```
A minimal stopgap that needs no new script: add `--start <path>` per
workspace as N calls in CI. The real fix should live next to
`scripts/dep-audit.mjs` (same "supply-chain gate" family in `pnpm gate`).

**This is flagged as the report's headline GAP because the *gate* has a
blind spot, not because the dependency tree is non-compliant** — see 1.2.

### 1.2 The real, complete dependency graph — compliant

Per-workspace scan unioned across all 15 `package.json` files (root + 14
`@lumbre/*` packages), deduplicated by `name@version`: **798 unique
resolved packages.** Full inventory in Appendix A. Bucketed:

| License | Count |
|---|---|
| MIT | 571 |
| ISC | 93 |
| Apache-2.0 | 49 |
| BSD-3-Clause | 27 |
| BSD-2-Clause | 13 |
| BlueOak-1.0.0 | 11 |
| UNLICENSED (Lumbre's own 15 private workspace packages — see 1.4) | 15 |
| MIT-0 | 3 |
| CC0-1.0 | 2 |
| (MIT OR CC0-1.0) | 2 |
| 0BSD | 2 |
| MIT* ("guessed", spot-checked below) | 2 |
| MPL-2.0 | 1 |
| Python-2.0 | 1 |
| CC-BY-4.0 | 1 |
| CC-BY-3.0 | 1 |
| BSD* ("guessed", spot-checked below) | 1 |
| (BSD-3-Clause OR GPL-2.0) | 1 |
| (MIT AND CC-BY-3.0) | 1 |
| (MPL-2.0 OR Apache-2.0) | 1 |

Every bucket is allow-list-compatible **except** the three called out
below, all already accounted for:

**`node-forge@1.4.0` → `(BSD-3-Clause OR GPL-2.0)`** — transitive of
`acme-client@5.4.0` (`apps/server`'s ACME/TLS dependency, MIT). This is a
**real** compatibility question, not a formality: `node-forge` is
imported as a JS module and runs inside the server process (unlike the
vendored binaries in item 2, this genuinely is linking, not aggregation).

*Resolution, shown in full:* `node-forge`'s own `LICENSE` file (read in
full, not inferred from the SPDX tag) is textually explicit: *"You may use
the Forge project under the terms of either the BSD License or the [GPL]
Version 2 ... You don't have to do anything special to choose one license
or the other."* This is a genuine dual-license grant, not a single license
with two aliases. GPL-2.0-**only** would NOT be AGPL-3.0-compatible (no
upgrade/cross-license clause exists in GPLv2 the way GPLv3 §13 grants one
for AGPLv3 — see item 2's §13 discussion) — so the compatibility of this
dependency rests entirely on Lumbre (as downstream user) electing the
**BSD-3-Clause** arm of the choice, which the license text permits
unconditionally and without notifying anyone. BSD-3-Clause is permissive,
non-copyleft, and imposes no obligation beyond attribution — trivially
compatible with distribution inside an AGPL-3.0 work. **Resolution: BSD-3-
Clause arm elected; compatible.** (If Lumbre ever needed *both* arms
simultaneously for some reason it doesn't today, the GPL-2.0 arm would
need separate scrutiny — it doesn't apply here.)

**`spdx-exceptions@2.5.0` → `CC-BY-3.0`** — already documented in
LICENSE-INTENT.md's tooling-exclusions table (D20): transitive devDep of
`license-checker-rseidelsohn` itself, never bundled/shipped, named
`--excludePackages` entry. **PASS, as documented.**

**`spdx-ranges@2.1.1` → `(MIT AND CC-BY-3.0)`** — **NEW GAP, same
category as the row above**, found during this audit and NOT previously
documented: also a transitive devDep of `license-checker-rseidelsohn`
(via `spdx-compare`→`spdx-satisfies`), also dev-tooling-only, never
shipped. It currently passes the `--onlyAllow` gate, but for the wrong
reason: `license-checker-rseidelsohn`'s onlyAllow check
(`lib/index.js`'s `checkForOnlyAllow`) is a **substring match**
(`currentLicense.includes(allowedLicense)`), documented in its own code
comment as "contains (eventually among others) at least one of the
allowed licenses" — it happens to find the substring `MIT` inside
`(MIT AND CC-BY-3.0)` and passes it, even though `CC-BY-3.0` (as opposed
to the allow-listed `CC-BY-4.0`) is not actually on the allow-list and
"AND" semantics mean *both* components' terms apply. Since this package
is dev-tooling that never ships (same posture as `spdx-exceptions`), it
poses no real compliance risk — but it was passing "by tool-parsing
accident," not by documented exception. **Fixed additively in
LICENSE-INTENT.md's tooling-exclusions table on this lane's own ownership
(see the diff on `main`); recommended follow-up (not applied — out of
this lane's ownership of `package.json`) is to add
`;spdx-ranges@2.1.1` to the root `license-check` script's
`--excludePackages` list, matching `spdx-exceptions`.**

The `--onlyAllow` substring-match behavior above is also worth noting as a
standing, low-severity observation independent of this specific finding:
it means any future `(X AND Y)` compound license where only `X` is
allow-listed will pass silently even if `Y` is not — worth a comment in
LICENSE-INTENT.md's rule 1 if the gate is ever tightened (not done here;
out of scope for an audit-only lane).

**`MIT*` (`decko@1.2.0`, `stickyfill@1.1.1`) and `BSD*`
(`url-template@2.0.8`)** — the trailing `*` is `license-checker`'s own
"guessed from file content, not read from an explicit package.json
`license` field" marker. Spot-checked: all three `LICENSE` files were read
in full and genuinely say MIT / BSD respectively (not misidentified). All
three are transitive of `redoc@2.5.0`, itself transitive of
`@redocly/cli` — a `packages/contract` **devDependency** (API-doc linting
only), never shipped. PASS regardless of shipping status since the
licenses are permissive.

**`MIT-0`** (3 `@csstools/*` packages, transitive of PostCSS/stylelint
tooling) — MIT-0 ("MIT No Attribution") is MIT with the attribution clause
*removed*, i.e. strictly more permissive than MIT. Trivially compatible;
not literally spelled out in the allow-list string (only `"MIT"` is
listed) but functionally a non-issue.

### 1.3 New Phase-4 dependencies, checked by name as requested

| Dependency | License | Compatible? |
|---|---|---|
| `acme-client@5.4.0` | MIT | Yes |
| `acme-client`'s tree (incl. `node-forge`) | see §1.2 | Yes (BSD-3-Clause arm) |
| `@napi-rs/keyring@1.3.0` (+ per-platform native binaries, only the darwin ones resolve on this host) | MIT | Yes |
| `@lumbre/*` internal packages (15) | N/A — first-party Lumbre code, will carry `AGPL-3.0-only` after the swap (see item 5) | N/A |
| `sharp@0.35.3` (G1's CVE-fix upgrade) | Apache-2.0 | Yes |
| `postcss@8.5.21` (G1's CVE-fix upgrade) | MIT | Yes |

### 1.4 Lumbre's own package.json `license` fields — pre-existing inconsistency, resolved by item 5

Before the swap: 13 of 15 workspace `package.json` files have **no**
`"license"` field at all; `packages/contract` and `packages/sdk` have
`"license": "SEE LICENSE-INTENT.md"`. This is why they show as
`UNLICENSED` in the scan above — expected for first-party private
packages, not a third-party compliance question, but inconsistent
housekeeping. Resolved uniformly by the swap branch (item 5): all 15 get
the literal `"AGPL-3.0-only"` SPDX id.

### 1.5 D20 / STATE.md count is stale

STATE.md D20 and LICENSE-INTENT.md's tooling-exclusions table both cite
"438" total packages (2026-07-22, pre-Phase-4). The real current count —
correctly scanned — is **798** (root-only mis-scan shows 554–558). Not a
compliance problem, just a number that should be refreshed the next time
either document is touched; noted here rather than edited into STATE.md
(outside this lane's ownership).

---

## 2. VENDORED-BINARY LICENSING

Audited `LICENSE-INTENT.md`'s "Vendored non-npm binaries" section against
`installers/ffmpeg-manifest.json`, `installers/embedded-pg-manifest.json`,
`installers/linux/node-manifest.json`, and the actual invocation code.

### 2.1 ffmpeg/ffprobe — spawned, never linked — confirmed by grep, not just asserted

Grepped every ffmpeg/ffprobe touch point in `apps/worker/src/`:
`apps/worker/src/transcode/process.ts` (`spawnFfmpegRun`, wraps
`node:child_process`'s `spawn`), `apps/worker/src/probe/ffprobe.ts`
(`spawn`, `stdio: ["ignore","pipe","pipe"]`), and
`apps/worker/src/hwcaps/command-runner.ts` (`spawn`, detached process
group). Every invocation goes through `node:child_process.spawn`/`execFile`
with the binary path and an argv array — no `dlopen`, no native addon, no
FFI. The only place `shell:true` is ever used is a narrow, unrelated
Windows CVE-2024-27980 workaround for a **user-substituted**
`.cmd`/`.bat` override path (`LUMBRE_FFPROBE` env var), never for the
vendored binary itself. **Confirms the manifest's own claim**: ffmpeg/
ffprobe are separate executables communicating with Lumbre only via
argv/stdio/exit codes — mere aggregation, not a combined work.

### 2.2 The aggregation argument, checked against the actual license text

`ffmpeg-manifest.json`'s `provenance.aggregationRationale` cites "GPLv3↔
AGPLv3 compatible both directions per each license's §13." Verified
against the real text (fetched `gnu.org/licenses/gpl-3.0.txt` and
`agpl-3.0.txt`): GPLv3 §13 ("Use with the GNU Affero General Public
License") reads *"you have permission to link or combine any covered work
with a work licensed under version 3 of the GNU Affero General Public
License into a single combined work, and to convey the resulting work."*
AGPLv3 §13 grants the mirror permission. **The citation is accurate.**

This is actually the *secondary*, belt-and-suspenders argument — the
*primary* one is that spawning a subprocess and reading its stdout is the
FSF's own textbook "mere aggregation" case (their GPL FAQ: pipe
communication is "a fairly strong indicator that they are separate
programs"), which doesn't even reach a compatibility question in the
first place. Even if a court disagreed and treated this as a combined
work, §13's explicit cross-permission would still cover it. Two
independent, both-sound arguments. **PASS.**

### 2.3 Per-platform license confirmation, and one nuance the table didn't carry

Read `ffmpeg-manifest.json` in full. linux-x64/linux-arm64/windows-x64 are
BtbN's `-gpl` (non-shared) autobuild, GPL-3.0-or-later, confirmed by a
bundled `LICENSE.txt` inside the archive itself (not inferred). macos-x64
(evermeet.cx) is confirmed GPL-3.0-or-later from the publisher's own
stated `--enable-version3` build flag. **macos-arm64 (osxexperts.net) is
the one platform where the manifest itself flags the GPL version as
unconfirmed** — the publisher's build script has `--enable-gpl` but no
`--enable-version3`, which by FFmpeg's own convention defaults to
GPL-2.0-or-later, not GPL-3.0. `LICENSE-INTENT.md`'s vendored-binaries
table previously stated a single blanket "GPL-3.0-or-later" for the whole
ffmpeg/ffprobe row, which slightly overstates certainty for this one
platform. **Doesn't change the compliance conclusion** (mere aggregation
makes the exact GPL version immaterial either way — GPL-2 binaries ship
alongside GPL-3 and AGPL-3 binaries in every Linux distro on earth without
issue), but the table's wording implied more certainty than the manifest
itself has. **Fixed additively in LICENSE-INTENT.md** (see diff) — noted
as a footnote alongside the pre-existing checksum flag rather than
silently left as an overstatement.

### 2.4 The already-known arm64 checksum discrepancy — confirmed still open, not re-litigated

STATE.md's Phase 4 Open items and `ffmpeg-manifest.json`'s own
`verification.notes` both already flag: the macos-arm64 pin's sha256 (this
lane's own re-download-and-hash) does **not** match the sha256
osxexperts.net prints on its own webpage for the same file — most likely
explanation given in the manifest is a re-published build at an
unversioned URL without an updated printed checksum. Tamper-**after**-pin
is still caught (Lumbre's fetch script verifies against the pin, not the
webpage); the mismatch **before** pinning is what's unresolved. This
report doesn't re-investigate it — it's explicitly carried forward as
**input to the Wave 3 adversarial security review** (STATE.md: "explicit
input to the Wave 3 release-artifact-integrity adversarial review"),
consistent with the mission's "note it" instruction rather than "fix it."
Bundled together with the GPL-version nuance above (§2.3) as two loose
ends on the same one platform pin in the LICENSE-INTENT.md update.

### 2.5 PostgreSQL (embedded)

`installers/embedded-pg-manifest.json` documents a real evaluation
(zonky rejected — missing client tools; EDB rejected — wrong shape/mixed
licensing; postgresql.org rejected — no portable prebuilts;
theseus-rs chosen — full client toolset, triple-verified checksums, real
functional smoke incl. corruption-mode testing). License: PostgreSQL
License (BSD-style, permissive) confirmed by direct inspection of the
extracted archives' bundled `LICENSE`/`COPYRIGHT` files. Grepped
`packages/provisioning-pg/src/exec.ts` and `supervisor.ts`: the `postgres`
server binary is spawned **directly** via `child_process.spawn`
(`spawnServer`), never through `pg_ctl`'s daemonizing fork, and never
linked. The npm `pg`/`pg-pool`/`pg-protocol` family (MIT, already in the
standard inventory) is a **separate** layer — the wire-protocol client
used to talk to the server over a socket, not a link to the server binary.
Even hypothetically, PostgreSQL License is permissive enough that linking
vs. aggregation wouldn't matter here. **PASS**, no compatibility question
exists regardless of posture.

### 2.6 Node.js runtime

`installers/linux/node-manifest.json`: official nodejs.org dist,
sha256-pinned against nodejs.org's own `SHASUMS256.txt`, MIT (+ Node's
own bundled-component licenses — V8/BSD, OpenSSL/Apache-2.0, etc., all
independently permissive). macOS (`installers/macos/pkg/fetch-node.mjs`)
and Windows (`installers/windows/build-msi.mjs`) verify checksums
dynamically against the same `SHASUMS256.txt` rather than a static pinned
manifest — LICENSE-INTENT.md's wording ("+ per-platform fetch scripts")
already accounts for this rather than overclaiming a single shared
manifest; consistent with the already-tracked Phase 4 Open item ("Node-
runtime fetch script consolidation... unassigned candidate for I1")
which this lane doesn't own. **PASS.**

---

## 3. PROVENANCE LEDGER COMPLETE

Ledger is empty ("nothing copied"). Spot-checked the Phase-4 areas most
likely to tempt a copy-paste: minisign parsing, the ACME flow, the
systemd unit, WiX authoring.

- **Repo-wide grep for attribution markers** (`Copyright (c)`, `Copyright
  ©`, `SPDX-License-Identifier`, `Licensed under the`, `stackoverflow.com`,
  `gist.github.com`) across every `.ts .tsx .js .mjs .cjs .cs .swift .wxs`
  source file (excluding generated/dist/vendor): **zero hits.** Consistent
  with an empty ledger being plausible, not just unexamined.

- **minisign parsing** (`packages/release-manifest/src/minisign/parse.ts`
  + `verify.ts`) — read in full. This is a clean-room implementation
  against the **published wire-format specification** (cited in
  `README.md`: a link to jedisct1's minisign docs, with the byte layout
  quoted and explained), using `node:crypto`'s own `createPublicKey`/
  `verify` for the actual Ed25519 math — no algorithm was hand-rolled, no
  code was lifted from minisign's C source or from any existing npm
  minisign-verify package. Citing a public file-format spec while writing
  original parsing code is the normal, expected way to implement a format
  (same category as writing a JSON parser from the JSON spec) — this is
  **not** the kind of "copied code" the provenance rule targets, and
  correctly has no ledger entry.

- **ACME flow** (`apps/server/src/tls/acme/*.ts`) — thin orchestration on
  top of the `acme-client` npm library (MIT, already inventoried in item
  1); no hand-rolled ACME protocol implementation to have copied from
  anywhere. Normal dependency usage.

- **systemd unit** (`installers/linux/systemd/lumbre-server.service.template`)
  — read in full. Standard `[Unit]`/`[Service]`/`[Install]` directive
  names (not creative/copyrightable expression) with an explicit,
  original comment attributing the hardening directive *choice* to
  `STATE.md P4.1` / `docs/PLAN.md §11`, not to an external tutorial or
  example unit file. No copied boilerplate text.

- **WiX authoring** (`installers/windows/msi/*.wxs`) — original XML
  markup implementing the WiX v4 schema, with authorial comments
  explaining specific decisions (stable `UpgradeCode`, omitted
  `Package/@Id` for auto-generated `ProductCode`) in Lumbre's own voice,
  not copied from a WiX sample project.

**PASS** — the empty ledger is confirmed plausible, not just assumed.

---

## 4. HEADERS SCRIPT READY

Delivered: `scripts/add-license-headers.mjs`. Design:

- **File discovery via `git ls-files -z`**, not a hand-maintained
  directory walk — every gitignored build/vendor/dist tree (`node_modules`,
  `dist`, `.next`, `.turbo`, `vendor/`, `installers/*/.build*`, `reports/`,
  etc.) is excluded for free, with zero duplicated exclusion-list
  maintenance against `.gitignore` (contrast with `scripts/grep-gates.mjs`'s
  hand-maintained `EXCLUDED_DIR_NAMES` set, deliberately not repeated
  here).
- **Scope**: `.ts .tsx .js .jsx .mjs .cjs .cs .swift .sh .sql .css` — 848
  of the repo's 1572 tracked files. Deliberately excludes JSON (no comment
  syntax), YAML/Markdown/XML-WXS/Dockerfile (config/docs/markup, each with
  its own header-placement rules — flagged as a documented follow-up, not
  silently dropped).
- **Generated-file detection**: skips any file whose first two lines
  contain the literal token `GENERATED` — the exact marker convention
  already used by every generated file actually committed in this repo
  (`packages/sdk/src/generated/{paths,types}.ts`,
  `packages/shared/src/{version,update-public-key}.ts`,
  `packages/db/schema.sql`).
- **Idempotent**: a file already containing the SPDX line is left alone
  and counted separately. Verified by running the script twice in a row on
  the swap branch (§5) — second run touched 0 files.
- **Shebang- and `swift-tools-version`-aware**: inserts as line 2, not
  line 1, when line 1 is load-bearing for a toolchain (`#!...` or Swift's
  `// swift-tools-version:` pragma, required to be literally first for
  Swift Package Manager).
- **Safe by default**: dry-run unless `--write` is passed. Never touches
  `node_modules`, never invokes `pnpm`.

Correctness was verified two ways: (a) a throwaway sandbox git repo
exercising every code path (shebang `.mjs`, plain `.ts`, `.css` block
comment, `.sql` line comment, `.sh` with shebang, `Package.swift` with the
tools-version pragma, a `GENERATED`-marked file, an already-headered file)
— every case produced byte-correct output and the second dry-run showed 0
remaining; (b) real application on the swap branch (§5) with `--write`,
followed by `git diff --numstat` showing **exactly** 843 files with `+1/
-0` (pure header-line insertions) and 2 files with `+1/-1` (the two
`package.json`s that had `"license": "SEE LICENSE-INTENT.md"` replaced in
place) — mathematically ruling out any accidental content loss across all
861 touched files, plus a clean `node --check` pass on all 54 touched
`.mjs`/`.cjs` files and a clean `tsc --noEmit` pass (22/22 packages) on
the branch.

### Dry-run report (main, current HEAD — not applied)

```
add-license-headers: DRY-RUN
  tracked files (git ls-files): 1572
  in-scope by extension: 848
  skipped (generated-marker): 5
  would touch: 843
  by extension:
    .cjs: 2
    .cs: 14
    .css: 58
    .mjs: 51
    .sh: 3
    .sql: 12
    .swift: 21
    .ts: 605
    .tsx: 77
  sample (first 15):
    .dependency-cruiser.cjs
    apps/server/bin/lumbre.mjs
    apps/server/scripts/dev.mjs
    apps/server/src/app.module.ts
    apps/server/src/bootstrap/provisioning.ts
    apps/server/src/catalog/admin-crash-files.spec.ts
    apps/server/src/catalog/admin-crash-files.ts
    apps/server/src/catalog/admin-logs-tail.spec.ts
    apps/server/src/catalog/admin-logs-tail.ts
    apps/server/src/catalog/admin.controller.ts
    apps/server/src/catalog/catalog.module.ts
    apps/server/src/catalog/cross-type.controller.ts
    apps/server/src/catalog/data-freedom.controller.ts
    apps/server/src/catalog/devices.controller.ts
    apps/server/src/catalog/images.controller.ts
    ...and 828 more (--verbose to list all)

  Re-run with --write to apply (relicense event / swap branch only — never on main outside that event).
```

`main` itself is untouched — this is a dry-run report only, per the
mission's explicit instruction not to apply headers outside the relicense
event. **PASS.**

---

## 5. LICENSE SWAP PR — DRAFTED, NOT MERGED

**Branch:** `chore/agpl-relicense`
**Commit:** `5d025cf0c68dc8bed654743e7c54146af8a32210`
**Pushed to:** `origin/chore/agpl-relicense` (GitHub offered a compare URL;
no PR opened — opening/merging is explicitly the owner's call, outside
this phase)
**Built where:** an isolated `git worktree` (`git worktree add
.claude/worktrees/agpl-relicense -b chore/agpl-relicense`, plain git, not
the session-switching tool), specifically **because** the shared main
checkout had concurrent Wave-3 lane edits in flight
(`packages/db/package.json`, `packages/jobs/package.json`, tsconfigs,
`main.ts`, `.dependency-cruiser.cjs` all showed as modified at dispatch
time) — building the swap commit there would have risked bundling another
lane's in-progress, uncommitted work into this branch's history. The
worktree checks out cleanly from the last committed `main` state
(`8a473be`), fully isolated from that dirty tree; `main` itself was never
touched by this lane. **Deviation from a literal reading of "on a branch"
— explained here for the record; the branch itself is a completely normal
branch off `main` once pushed, this only affected how it was authored.**

**What the one commit contains:**

1. `LICENSE` — the full, unmodified GNU Affero General Public License
   v3.0 text (fetched from `gnu.org/licenses/agpl-3.0.txt`, 661 lines,
   verified for the standard §13 and "END OF TERMS AND CONDITIONS"
   markers).
2. All 15 workspace `package.json` files' `"license"` field set to
   `"AGPL-3.0-only"` — 13 new fields added (root `lumbre` + 12
   `@lumbre/*` packages that previously had none), 2 replaced in place
   (`packages/contract`, `packages/sdk`, previously `"SEE
   LICENSE-INTENT.md"`). Verified every file parses as valid JSON and
   `require('./package.json').license === 'AGPL-3.0-only'` for all 15
   after the edit.
3. `scripts/add-license-headers.mjs --write` applied — 843 files got the
   `SPDX-License-Identifier: AGPL-3.0-only` header (verified via the
   `+1/-0`-per-file `git diff --numstat` check in item 4).
4. `LICENSE-INTENT.md` updated: "Current status" now describes this
   branch as the drafted-not-merged relicense commit and explicitly
   restates that merging remains the owner's decision and `main` stays
   private/proprietary until then; plus the two additive corrections from
   items 1.2 and 2.3 (`spdx-ranges@2.1.1` tooling-exclusion row; the
   ffmpeg macos-arm64 GPL-version nuance).

**Build verification run on the branch** (beyond the "bonus" bar):

| Check | Result |
|---|---|
| `pnpm install --frozen-lockfile` (isolated worktree — safe, no shared-checkout risk) | Clean, 4.7s, 794/794 packages reused from store, 0 downloads needed |
| `pnpm run typecheck` (turbo, all packages) | **22/22 successful** |
| `node scripts/grep-gates.mjs` | **PASS** — 1488 files scanned, 0 violations |
| `license-checker-rseidelsohn` (root-scoped, identical flags to the `license-check` script) | **PASS**, exit 0 (same underlying gap as item 1.1 applies here too — root-scoped, not the full union) |
| `node --check` on all 54 touched `.mjs`/`.cjs` files | 0 syntax errors |

Not run: the full `pnpm gate` chain (codegen/oasdiff/depcruise/dep-audit/
lint/full test suite/db:migrate-check) — would require a live Postgres +
substantially more time than this lane's remaining budget, and isn't
needed to establish "the branch builds" per the mission's bonus framing.
Typecheck-clean across all 22 packages plus a syntax-clean sweep of every
touched non-TS file is strong, targeted evidence that the header sweep
and the license-field flips didn't break anything; a full `pnpm gate` run
is recommended before any eventual merge decision, same as any other PR.

**PR-body draft** (for whenever the owner opens the PR):

> ### AGPL-3.0-only relicense — DO NOT MERGE without an explicit go-public decision
>
> Rehearses the one-commit relicense event `LICENSE-INTENT.md` has
> described since Phase 0 (D12): adds the full AGPL-3.0-only `LICENSE`
> text, sets every workspace `package.json`'s `license` field, and sweeps
> `SPDX-License-Identifier` headers onto 843 source files via
> `scripts/add-license-headers.mjs`.
>
> Built and verified per `reports/agpl-readiness.md` (P4.8): dependency
> tree confirmed AGPL-3.0-compatible (798 packages, full inventory in that
> report's Appendix A), vendored-binary aggregation posture confirmed
> sound (ffmpeg/PostgreSQL both spawn as separate processes, never
> linked), provenance ledger confirmed empty-and-plausible, branch
> typechecks clean (22/22) and grep-gates clean.
>
> Two known, pre-existing loose ends carried forward unchanged by this PR
> (tracked in STATE.md Phase 4 Open, not blocking): the ffmpeg macos-arm64
> pin's checksum doesn't match the publisher's own webpage-printed value
> (tamper-after-pin is still caught; second-source re-verification is
> queued as Wave 3 security-review input), and that same platform's exact
> GPL version (2 vs 3) is unconfirmed (doesn't change Lumbre's own
> compliance posture either way — mere aggregation applies regardless).
>
> **Merging this PR makes the repository public source under AGPL-3.0.
> That is the owner's decision alone, per STATE.md P4.8 and
> LICENSE-INTENT.md's "Declared intent" — this PR is the rehearsal, not
> the trigger.**

---

## Deviations from the mission's literal wording — summary

1. **Swap branch authored in an isolated `git worktree`, not the shared
   checkout directly** (§5) — safety measure given concurrent Wave-3 lane
   activity on shared files at dispatch time; the resulting branch itself
   is a completely ordinary branch off `main`, pushed to `origin` exactly
   as instructed.
2. **`pnpm license-check` (the literal documented gate command) could not
   be run as-is** against the shared checkout for the same reason;
   substituted the identical underlying binary invocation (read-only,
   side-effect-free) everywhere in this report, and additionally ran the
   real `pnpm install` + the real gate script inside the isolated
   worktree where it was safe to do so.
3. **`--excludePackages` fix for `spdx-ranges@2.1.1` and the license-check
   root-scan coverage fix are recommended, not applied** — both are
   `package.json`/`scripts/` behavioral changes outside this lane's
   ownership (report + headers script + LICENSE-on-branch +
   LICENSE-INTENT.md corrections only); described precisely enough in
   §1.1/§1.2 for the next dispatch to action directly.
4. **Full `pnpm gate` not run on the swap branch** — typecheck (22/22) +
   grep-gates + syntax-check substituted as targeted, fast evidence the
   branch isn't broken; noted as a recommended pre-merge step rather than
   silently skipped.

---

## Appendix A — Complete dependency license inventory (798 packages)

Generated by unioning `license-checker-rseidelsohn --json` run separately
from each of the 15 workspace roots (root `lumbre` + `apps/server` +
`apps/web` + `apps/worker` + all 11 `packages/*`), deduplicated by
`name@version`. This is the scan that should replace the root-only one
per §1.1's remediation.

| Package | License |
|---|---|
| @asamuzakjp/css-color@3.2.0 | MIT |
| @babel/code-frame@7.29.7 | MIT |
| @babel/helper-validator-identifier@7.29.7 | MIT |
| @babel/runtime@7.29.7 | MIT |
| @borewit/text-codec@0.2.2 | MIT |
| @cacheable/memory@2.2.0 | MIT |
| @cacheable/utils@2.5.0 | MIT |
| @csstools/color-helpers@5.1.0 | MIT-0 |
| @csstools/css-calc@2.1.4 | MIT |
| @csstools/css-color-parser@3.1.0 | MIT |
| @csstools/css-parser-algorithms@3.0.5 | MIT |
| @csstools/css-syntax-patches-for-csstree@1.1.7 | MIT-0 |
| @csstools/css-tokenizer@3.0.4 | MIT |
| @csstools/media-query-list-parser@4.0.3 | MIT |
| @csstools/selector-specificity@5.0.0 | MIT-0 |
| @dual-bundle/import-meta-resolve@4.2.1 | MIT |
| @emotion/is-prop-valid@1.4.0 | MIT |
| @emotion/memoize@0.9.0 | MIT |
| @eslint-community/eslint-utils@4.9.1 | MIT |
| @eslint-community/regexpp@4.12.2 | MIT |
| @eslint/config-array@0.23.5 | Apache-2.0 |
| @eslint/config-helpers@0.6.0 | Apache-2.0 |
| @eslint/core@1.2.1 | Apache-2.0 |
| @eslint/js@10.0.1 | MIT |
| @eslint/object-schema@3.0.5 | Apache-2.0 |
| @eslint/plugin-kit@0.7.2 | Apache-2.0 |
| @exodus/schemasafe@1.3.0 | MIT |
| @faker-js/faker@7.6.0 | MIT |
| @gar/promise-retry@1.0.3 | MIT |
| @humanfs/core@0.19.2 | Apache-2.0 |
| @humanfs/node@0.16.8 | Apache-2.0 |
| @humanfs/types@0.15.0 | Apache-2.0 |
| @humanwhocodes/module-importer@1.0.1 | Apache-2.0 |
| @humanwhocodes/momoa@2.0.4 | Apache-2.0 |
| @humanwhocodes/retry@0.4.3 | Apache-2.0 |
| @img/colour@1.1.0 | MIT |
| @isaacs/fs-minipass@4.0.1 | ISC |
| @isaacs/string-locale-compare@1.1.0 | ISC |
| @jest/schemas@29.6.3 | MIT |
| @jridgewell/sourcemap-codec@1.5.5 | MIT |
| @jsep-plugin/assignment@1.3.0 | MIT |
| @jsep-plugin/regex@1.0.4 | MIT |
| @keyv/bigmap@1.3.1 | MIT |
| @keyv/serialize@1.1.1 | MIT |
| @lukeed/csprng@1.1.0 | MIT |
| @lumbre/contract@0.1.0 | UNLICENSED |
| @lumbre/controller-ipc@0.1.0 | UNLICENSED |
| @lumbre/db@0.1.0 | UNLICENSED |
| @lumbre/jobs@0.1.0 | UNLICENSED |
| @lumbre/playback-engine@0.0.1 | UNLICENSED |
| @lumbre/provisioning-pg@0.1.0 | UNLICENSED |
| @lumbre/provisioning@0.1.0 | UNLICENSED |
| @lumbre/release-manifest@0.1.0 | UNLICENSED |
| @lumbre/sdk@0.1.0 | UNLICENSED |
| @lumbre/secrets@0.1.0 | UNLICENSED |
| @lumbre/server@0.0.1 | UNLICENSED |
| @lumbre/shared@0.0.1 | UNLICENSED |
| @lumbre/web@0.0.1 | UNLICENSED |
| @lumbre/worker@0.0.1 | UNLICENSED |
| @napi-rs/keyring@1.3.0 | MIT |
| @nestjs/common@11.1.28 | MIT |
| @nestjs/core@11.1.28 | MIT |
| @nestjs/platform-express@11.1.28 | MIT |
| @next/env@15.5.21 | MIT |
| @noble/hashes@1.8.0 | MIT |
| @nodable/entities@3.0.0 | MIT |
| @nodelib/fs.scandir@2.1.5 | MIT |
| @nodelib/fs.stat@2.0.5 | MIT |
| @nodelib/fs.walk@1.2.8 | MIT |
| @npmcli/agent@4.0.2 | ISC |
| @npmcli/arborist@9.6.0 | ISC |
| @npmcli/fs@5.0.0 | ISC |
| @npmcli/git@7.0.2 | ISC |
| @npmcli/installed-package-contents@4.0.0 | ISC |
| @npmcli/map-workspaces@5.0.3 | ISC |
| @npmcli/metavuln-calculator@9.0.3 | ISC |
| @npmcli/name-from-folder@4.0.0 | ISC |
| @npmcli/node-gyp@5.0.0 | ISC |
| @npmcli/package-json@7.0.5 | ISC |
| @npmcli/promise-spawn@9.0.1 | ISC |
| @npmcli/query@5.0.0 | ISC |
| @npmcli/redact@4.0.0 | ISC |
| @npmcli/run-script@10.0.4 | ISC |
| @opentelemetry/api-logs@0.53.0 | Apache-2.0 |
| @opentelemetry/api@1.9.0 | Apache-2.0 |
| @opentelemetry/context-async-hooks@1.26.0 | Apache-2.0 |
| @opentelemetry/core@1.26.0 | Apache-2.0 |
| @opentelemetry/exporter-trace-otlp-http@0.53.0 | Apache-2.0 |
| @opentelemetry/otlp-exporter-base@0.53.0 | Apache-2.0 |
| @opentelemetry/otlp-transformer@0.53.0 | Apache-2.0 |
| @opentelemetry/propagator-b3@1.26.0 | Apache-2.0 |
| @opentelemetry/propagator-jaeger@1.26.0 | Apache-2.0 |
| @opentelemetry/resources@1.26.0 | Apache-2.0 |
| @opentelemetry/sdk-logs@0.53.0 | Apache-2.0 |
| @opentelemetry/sdk-metrics@1.26.0 | Apache-2.0 |
| @opentelemetry/sdk-trace-base@1.26.0 | Apache-2.0 |
| @opentelemetry/sdk-trace-node@1.26.0 | Apache-2.0 |
| @opentelemetry/semantic-conventions@1.27.0 | Apache-2.0 |
| @oxc-project/types@0.139.0 | MIT |
| @paralleldrive/cuid2@2.3.1 | MIT |
| @peculiar/asn1-cms@2.8.0 | MIT |
| @peculiar/asn1-csr@2.8.0 | MIT |
| @peculiar/asn1-ecc@2.8.0 | MIT |
| @peculiar/asn1-pfx@2.8.0 | MIT |
| @peculiar/asn1-pkcs8@2.8.0 | MIT |
| @peculiar/asn1-pkcs9@2.8.0 | MIT |
| @peculiar/asn1-rsa@2.8.0 | MIT |
| @peculiar/asn1-schema@2.8.0 | MIT |
| @peculiar/asn1-x509-attr@2.8.0 | MIT |
| @peculiar/asn1-x509@2.8.0 | MIT |
| @peculiar/utils@2.0.3 | MIT |
| @peculiar/x509@1.14.3 | MIT |
| @protobufjs/aspromise@1.1.2 | BSD-3-Clause |
| @protobufjs/base64@1.1.2 | BSD-3-Clause |
| @protobufjs/codegen@2.0.5 | BSD-3-Clause |
| @protobufjs/eventemitter@1.1.1 | BSD-3-Clause |
| @protobufjs/fetch@1.1.1 | BSD-3-Clause |
| @protobufjs/float@1.0.2 | BSD-3-Clause |
| @protobufjs/path@1.1.2 | BSD-3-Clause |
| @protobufjs/pool@1.1.0 | BSD-3-Clause |
| @protobufjs/utf8@1.1.2 | BSD-3-Clause |
| @redocly/ajv@8.11.2 | MIT |
| @redocly/cli@1.34.17 | MIT |
| @redocly/config@0.22.0 | MIT |
| @redocly/openapi-core@1.34.17 | MIT |
| @redocly/respect-core@1.34.17 | MIT |
| @rolldown/pluginutils@1.0.1 | MIT |
| @sigstore/bundle@4.0.0 | Apache-2.0 |
| @sigstore/core@3.2.1 | Apache-2.0 |
| @sigstore/protobuf-specs@0.5.1 | Apache-2.0 |
| @sigstore/sign@4.1.1 | Apache-2.0 |
| @sigstore/tuf@4.0.2 | Apache-2.0 |
| @sigstore/verify@3.1.1 | Apache-2.0 |
| @sinclair/typebox@0.27.12 | MIT |
| @standard-schema/spec@1.1.0 | MIT |
| @swc/helpers@0.5.15 | Apache-2.0 |
| @tokenizer/inflate@0.4.1 | MIT |
| @tokenizer/token@0.3.0 | MIT |
| @tufjs/canonical-json@2.0.0 | MIT |
| @tufjs/models@4.1.0 | MIT |
| @types/body-parser@1.19.6 | MIT |
| @types/chai@5.2.3 | MIT |
| @types/connect@3.4.38 | MIT |
| @types/cookiejar@2.1.5 | MIT |
| @types/deep-eql@4.0.2 | MIT |
| @types/esrecurse@4.3.1 | MIT |
| @types/estree@1.0.9 | MIT |
| @types/express-serve-static-core@5.1.2 | MIT |
| @types/express@5.0.6 | MIT |
| @types/http-errors@2.0.5 | MIT |
| @types/json-schema@7.0.15 | MIT |
| @types/methods@1.1.4 | MIT |
| @types/node@26.1.1 | MIT |
| @types/pg@8.20.0 | MIT |
| @types/qs@6.15.1 | MIT |
| @types/range-parser@1.2.7 | MIT |
| @types/react-dom@19.2.3 | MIT |
| @types/react@19.2.17 | MIT |
| @types/send@1.2.1 | MIT |
| @types/serve-static@2.2.0 | MIT |
| @types/superagent@8.1.11 | MIT |
| @types/supertest@7.2.1 | MIT |
| @types/ws@8.18.1 | MIT |
| @typescript-eslint/eslint-plugin@8.65.0 | MIT |
| @typescript-eslint/parser@8.65.0 | MIT |
| @typescript-eslint/project-service@8.65.0 | MIT |
| @typescript-eslint/scope-manager@8.65.0 | MIT |
| @typescript-eslint/tsconfig-utils@8.65.0 | MIT |
| @typescript-eslint/type-utils@8.65.0 | MIT |
| @typescript-eslint/types@8.65.0 | MIT |
| @typescript-eslint/typescript-estree@8.65.0 | MIT |
| @typescript-eslint/utils@8.65.0 | MIT |
| @typescript-eslint/visitor-keys@8.65.0 | MIT |
| @vitest/expect@4.1.10 | MIT |
| @vitest/mocker@4.1.10 | MIT |
| @vitest/pretty-format@4.1.10 | MIT |
| @vitest/runner@4.1.10 | MIT |
| @vitest/snapshot@4.1.10 | MIT |
| @vitest/spy@4.1.10 | MIT |
| @vitest/utils@4.1.10 | MIT |
| abbrev@2.0.0 | ISC |
| abbrev@4.0.0 | ISC |
| abort-controller@3.0.0 | MIT |
| accepts@2.0.0 | MIT |
| acme-client@5.4.0 | MIT |
| acorn-jsx-walk@2.0.0 | MIT |
| acorn-jsx@5.3.2 | MIT |
| acorn-loose@8.5.2 | MIT |
| acorn-walk@8.3.5 | MIT |
| acorn@8.17.0 | MIT |
| agent-base@6.0.2 | MIT |
| agent-base@7.1.4 | MIT |
| ajv-formats@3.0.1 | MIT |
| ajv@6.15.0 | MIT |
| ajv@8.20.0 | MIT |
| ansi-colors@4.1.3 | MIT |
| ansi-regex@5.0.1 | MIT |
| ansi-styles@4.3.0 | MIT |
| ansi-styles@5.2.0 | MIT |
| anymatch@3.1.3 | ISC |
| anynum@1.0.1 | MIT |
| append-field@1.0.0 | MIT |
| argparse@2.0.1 | Python-2.0 |
| array-find-index@1.0.2 | MIT |
| array-union@2.1.0 | MIT |
| asap@2.0.6 | MIT |
| asn1js@3.0.10 | BSD-3-Clause |
| assertion-error@2.0.1 | MIT |
| astral-regex@2.0.0 | MIT |
| asynckit@0.4.0 | MIT |
| axios@1.18.1 | MIT |
| balanced-match@1.0.2 | MIT |
| balanced-match@2.0.0 | MIT |
| balanced-match@4.0.4 | MIT |
| better-ajv-errors@1.2.0 | Apache-2.0 |
| bin-links@6.0.2 | ISC |
| binary-extensions@2.3.0 | MIT |
| blurhash@2.0.5 | MIT |
| body-parser@2.3.0 | MIT |
| brace-expansion@1.1.16 | MIT |
| brace-expansion@2.1.2 | MIT |
| brace-expansion@5.0.7 | MIT |
| braces@3.0.3 | MIT |
| buffer-from@1.1.2 | MIT |
| bundle-name@4.1.0 | MIT |
| busboy@1.6.0 | MIT |
| bytes@3.1.2 | MIT |
| cacache@20.0.4 | ISC |
| cacheable@2.5.0 | MIT |
| call-bind-apply-helpers@1.0.2 | MIT |
| call-bound@1.0.4 | MIT |
| call-me-maybe@1.0.2 | MIT |
| callsites@3.1.0 | MIT |
| caniuse-lite@1.0.30001806 | CC-BY-4.0 |
| chai@6.2.2 | MIT |
| chalk@4.1.2 | MIT |
| change-case@5.4.4 | MIT |
| chokidar@3.5.3 | MIT |
| chokidar@5.0.0 | MIT |
| chownr@3.0.0 | BlueOak-1.0.0 |
| classnames@2.5.1 | MIT |
| client-only@0.0.1 | MIT |
| cliui@7.0.4 | ISC |
| clsx@2.1.1 | MIT |
| cmd-shim@8.0.0 | ISC |
| color-convert@2.0.1 | MIT |
| color-name@1.1.4 | MIT |
| colord@2.9.3 | MIT |
| colorette@1.4.0 | MIT |
| colorette@2.0.20 | MIT |
| combined-stream@1.0.8 | MIT |
| commander@15.0.0 | MIT |
| common-ancestor-path@2.0.0 | BlueOak-1.0.0 |
| component-emitter@1.3.1 | MIT |
| concat-map@0.0.1 | MIT |
| concat-stream@2.0.0 | MIT |
| content-disposition@1.1.0 | MIT |
| content-type@1.0.5 | MIT |
| content-type@2.0.0 | MIT |
| convert-source-map@2.0.0 | MIT |
| cookie-signature@1.2.2 | MIT |
| cookie@0.7.2 | MIT |
| cookiejar@2.1.4 | MIT |
| core-js@3.32.1 | MIT |
| cors@2.8.6 | MIT |
| cosmiconfig@9.0.2 | MIT |
| cron-parser@5.6.2 | MIT |
| cross-spawn@7.0.6 | MIT |
| css-functions-list@3.3.3 | MIT |
| css-tree@3.2.1 | MIT |
| cssesc@3.0.0 | MIT |
| cssstyle@4.6.0 | MIT |
| csstype@3.2.3 | MIT |
| data-urls@5.0.0 | MIT |
| debug@4.4.3 | MIT |
| decimal.js@10.6.0 | MIT |
| decko@1.2.0 | MIT* |
| deep-is@0.1.4 | MIT |
| default-browser-id@5.0.1 | MIT |
| default-browser@5.5.0 | MIT |
| define-lazy-prop@3.0.0 | MIT |
| delayed-stream@1.0.0 | MIT |
| depd@2.0.0 | MIT |
| dependency-cruiser@18.1.0 | MIT |
| detect-libc@2.1.2 | Apache-2.0 |
| dezalgo@1.0.4 | ISC |
| diff-sequences@29.6.3 | MIT |
| dir-glob@3.0.1 | MIT |
| dompurify@3.4.12 | (MPL-2.0 OR Apache-2.0) |
| dotenv@16.4.7 | BSD-2-Clause |
| dunder-proto@1.0.1 | MIT |
| ee-first@1.1.1 | MIT |
| emoji-regex@8.0.0 | MIT |
| encodeurl@2.0.0 | MIT |
| enhanced-resolve@5.24.2 | MIT |
| entities@6.0.1 | BSD-2-Clause |
| env-paths@2.2.1 | MIT |
| error-ex@1.3.4 | MIT |
| es-define-property@1.0.1 | MIT |
| es-errors@1.3.0 | MIT |
| es-module-lexer@2.3.1 | MIT |
| es-object-atoms@1.1.2 | MIT |
| es-set-tostringtag@2.1.0 | MIT |
| es6-promise@3.3.1 | MIT |
| esbuild@0.28.1 | MIT |
| escalade@3.2.0 | MIT |
| escape-html@1.0.3 | MIT |
| escape-string-regexp@4.0.0 | MIT |
| eslint-scope@9.1.2 | BSD-2-Clause |
| eslint-visitor-keys@3.4.3 | Apache-2.0 |
| eslint-visitor-keys@5.0.1 | Apache-2.0 |
| eslint@10.7.0 | MIT |
| espree@11.2.0 | BSD-2-Clause |
| esquery@1.7.0 | BSD-3-Clause |
| esrecurse@4.3.0 | BSD-2-Clause |
| estraverse@5.3.0 | BSD-2-Clause |
| estree-walker@3.0.3 | MIT |
| esutils@2.0.3 | BSD-2-Clause |
| etag@1.8.1 | MIT |
| event-target-shim@5.0.1 | MIT |
| eventemitter3@5.0.4 | MIT |
| expect-type@1.4.0 | Apache-2.0 |
| exponential-backoff@3.1.3 | Apache-2.0 |
| express@5.2.1 | MIT |
| fast-deep-equal@3.1.3 | MIT |
| fast-glob@3.3.3 | MIT |
| fast-json-stable-stringify@2.1.0 | MIT |
| fast-levenshtein@2.0.6 | MIT |
| fast-safe-stringify@2.1.1 | MIT |
| fast-uri@3.1.4 | BSD-3-Clause |
| fast-xml-builder@1.3.0 | MIT |
| fast-xml-parser@5.10.1 | MIT |
| fastest-levenshtein@1.0.16 | MIT |
| fastq@1.20.1 | ISC |
| fdir@6.5.0 | MIT |
| file-entry-cache@11.1.5 | MIT |
| file-entry-cache@8.0.0 | MIT |
| file-type@21.3.4 | MIT |
| fill-range@7.1.1 | MIT |
| finalhandler@2.1.1 | MIT |
| find-up@5.0.0 | MIT |
| flat-cache@4.0.1 | MIT |
| flat-cache@6.1.23 | MIT |
| flatted@3.4.2 | ISC |
| follow-redirects@1.16.0 | MIT |
| foreach@2.0.6 | MIT |
| form-data@4.0.6 | MIT |
| formidable@3.5.4 | MIT |
| forwarded@0.2.0 | MIT |
| fresh@2.0.0 | MIT |
| fs-minipass@3.0.3 | ISC |
| fs.realpath@1.0.0 | ISC |
| function-bind@1.1.2 | MIT |
| get-caller-file@2.0.5 | ISC |
| get-intrinsic@1.3.0 | MIT |
| get-port-please@3.0.1 | MIT |
| get-proto@1.0.1 | MIT |
| glob-parent@5.1.2 | ISC |
| glob-parent@6.0.2 | ISC |
| glob@13.0.6 | BlueOak-1.0.0 |
| glob@7.2.3 | ISC |
| global-directory@4.0.1 | MIT |
| global-modules@2.0.0 | MIT |
| global-prefix@3.0.0 | MIT |
| globby@11.1.0 | MIT |
| globjoin@0.1.4 | MIT |
| gopd@1.2.0 | MIT |
| graceful-fs@4.2.11 | ISC |
| handlebars@4.7.9 | MIT |
| has-flag@4.0.0 | MIT |
| has-symbols@1.1.0 | MIT |
| has-tostringtag@1.0.2 | MIT |
| hash-wasm@4.12.0 | MIT |
| hashery@1.5.1 | MIT |
| hasown@2.0.4 | MIT |
| hls.js@1.6.16 | Apache-2.0 |
| hookified@1.15.1 | MIT |
| hookified@2.2.0 | MIT |
| hosted-git-info@9.0.3 | ISC |
| html-encoding-sniffer@4.0.0 | MIT |
| html-tags@3.3.1 | MIT |
| http-cache-semantics@4.2.0 | BSD-2-Clause |
| http-errors@2.0.1 | MIT |
| http-proxy-agent@7.0.2 | MIT |
| http2-client@1.3.5 | MIT |
| https-proxy-agent@5.0.1 | MIT |
| https-proxy-agent@7.0.6 | MIT |
| iconv-lite@0.6.3 | MIT |
| iconv-lite@0.7.3 | MIT |
| ieee754@1.2.1 | BSD-3-Clause |
| ignore-walk@8.0.0 | ISC |
| ignore@5.3.2 | MIT |
| ignore@7.0.6 | MIT |
| import-fresh@3.3.1 | MIT |
| imurmurhash@0.1.4 | MIT |
| index-to-position@1.2.0 | MIT |
| inflight@1.0.6 | ISC |
| inherits@2.0.4 | ISC |
| ini@1.3.8 | ISC |
| ini@4.1.1 | ISC |
| ini@6.0.0 | ISC |
| interpret@3.1.1 | MIT |
| ip-address@10.2.0 | MIT |
| ipaddr.js@1.9.1 | MIT |
| is-arrayish@0.2.1 | MIT |
| is-binary-path@2.1.0 | MIT |
| is-core-module@2.16.2 | MIT |
| is-docker@3.0.0 | MIT |
| is-extglob@2.1.1 | MIT |
| is-fullwidth-code-point@3.0.0 | MIT |
| is-glob@4.0.3 | MIT |
| is-inside-container@1.0.0 | MIT |
| is-installed-globally@1.0.0 | MIT |
| is-number@7.0.0 | MIT |
| is-path-inside@4.0.0 | MIT |
| is-plain-object@5.0.0 | MIT |
| is-potential-custom-element-name@1.0.1 | MIT |
| is-promise@4.0.0 | MIT |
| is-unsafe@2.0.0 | MIT |
| is-wsl@3.1.1 | MIT |
| isexe@2.0.0 | ISC |
| isexe@4.0.0 | BlueOak-1.0.0 |
| iterare@1.2.1 | ISC |
| jest-diff@29.7.0 | MIT |
| jest-get-type@29.6.3 | MIT |
| jest-matcher-utils@29.7.0 | MIT |
| jose@6.2.4 | MIT |
| js-levenshtein@1.1.6 | MIT |
| js-tokens@4.0.0 | MIT |
| js-yaml@4.2.0 | MIT |
| jsdom@25.0.1 | MIT |
| jsep@1.4.0 | MIT |
| json-buffer@3.0.1 | MIT |
| json-parse-even-better-errors@2.3.1 | MIT |
| json-parse-even-better-errors@5.0.0 | MIT |
| json-pointer@0.6.2 | MIT |
| json-schema-traverse@0.4.1 | MIT |
| json-schema-traverse@1.0.0 | MIT |
| json-stable-stringify-without-jsonify@1.0.1 | MIT |
| json-stringify-nice@1.1.4 | ISC |
| json5@2.2.3 | MIT |
| jsonparse@1.3.1 | MIT |
| jsonpath-plus@10.3.0 | MIT |
| jsonpointer@5.0.1 | MIT |
| just-diff-apply@5.5.0 | MIT |
| just-diff@6.0.2 | MIT |
| keyv@4.5.4 | MIT |
| keyv@5.6.0 | MIT |
| kind-of@6.0.3 | MIT |
| kleur@3.0.3 | MIT |
| known-css-properties@0.37.0 | MIT |
| kysely@0.29.4 | MIT |
| leven@3.1.0 | MIT |
| levn@0.4.1 | MIT |
| license-checker-rseidelsohn@5.0.1 | BSD-3-Clause |
| lightningcss@1.33.0 | MPL-2.0 |
| lines-and-columns@1.2.4 | MIT |
| load-esm@1.0.3 | MIT |
| locate-path@6.0.0 | MIT |
| lodash.clonedeep@4.5.0 | MIT |
| lodash.truncate@4.4.2 | MIT |
| long@5.3.2 | Apache-2.0 |
| loose-envify@1.4.0 | MIT |
| lru-cache@10.4.3 | ISC |
| lru-cache@11.5.2 | BlueOak-1.0.0 |
| lucide-react@0.545.0 | ISC |
| lumbre@0.9.0 | UNLICENSED |
| lunr@2.3.9 | MIT |
| luxon@3.7.2 | MIT |
| magic-string@0.30.21 | MIT |
| make-fetch-happen@15.0.6 | ISC |
| mark.js@8.11.1 | MIT |
| marked@4.3.0 | MIT |
| math-intrinsics@1.1.0 | MIT |
| mathml-tag-names@2.1.3 | MIT |
| mdn-data@2.27.1 | CC0-1.0 |
| media-typer@0.3.0 | MIT |
| media-typer@1.1.0 | MIT |
| media-typer@2.0.0 | MIT |
| meow@13.2.0 | MIT |
| merge-descriptors@2.0.0 | MIT |
| merge2@1.4.1 | MIT |
| methods@1.1.2 | MIT |
| micromatch@4.0.8 | MIT |
| mime-db@1.52.0 | MIT |
| mime-db@1.54.0 | MIT |
| mime-types@2.1.35 | MIT |
| mime-types@3.0.2 | MIT |
| mime@2.6.0 | MIT |
| minimatch@10.2.5 | BlueOak-1.0.0 |
| minimatch@3.1.5 | ISC |
| minimatch@5.1.9 | ISC |
| minimist@1.2.8 | MIT |
| minipass-collect@2.0.1 | ISC |
| minipass-fetch@5.0.2 | MIT |
| minipass-flush@1.0.7 | BlueOak-1.0.0 |
| minipass-pipeline@1.2.4 | ISC |
| minipass-sized@2.0.0 | ISC |
| minipass@3.3.6 | ISC |
| minipass@7.1.3 | BlueOak-1.0.0 |
| minizlib@3.1.0 | MIT |
| mkdirp@1.0.4 | MIT |
| mobx-react-lite@4.1.1 | MIT |
| mobx-react@9.2.2 | MIT |
| mobx@6.12.3 | MIT |
| ms@2.1.3 | MIT |
| multer@2.2.0 | MIT |
| music-metadata@11.14.0 | MIT |
| nanoid@3.3.16 | MIT |
| natural-compare@1.4.0 | MIT |
| negotiator@1.0.0 | MIT |
| neo-async@2.6.2 | MIT |
| next@15.5.21 | MIT |
| node-fetch-h2@2.3.0 | MIT |
| node-fetch@2.7.0 | MIT |
| node-forge@1.4.0 | (BSD-3-Clause OR GPL-2.0) |
| node-gyp@12.4.0 | MIT |
| node-readfiles@0.2.0 | MIT |
| non-error@0.1.0 | MIT |
| nopt@7.2.1 | ISC |
| nopt@9.0.0 | ISC |
| normalize-path@3.0.0 | MIT |
| npm-bundled@5.0.0 | ISC |
| npm-install-checks@8.0.0 | BSD-2-Clause |
| npm-normalize-package-bin@5.0.0 | ISC |
| npm-package-arg@13.0.2 | ISC |
| npm-packlist@10.0.4 | ISC |
| npm-pick-manifest@11.0.3 | ISC |
| npm-registry-fetch@19.1.1 | ISC |
| nwsapi@2.2.24 | MIT |
| oas-kit-common@1.0.8 | BSD-3-Clause |
| oas-linter@3.2.2 | BSD-3-Clause |
| oas-resolver@2.5.6 | BSD-3-Clause |
| oas-schema-walker@1.1.5 | BSD-3-Clause |
| oas-validator@5.0.8 | BSD-3-Clause |
| object-assign@4.1.1 | MIT |
| object-inspect@1.13.4 | MIT |
| obug@2.1.4 | MIT |
| on-finished@2.4.1 | MIT |
| once@1.4.0 | ISC |
| open@10.1.0 | MIT |
| openapi-sampler@1.7.0 | MIT |
| openapi-sampler@1.7.4 | MIT |
| openapi-typescript@7.13.0 | MIT |
| optionator@0.9.4 | MIT |
| outdent@0.8.0 | MIT |
| p-limit@3.1.0 | MIT |
| p-locate@5.0.0 | MIT |
| p-map@7.0.6 | MIT |
| pacote@21.5.1 | ISC |
| parent-module@1.0.1 | MIT |
| parse-conflict-json@5.0.1 | ISC |
| parse-json@5.2.0 | MIT |
| parse-json@8.3.0 | MIT |
| parse5@7.3.0 | MIT |
| parseurl@1.3.3 | MIT |
| path-browserify@1.0.1 | MIT |
| path-exists@4.0.0 | MIT |
| path-expression-matcher@1.6.2 | MIT |
| path-is-absolute@1.0.1 | MIT |
| path-key@3.1.1 | MIT |
| path-parse@1.0.7 | MIT |
| path-scurry@2.0.2 | BlueOak-1.0.0 |
| path-to-regexp@8.4.2 | MIT |
| path-type@4.0.0 | MIT |
| pathe@2.0.3 | MIT |
| perfect-scrollbar@1.5.6 | MIT |
| pg-boss@12.26.2 | MIT |
| pg-connection-string@2.14.0 | MIT |
| pg-int8@1.0.1 | ISC |
| pg-pool@3.14.0 | MIT |
| pg-protocol@1.15.0 | MIT |
| pg-types@2.2.0 | MIT |
| pg@8.22.0 | MIT |
| pgpass@1.0.5 | MIT |
| picocolors@1.1.1 | ISC |
| picomatch@2.3.2 | MIT |
| picomatch@4.0.5 | MIT |
| pluralize@8.0.0 | MIT |
| polished@4.3.1 | MIT |
| postcss-resolve-nested-selector@0.1.6 | MIT |
| postcss-safe-parser@7.0.1 | MIT |
| postcss-selector-parser@7.1.4 | MIT |
| postcss-value-parser@4.2.0 | MIT |
| postcss@8.5.21 | MIT |
| postgres-array@2.0.0 | MIT |
| postgres-bytea@1.0.1 | MIT |
| postgres-date@1.0.7 | MIT |
| postgres-interval@1.2.0 | MIT |
| prelude-ls@1.2.1 | MIT |
| pretty-format@29.7.0 | MIT |
| prismjs@1.30.0 | MIT |
| proc-log@6.1.0 | ISC |
| proggy@4.0.0 | ISC |
| promise-all-reject-late@1.0.1 | ISC |
| promise-call-limit@3.0.2 | ISC |
| prompts@2.4.2 | MIT |
| prop-types@15.8.1 | MIT |
| protobufjs@7.6.5 | BSD-3-Clause |
| proxy-addr@2.0.7 | MIT |
| proxy-from-env@2.1.0 | MIT |
| punycode@2.3.1 | MIT |
| pvtsutils@1.3.6 | MIT |
| pvutils@1.1.5 | MIT |
| qified@0.10.1 | MIT |
| qs@6.15.3 | BSD-3-Clause |
| queue-microtask@1.2.3 | MIT |
| randombytes@2.1.0 | MIT |
| range-parser@1.3.0 | MIT |
| raw-body@3.0.2 | MIT |
| react-dom@19.2.8 | MIT |
| react-is@16.13.1 | MIT |
| react-is@18.3.1 | MIT |
| react-tabs@6.1.1 | MIT |
| react@19.2.8 | MIT |
| read-cmd-shim@6.0.0 | ISC |
| readable-stream@3.6.2 | MIT |
| readdirp@3.6.0 | MIT |
| readdirp@5.0.0 | MIT |
| rechoir@0.8.0 | MIT |
| redoc@2.5.0 | MIT |
| reflect-metadata@0.2.2 | Apache-2.0 |
| reftools@1.1.9 | BSD-3-Clause |
| regexp-tree@0.1.27 | MIT |
| require-directory@2.1.1 | MIT |
| require-from-string@2.0.2 | MIT |
| resolve-from@4.0.0 | MIT |
| resolve-from@5.0.0 | MIT |
| resolve@1.22.12 | MIT |
| reusify@1.1.0 | MIT |
| rolldown@1.1.5 | MIT |
| router@2.2.0 | MIT |
| rrweb-cssom@0.7.1 | MIT |
| rrweb-cssom@0.8.0 | MIT |
| run-applescript@7.1.0 | MIT |
| run-parallel@1.2.0 | MIT |
| rxjs@7.8.2 | Apache-2.0 |
| safe-buffer@5.2.1 | MIT |
| safe-regex@2.1.1 | MIT |
| safer-buffer@2.1.2 | MIT |
| saxes@6.0.0 | ISC |
| scheduler@0.27.0 | MIT |
| semver@7.7.4 | ISC |
| semver@7.8.5 | ISC |
| send@1.2.1 | MIT |
| serialize-error@13.0.1 | MIT |
| serve-static@2.2.1 | MIT |
| set-cookie-parser@2.7.1 | MIT |
| setprototypeof@1.2.0 | ISC |
| sharp@0.35.3 | Apache-2.0 |
| shebang-command@2.0.0 | MIT |
| shebang-regex@3.0.0 | MIT |
| should-equal@2.0.0 | MIT |
| should-format@3.0.3 | MIT |
| should-type-adaptors@1.1.0 | MIT |
| should-type@1.4.0 | MIT |
| should-util@1.0.1 | MIT |
| should@13.2.3 | MIT |
| side-channel-list@1.0.1 | MIT |
| side-channel-map@1.0.1 | MIT |
| side-channel-weakmap@1.0.2 | MIT |
| side-channel@1.1.1 | MIT |
| siginfo@2.0.0 | ISC |
| signal-exit@4.1.0 | ISC |
| sigstore@4.1.1 | Apache-2.0 |
| simple-websocket@9.1.0 | MIT |
| sisteransi@1.0.5 | MIT |
| slash@3.0.0 | MIT |
| slice-ansi@4.0.0 | MIT |
| slugify@1.4.7 | MIT |
| smart-buffer@4.2.0 | MIT |
| socks-proxy-agent@8.0.5 | MIT |
| socks@2.8.9 | MIT |
| source-map-js@1.2.1 | BSD-3-Clause |
| source-map@0.6.1 | BSD-3-Clause |
| spdx-compare@1.0.0 | MIT |
| spdx-correct@3.2.0 | Apache-2.0 |
| spdx-exceptions@2.5.0 | CC-BY-3.0 |
| spdx-expression-parse@3.0.1 | MIT |
| spdx-expression-parse@4.0.0 | MIT |
| spdx-license-ids@3.0.23 | CC0-1.0 |
| spdx-ranges@2.1.1 | (MIT AND CC-BY-3.0) |
| spdx-satisfies@6.0.0 | MIT |
| split2@4.2.0 | ISC |
| ssri@13.0.1 | ISC |
| stackback@0.0.2 | MIT |
| statuses@2.0.2 | MIT |
| std-env@4.2.0 | MIT |
| stickyfill@1.1.1 | MIT* |
| streamsearch@1.1.0 | MIT |
| string_decoder@1.3.0 | MIT |
| string-width@4.2.3 | MIT |
| strip-ansi@6.0.1 | MIT |
| strip-bom@3.0.0 | MIT |
| strnum@2.4.1 | MIT |
| strtok3@10.3.5 | MIT |
| styled-components@6.4.1 | MIT |
| styled-jsx@5.1.6 | MIT |
| stylelint-config-recommended@14.0.1 | MIT |
| stylelint-config-standard@36.0.1 | MIT |
| stylelint@16.26.1 | MIT |
| stylis@4.3.6 | MIT |
| superagent@10.3.0 | MIT |
| supertest@7.2.2 | MIT |
| supports-color@10.2.2 | MIT |
| supports-color@7.2.0 | MIT |
| supports-hyperlinks@3.2.0 | MIT |
| supports-preserve-symlinks-flag@1.0.0 | MIT |
| svg-tags@1.0.0 | MIT |
| swagger2openapi@7.0.8 | BSD-3-Clause |
| symbol-tree@3.2.4 | MIT |
| table@6.9.0 | BSD-3-Clause |
| tagged-tag@1.0.0 | MIT |
| tapable@2.3.3 | MIT |
| tar@7.5.21 | BlueOak-1.0.0 |
| tinybench@2.9.0 | MIT |
| tinyexec@1.2.4 | MIT |
| tinyglobby@0.2.17 | MIT |
| tinyrainbow@3.1.0 | MIT |
| tldts-core@6.1.86 | MIT |
| tldts@6.1.86 | MIT |
| to-regex-range@5.0.1 | MIT |
| toidentifier@1.0.1 | MIT |
| token-types@6.1.2 | MIT |
| tough-cookie@5.1.2 | BSD-3-Clause |
| tr46@0.0.3 | MIT |
| tr46@5.1.1 | MIT |
| treeify@1.1.0 | MIT |
| treeverse@3.0.0 | ISC |
| ts-api-utils@2.5.0 | MIT |
| tsconfig-paths-webpack-plugin@4.2.0 | MIT |
| tsconfig-paths@4.2.0 | MIT |
| tslib@1.14.1 | 0BSD |
| tslib@2.8.1 | 0BSD |
| tsx@4.23.1 | MIT |
| tsyringe@4.10.0 | MIT |
| tuf-js@4.1.0 | MIT |
| turbo@2.10.6 | MIT |
| type-check@0.4.0 | MIT |
| type-fest@4.41.0 | (MIT OR CC0-1.0) |
| type-fest@5.8.0 | (MIT OR CC0-1.0) |
| type-is@1.6.18 | MIT |
| type-is@2.1.0 | MIT |
| typedarray@0.0.6 | MIT |
| typescript-eslint@8.65.0 | MIT |
| typescript@5.9.3 | Apache-2.0 |
| uglify-js@3.19.3 | BSD-2-Clause |
| uid@2.0.2 | MIT |
| uint8array-extras@1.5.0 | MIT |
| undici-types@8.3.0 | MIT |
| undici@6.27.0 | MIT |
| unpipe@1.0.0 | MIT |
| uri-js-replace@1.0.1 | MIT |
| uri-js@4.4.1 | BSD-2-Clause |
| url-template@2.0.8 | BSD* |
| use-sync-external-store@1.6.0 | MIT |
| util-deprecate@1.0.2 | MIT |
| validate-npm-package-name@7.0.2 | ISC |
| vary@1.1.2 | MIT |
| vite@8.1.5 | MIT |
| vitest@4.1.10 | MIT |
| w3c-xmlserializer@5.0.0 | MIT |
| walk-up-path@4.0.0 | ISC |
| watskeburt@6.0.0 | MIT |
| webidl-conversions@3.0.1 | BSD-2-Clause |
| webidl-conversions@7.0.0 | BSD-2-Clause |
| whatwg-encoding@3.1.1 | MIT |
| whatwg-mimetype@4.0.0 | MIT |
| whatwg-url@14.2.0 | MIT |
| whatwg-url@5.0.0 | MIT |
| which@1.3.1 | ISC |
| which@2.0.2 | ISC |
| which@6.0.1 | ISC |
| why-is-node-running@2.3.0 | MIT |
| win-guid@0.2.1 | MIT |
| word-wrap@1.2.5 | MIT |
| wordwrap@1.0.0 | MIT |
| wrap-ansi@7.0.0 | MIT |
| wrappy@1.0.2 | ISC |
| write-file-atomic@5.0.1 | ISC |
| write-file-atomic@7.0.1 | ISC |
| ws@7.5.13 | MIT |
| ws@8.21.1 | MIT |
| xml-name-validator@5.0.0 | Apache-2.0 |
| xml-naming@0.3.0 | MIT |
| xmlchars@2.2.0 | MIT |
| xtend@4.0.2 | MIT |
| xxhash-wasm@1.1.0 | MIT |
| y18n@5.0.8 | ISC |
| yallist@4.0.0 | ISC |
| yallist@5.0.0 | BlueOak-1.0.0 |
| yaml-ast-parser@0.0.43 | Apache-2.0 |
| yaml@1.10.3 | ISC |
| yaml@2.9.0 | ISC |
| yargs-parser@20.2.9 | ISC |
| yargs-parser@21.1.1 | ISC |
| yargs@17.0.1 | MIT |
| yocto-queue@0.1.0 | MIT |

---

## Appendix B — headers script source

See `scripts/add-license-headers.mjs` (committed alongside this report).
