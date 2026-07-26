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
     Version 0.9.0, no release published yet — root package.json,
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
   + systemd      MSI       .pkg     image        manifest
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
previous stages' outputs). `server` and `worker` run from this same image
with different startup commands — see `docs/install/docker.md` for the
operator-facing detail on why one image serves both roles.

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
over `SHA256SUMS` (`scripts/release/sign-manifest.mjs`, keyed by a secret
held only in CI), and GitHub artifact attestation
(`actions/attest-build-provenance`) — plus cosign keyless signing (GitHub
OIDC) specifically for the Docker image. `keys/README.md` documents the
minisign keypair lifecycle: the public half must stay byte-identical in
three places (the repository's `keys/minisign.pub`, the docs site, and
every release's notes), checked in CI by
`scripts/release/check-pubkey-consistency.mjs`. As of this writing,
`keys/minisign.pub` is still the documented all-zero placeholder — no real
release has been signed yet (version `0.9.0`, pre-v1.0, no tag pushed).

## `.github/workflows/release.yml`

The tag-triggered pipeline that builds the Linux tarball, Windows MSI, and
macOS `.pkg` (arm64; x64 is a known pending gap, needing an Intel runner),
pushes the multi-arch Docker image, assembles and signs the release
manifest and `SHA256SUMS`, and attests build provenance for every
artifact.
