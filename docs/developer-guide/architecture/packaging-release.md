# Architecture: Packaging & release

<!-- Sourcing: installers/ layout (docker/, windows/, macos/, linux/
     subdirectories plus embedded-pg-manifest.json, ffmpeg-manifest.json,
     sign-hook.mjs at the installers/ top level) and root Dockerfile stage
     names (base -> pruner -> builder -> prod-deps -> ffmpeg-fetch ->
     runtime) — verified by direct inspection. scripts/release/ listing
     and stamp-version.mjs/embed-public-key.mjs's one-line purpose —
     scripts/release/{stamp-version,embed-public-key}.mjs headers.
     .github/workflows/release.yml producing per-platform artifacts + a
     multi-arch Docker image, SHA256SUMS (scripts/release/sha256sums.mjs),
     minisign signing, actions/attest-build-provenance, and cosign keyless
     signing via GitHub OIDC — confirmed present in that workflow file.
     keys/README.md — three-location minisign public-key consistency
     check (checked in CI by scripts/release/check-pubkey-consistency.mjs).
     Version 0.9.0-rc.11, no release published yet — root package.json,
     CHANGELOG.md's "Convention note (pre-v1.0)". -->

Loombre ships as four independent artifact types from one source tree, all
built from the same version-stamped source.

```
                    root package.json "version"
                              │
              scripts/release/stamp-version.mjs
                              │
                              ▼
              packages/shared/src/version.ts
     (the ONE place every consumer reads: /system/info,
      the `loombre` CLI, the release manifest builder)
                              │
        ┌───────────┬─────────┼─────────┬───────────┐
        ▼           ▼         ▼         ▼           ▼
   Linux tarball  Windows   macOS    Docker      release
   + systemd      .exe      .pkg     images       manifest
   (installers/   (install- (install- (root       (scripts/
   linux/)        ers/      ers/      Dockerfile,  release/
                  windows/) macos/)   multi-arch)  build-
                                                    manifest.mjs)
```

## The Docker image

The root `Dockerfile` is multi-stage: `base` (Node 24 on Debian slim, pnpm
via corepack) → `pruner` (Turborepo prune to just the needed workspace
subset) → `builder` (full install + build) → `prod-deps` (a **separate**
from-scratch production-only install, not a mutated copy of the build
stage's tree) → `ffmpeg-fetch` (vendors pinned static ffmpeg/ffprobe
binaries) → `runtime` (the actual shipped image, assembled from the
previous stages' outputs). One stage sits outside that chain:
`wg-native-build` (a `golang` stage, the only one not derived from
`base`) compiles `packages/wg-native`'s embedded WireGuard c-shared
library natively per target architecture and feeds its `.so` directly
into `runtime`, independent of the pruner/builder/prod-deps/ffmpeg-fetch
chain. `server` and `worker` run from this same image
with different startup commands. Three further stages — `web-pruner` →
`web-builder` → `web` — build apps/web's Next.js standalone server as a
**second, independently shipped image** (`ghcr.io/loombre/loombre-web`,
its own bake target in `installers/docker/docker-bake.hcl`, cosign-signed
separately by release.yml). So the Docker distribution is two images:
`loombre` (server+worker, role chosen by startup command) and
`loombre-web` (the browser-facing UI) — see `docs/install/docker.md` for
the operator-facing detail.

## The other three installers

`installers/linux`, `installers/windows`, `installers/macos` each own a
build script (`build-tarball.mjs`, `build-msi.mjs`, `build-pkg.mjs`) plus
their own packaging assets (systemd units, an MSI/WiX project, a
menubar/tray controller app). All three, plus Docker, are documented from
the installing user's side in the [Install](../../install/index.md) section — this
page is the source-tree map, not a repeat of that content.

## Release signing

Every release artifact carries three independent verification layers
(fully specified for installers, from the operator's side, in
[docs/install/index.md](../../install/index.md#why-are-the-installers-unsigned)):
SHA-256 checksums (`scripts/release/sha256sums.mjs`), a minisign signature
over `SHA256SUMS` (the inline `minisign -S` step in
`.github/workflows/release.yml`'s `release` job, keyed by the
`LOOMBRE_MINISIGN_SECKEY` CI secret — `scripts/release/sign-manifest.mjs`
is a local-only helper for signing outside CI, e.g. a hotfix cut off the
normal pipeline, and is never invoked by CI itself), and GitHub artifact
attestation (`actions/attest-build-provenance`) — plus cosign keyless
signing (GitHub OIDC) specifically for the Docker image. `keys/README.md`
documents the minisign keypair lifecycle: the public half must stay
byte-identical across `keys/minisign.pub`, the docs site
(`docs/ops/updating.md`), and every release's notes (the three P4.9 trust
roots), plus the GENERATED `packages/shared/src/update-public-key.ts` and
`docs/install/linux.md` — all five checked in CI by
`scripts/release/check-pubkey-consistency.mjs`, which also fails outright
if any of them (or any other docs page carrying the marker block) still
holds the all-zero placeholder key. `keys/minisign.pub` is the real,
in-use signing key (key ID `9EA9BD1D8785E084`) — the placeholder era is
over; see `keys/README.md` for the rotation story if the keypair is ever
replaced.

## `.github/workflows/release.yml`

The tag-triggered pipeline that builds the Linux tarball, the Windows
Burn-bundle `.exe` (which chains the VC++ redistributable ahead of an
internally-built MSI — the MSI itself is deliberately **not** published
as a separate release asset; the bundle's success page offers a Launch
button that opens the tray and then the browser at the setup wizard), and
macOS `.pkg` (two per release, one matrix leg per architecture: arm64 on
`macos-latest`, x64 natively on `macos-15-intel` — Intel support is
demand-based, see the [macOS install guide](../../install/macos.md)),
pushes the two multi-arch Docker images (`loombre`, `loombre-web`),
assembles and signs the release
manifest and `SHA256SUMS`, and attests build provenance for every
artifact.
