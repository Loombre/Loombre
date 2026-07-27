// Loombre :: installers/docker/docker-bake.hcl
//
// Multi-arch build definition (STATE.md P4.1/P4.12 — linux/amd64 +
// linux/arm64) for BOTH shipped images: `loombre` (server/worker) and
// `loombre-web` (the web client) — one Dockerfile, two final stages (see
// its header). Invoke from the REPO ROOT (the Dockerfile's build context
// is `.`, not this directory):
//
//   docker buildx bake -f installers/docker/docker-bake.hcl [target]
//
// or use installers/docker/build.sh, which wraps this with the version/
// revision/date build-args populated for you and is what
// installers/docker/smoke.mjs itself calls.
//
// Both platforms are verified to build cleanly via QEMU emulation on a
// single host as part of this lane's exit criteria — see
// installers/docker/BUILD-NOTES.md for what that run actually found
// (native-module/prebuilt-binary behavior under emulated arm64, image
// sizes per arch, etc.).

variable "LOOMBRE_VERSION" {
  default = "0.0.0"
}
variable "VCS_REF" {
  default = "unknown"
}
variable "BUILD_DATE" {
  default = "unknown"
}
variable "LOOMBRE_IMAGE" {
  default = "loombre"
}

// Default group builds BOTH shipped images (installer completeness audit):
// `loombre` (server/worker, the Dockerfile's `runtime` stage) and
// `loombre-web` (the web client, its `web` stage) — so build.sh /
// `bake --push` publish the complete Docker channel in one invocation.
// Anything consuming bake's --metadata-file (release.yml's digest
// extraction for cosign) keys per TARGET NAME: "loombre", "loombre-web".
group "default" {
  targets = ["loombre", "loombre-web"]
}

target "loombre" {
  context    = "."
  dockerfile = "Dockerfile"
  // Explicit stage now that the Dockerfile has a second final stage
  // (`web`): an untargeted build compiles the LAST stage — still
  // `runtime` today, but that's file position, not a contract.
  target     = "runtime"
  platforms  = ["linux/amd64", "linux/arm64"]
  tags       = ["${LOOMBRE_IMAGE}:${LOOMBRE_VERSION}", "${LOOMBRE_IMAGE}:latest"]
  args = {
    LOOMBRE_VERSION = "${LOOMBRE_VERSION}"
    VCS_REF        = "${VCS_REF}"
    BUILD_DATE     = "${BUILD_DATE}"
  }
  // ── SIGN HOOK ──────────────────────────────────────────────────────────
  // cosign image signing is lane I's release-pipeline concern (STATE.md
  // P4.1: "cosign-signed Docker images"), not this lane's. This marker is
  // the agreed insertion point: lane I's release workflow runs
  //   cosign sign --key <release-key> ${LOOMBRE_IMAGE}:${LOOMBRE_VERSION}@<digest>
  // (or keyless/OIDC signing, per lane I's own evaluation) AFTER a
  // `docker buildx bake --push` publishes the manifest list this target
  // produces, keyed on the resulting digest — never on the tag alone. No
  // signing happens in this lane; multi-arch `bake` output is exactly what
  // that step needs to exist first.
  // ─────────────────────────────────────────────────────────────────────

  // Per-arch build cache: keeps repeat `bake` invocations (e.g. CI re-runs
  // across lane I's pipeline) from re-fetching pnpm's store or ffmpeg's
  // ~120-230 MB archive per platform every time. Local `cache-dir` here;
  // lane I's CI wiring can swap these for `type=gha` without touching
  // anything else in this file.
  cache-from = ["type=local,src=.buildx-cache"]
  cache-to   = ["type=local,dest=.buildx-cache,mode=max"]
}

// ─────────────────────────────────────────────────────────────────────────
// Web-client image (installer completeness audit): the Dockerfile's `web`
// final stage — apps/web's Next standalone server — as its own image, with
// the SAME tag scheme and platforms as `loombre` above. The image name
// derives from ${LOOMBRE_IMAGE} + "-web" so release.yml's
// LOOMBRE_IMAGE=ghcr.io/<owner>/loombre yields ghcr.io/<owner>/loombre-web
// with no second variable to keep in sync (local builds get "loombre-web").
// ─────────────────────────────────────────────────────────────────────────
target "loombre-web" {
  context    = "."
  dockerfile = "Dockerfile"
  target     = "web"
  platforms  = ["linux/amd64", "linux/arm64"]
  tags       = ["${LOOMBRE_IMAGE}-web:${LOOMBRE_VERSION}", "${LOOMBRE_IMAGE}-web:latest"]
  args = {
    LOOMBRE_VERSION = "${LOOMBRE_VERSION}"
    VCS_REF        = "${VCS_REF}"
    BUILD_DATE     = "${BUILD_DATE}"
  }
  // ── SIGN HOOK ────────────────────────────────────────────────────────
  // Same insertion-point contract as `loombre`'s marker above: after
  // `bake --push`, this target's published digest needs its OWN
  // `cosign sign ...@<digest>` in release.yml (bake's --metadata-file
  // carries it under the "loombre-web" key) — signing only the server
  // image would leave the web image unverifiable.
  // ─────────────────────────────────────────────────────────────────────

  // SEPARATE cache dir from `loombre`, not shared: two targets exporting
  // type=local cache into the SAME dest overwrite each other's index
  // (local cache-to replaces the destination's content per export — it
  // does not merge across targets), so sharing `.buildx-cache` would make
  // whichever target finishes last evict the other's layers every run.
  cache-from = ["type=local,src=.buildx-cache-web"]
  cache-to   = ["type=local,dest=.buildx-cache-web,mode=max"]
}

// Single-platform convenience targets — faster local iteration than
// waiting on QEMU-emulated arm64 every time (bake's default group above is
// what actually proves multi-arch cleanliness).
target "loombre-amd64" {
  inherits  = ["loombre"]
  platforms = ["linux/amd64"]
  tags      = ["${LOOMBRE_IMAGE}:${LOOMBRE_VERSION}-amd64"]
}

target "loombre-arm64" {
  inherits  = ["loombre"]
  platforms = ["linux/arm64"]
  tags      = ["${LOOMBRE_IMAGE}:${LOOMBRE_VERSION}-arm64"]
}

target "loombre-web-amd64" {
  inherits  = ["loombre-web"]
  platforms = ["linux/amd64"]
  tags      = ["${LOOMBRE_IMAGE}-web:${LOOMBRE_VERSION}-amd64"]
}

target "loombre-web-arm64" {
  inherits  = ["loombre-web"]
  platforms = ["linux/arm64"]
  tags      = ["${LOOMBRE_IMAGE}-web:${LOOMBRE_VERSION}-arm64"]
}
