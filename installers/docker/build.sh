#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Loombre :: installers/docker/build.sh
#
# Thin wrapper around `docker buildx bake` (installers/docker/docker-bake.hcl)
# that fills in the version/revision/date build-args from the actual repo
# state instead of requiring the caller to compute them. Run from anywhere;
# always operates against the repo root regardless of cwd.
#
# Usage:
#   installers/docker/build.sh                 # both arches, load nothing (buildx keeps them in its cache)
#   installers/docker/build.sh --load           # single-platform (host arch) build, loads into `docker images`
#   installers/docker/build.sh loombre-amd64     # one arch only, still multi-arch-capable via buildx
#
# Requires: docker buildx with a builder that has QEMU emulation available
# for the non-native platform (Docker Desktop ships this; on plain Linux
# hosts, `docker run --privileged --rm tonistiigi/binfmt --install all`
# once, per the standard buildx multi-arch setup — not this script's job
# to install).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

LOOMBRE_VERSION="$(node -p "require('./package.json').version")"
VCS_REF="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

export LOOMBRE_VERSION VCS_REF BUILD_DATE

echo "installers/docker/build.sh: LOOMBRE_VERSION=$LOOMBRE_VERSION VCS_REF=$VCS_REF BUILD_DATE=$BUILD_DATE" >&2

exec docker buildx bake -f installers/docker/docker-bake.hcl "$@"
