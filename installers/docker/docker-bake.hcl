// Loombre :: installers/docker/docker-bake.hcl
//
// Multi-arch build definition (STATE.md P4.1/P4.12 — linux/amd64 +
// linux/arm64). Invoke from the REPO ROOT (the Dockerfile's build context
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

group "default" {
  targets = ["loombre"]
}

target "loombre" {
  context    = "."
  dockerfile = "Dockerfile"
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

// Single-platform convenience targets — faster local iteration than
// waiting on QEMU-emulated arm64 every time (bake's default `loombre`
// target above is what actually proves multi-arch cleanliness).
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
