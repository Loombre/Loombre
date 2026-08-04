# syntax=docker/dockerfile:1.7

# Loombre :: Dockerfile (repo root)
#
# Canonical Docker distribution (STATE.md P4.1/P4.9/P4.12, docs/PLAN.md
# §11 "Docker/Compose (canonical)"). Lane I2 (Phase 4 Wave 1) — greenfield,
# no prior Dockerfile existed.
#
# ONE image, TWO roles: this image contains apps/server AND apps/worker.
# Which one runs is selected by the container's command — docker-compose.prod.yml
# runs one container from this image with the default CMD (server) and a
# second with an overridden `command:` (worker). See that file's header
# comment for the one-image, two-container rationale (short version: the
# server and worker share their entire dependency graph — @loombre/db,
# @loombre/jobs, @loombre/playback-engine, @loombre/shared — so a second image
# would duplicate every layer above the two ~1 MB dist/ directories that
# actually differ; one image keeps the tag/push/pull/scan surface singular
# and the two processes trivially in version-lockstep, which matters more
# for a solo-maintainer AGPL project than the marginal "pull only what you
# run" saving a split would buy).
#
# PLUS a second, independent final stage `web` (installer completeness
# audit — the compose stack previously shipped no way to reach the UI at
# all): apps/web's Next.js standalone server as its OWN image
# (`--target web`; installers/docker/docker-bake.hcl's `loombre-web`
# target). The one-image rationale above does NOT extend to it — the web
# client shares essentially none of the server/worker runtime graph (no
# ffmpeg, no @loombre/db, no pg; its standalone build carries its own
# pruned node_modules) — so a separate image is the smaller, simpler shape
# here, not a contradiction of that reasoning. The `runtime` stage stays
# LAST in this file deliberately: an untargeted `docker build .` still
# produces the server/worker image, exactly as before the web path landed.
#
# Multi-arch: built for linux/amd64 and linux/arm64 via buildx (see
# installers/docker/docker-bake.hcl). Every native dependency below (sharp,
# hash-wasm/argon2id, xxhash-wasm, the fetched ffmpeg/ffprobe pair) resolves
# per-arch automatically — see installers/docker/BUILD-NOTES.md for what
# was actually verified building both architectures locally via QEMU.
#
# ─────────────────────────────────────────────────────────────────────────
# Stage: base — shared foundation, pnpm via corepack (root package.json
# pins the "packageManager" field — corepack reads it itself,
# so no version is hardcoded here).
# ─────────────────────────────────────────────────────────────────────────
FROM node:24.18.0-bookworm-slim AS base
# NEXT_TELEMETRY_DISABLED: Next phones telemetry.nextjs.org on `next build`
# (privacy-review F2). D14 bans phone-home; suppress it at the image level so
# no build stage inheriting from base ever emits it. Belt-and-suspenders with
# CI=true (which Next also treats as telemetry-off, but that's undocumented).
ENV CI=true \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable

# ─────────────────────────────────────────────────────────────────────────
# Stage: pruner — turbo prune reduces the workspace to exactly what
# @loombre/server and @loombre/worker need at runtime (server, worker, db,
# jobs, playback-engine, provisioning, provisioning-pg, shared, sdk, plus
# release-manifest — see the explicit third scope argument below — NOT
# apps/web, NOT the rest of the installer packages; apps/web gets its OWN
# prune stage, `web-pruner` below, and that stage's header explains why
# the two scopes stay separate). `pnpm dlx` fetches a
# standalone turbo CLI so this
# stage doesn't need a full `pnpm install` just to run one command.
#
# KNOWN GOTCHA (verified empirically, not from docs): `turbo prune`'s
# out/full/ does NOT include root-level config files outside the pruned
# packages' own directories, even when a pruned package's tsconfig.json
# `extends` one (../../tsconfig.base.json). Every non-db, non-sdk package
# here extends it — build fails without it. Fixed below by copying it
# explicitly from THIS stage's own full (unpruned) checkout, which still
# has it at /repo/tsconfig.base.json.
#
# `@loombre/release-manifest` is included in the prune scope EXPLICITLY
# even though nothing in @loombre/server's or @loombre/worker's own
# `dependencies` names it — apps/server/package.json's `prebuild`/
# `pretypecheck`/`pretest` scripts each independently run
# `tsc -p ../../packages/release-manifest/tsconfig.json` as a bare relative
# path (verifying that package's own types compile before touching
# server's own build/typecheck/test). turbo prune's dependency-graph
# walk has no way to discover that reference — it isn't a package.json
# edge — so without this explicit extra scope, `@loombre/release-manifest`
# is silently missing from `out/full/` and the `prebuild` step 404s on a
# tsconfig.json that was never copied. Confirmed by reproducing the exact
# failure and fixing it this way — see installers/docker/BUILD-NOTES.md.
# ─────────────────────────────────────────────────────────────────────────
FROM base AS pruner
WORKDIR /repo
COPY . .
RUN pnpm dlx turbo@2.10.7 prune @loombre/server @loombre/worker @loombre/release-manifest --docker

# ─────────────────────────────────────────────────────────────────────────
# Stage: builder — full install (incl. devDependencies — tsc, turbo itself
# for the build task graph) against the pruned lockfile, then compile.
#
# A BuildKit cache mount keyed on the pnpm content-addressable store lets
# this install and the independent `prod-deps` stage below share downloaded
# package bytes without either stage seeing the other's node_modules.
# ─────────────────────────────────────────────────────────────────────────
FROM base AS builder
WORKDIR /repo
COPY --from=pruner /repo/out/json/ .
COPY --from=pruner /repo/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN --mount=type=cache,id=loombre-pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY --from=pruner /repo/out/full/ .
COPY --from=pruner /repo/tsconfig.base.json ./tsconfig.base.json
RUN pnpm exec turbo run build --filter=@loombre/server --filter=@loombre/worker
# turbo's `^build` graph builds each app's dependency closure first, so this
# one filter also produces dist/ for @loombre/db, @loombre/jobs, and every
# other workspace dep. As of Phase 4 Wave 3 (lane STRUCT) db and jobs ship
# REAL dist builds with `exports` pointing at dist/ — so the runtime loads
# plain compiled JS with zero loaders (the old `--import tsx` runtime shim +
# its tsx/esbuild/ajv cp-RL snapshot mechanism is DELETED; `node
# dist/main.js` Just Works, proven by the struct-lane + orchestrator
# plain-node boot). ajv is now a real `dependencies` entry of apps/server
# (Wave 1 integration), so the `--prod` install below includes it — no shim.

# ─────────────────────────────────────────────────────────────────────────
# Stage: prod-deps — a SEPARATE, from-scratch `--prod` install (not an
# in-place prune of the builder's install). Verified empirically: mutating
# an already-devDependencies-installed tree with `pnpm install --prod`
# removes the top-level symlinks but leaves the underlying content-
# addressable store untouched (238 MB before -> 252 MB "after" pruning in
# a real measurement), because pnpm doesn't garbage-collect the store on a
# plain install. A fresh install using ONLY the pruned prod dependency set
# never has that content in its store in the first place (149 packages /
# 54 MB in the same measurement) — smaller and actually reflects what
# `--prod` promises.
# ─────────────────────────────────────────────────────────────────────────
FROM base AS prod-deps
WORKDIR /repo
COPY --from=pruner /repo/out/json/ .
COPY --from=pruner /repo/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN --mount=type=cache,id=loombre-pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod

# ─────────────────────────────────────────────────────────────────────────
# Stage: ffmpeg-fetch — vendors the pinned static ffmpeg/ffprobe pair for
# the image's OWN target architecture from installers/ffmpeg-manifest.json
# via the shared scripts/fetch-ffmpeg.mjs (lane I1 deliverable — landed
# during this lane's work, so the distro-ffmpeg fallback this lane's brief
# names was not needed; see installers/docker/BUILD-NOTES.md). Checksum-
# verified against the manifest before extraction; GPL-3.0-or-later,
# statically linked libx264/libx265 — see the manifest's `provenance` block
# for the AGPL "mere aggregation" rationale (spawned as a child process,
# never linked into Loombre's own code, exactly how this image runs it).
#
# `xz-utils` is required here only to extract the fetched .tar.xz — GNU
# tar's `-J` on Debian shells out to a standalone `xz` binary rather than
# linking liblzma directly, and bookworm-slim does not install it by
# default (verified: `tar -xJf` fails with "xz: not found" otherwise).
# ─────────────────────────────────────────────────────────────────────────
FROM base AS ffmpeg-fetch
WORKDIR /repo
RUN apt-get update && apt-get install -y --no-install-recommends xz-utils unzip \
    && rm -rf /var/lib/apt/lists/*
COPY scripts/fetch-ffmpeg.mjs ./scripts/fetch-ffmpeg.mjs
COPY installers/ffmpeg-manifest.json ./installers/ffmpeg-manifest.json
ARG TARGETARCH
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) ffmpeg_platform=linux-x64 ;; \
      arm64) ffmpeg_platform=linux-arm64 ;; \
      *) echo "ffmpeg-fetch: unsupported TARGETARCH '$TARGETARCH' (need amd64 or arm64)" >&2; exit 1 ;; \
    esac; \
    node scripts/fetch-ffmpeg.mjs --platform "$ffmpeg_platform" --vendor-dir /vendor

# ─────────────────────────────────────────────────────────────────────────
# Stage: web-pruner — a SECOND `turbo prune`, scoped to @loombre/web only
# (installer completeness audit). Deliberately NOT merged into the shared
# `pruner` scope above: adding @loombre/web there would drag apps/web and
# its whole Next toolchain into the server path's out/json + out/full,
# bloating `builder`/`prod-deps`'s inputs and invalidating their layer
# cache on every web-only source change (and vice versa). Two prune stages
# keep the two images' dependency closures fully independent while still
# sharing the `base` layer and the one pnpm store cache mount.
#
# Same turbo pin as `pruner` above — bump the two together, always.
# `pruner`'s tsconfig.base.json gotcha applies identically here
# (apps/web/tsconfig.json `extends` ../../tsconfig.base.json, and `next
# build`'s type-check step needs it) — fixed the same way, by copying it
# from THIS stage's own full checkout in web-builder below.
# ─────────────────────────────────────────────────────────────────────────
FROM base AS web-pruner
WORKDIR /repo
COPY . .
RUN pnpm dlx turbo@2.10.7 prune @loombre/web --docker

# ─────────────────────────────────────────────────────────────────────────
# Stage: web-builder — full install against the web-pruned lockfile, then
# `next build` via turbo (whose ^build graph compiles @loombre/sdk and
# @loombre/shared first — both plain `tsc` over committed sources; the
# sdk's generated client is checked in, so NO contract codegen runs at
# image-build time).
#
# There is deliberately NO build-time API origin: the web client selects
# its server URL in the BROWSER (the login screen takes a server URL —
# docs/PLAN.md's v1 deployment shape), and LOOMBRE_SERVER_ORIGIN — the
# optional CSP-tightening pairing — is read PER-REQUEST at runtime by
# src/proxy.ts, never baked into the bundle. So this stage takes zero
# LOOMBRE_* build args and one build serves every deployment.
# NEXT_TELEMETRY_DISABLED is inherited from `base` (D14 — see its header).
# ─────────────────────────────────────────────────────────────────────────
FROM base AS web-builder
WORKDIR /repo
COPY --from=web-pruner /repo/out/json/ .
COPY --from=web-pruner /repo/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN --mount=type=cache,id=loombre-pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY --from=web-pruner /repo/out/full/ .
COPY --from=web-pruner /repo/tsconfig.base.json ./tsconfig.base.json
RUN pnpm exec turbo run build --filter=@loombre/web
# `output: "standalone"` (apps/web/next.config.mjs) makes that build emit
# .next/standalone/ — a self-contained server.js plus a PRUNED, real-dir
# node_modules — which is all the `web` stage below ships. The full
# devDependency install above never reaches the final image.

# ─────────────────────────────────────────────────────────────────────────
# Stage: web — the shipped WEB image (`--target web`; docker-bake.hcl's
# `loombre-web` target; docker-compose.prod.yml's `web` service). Mirrors
# the `runtime` stage's posture — tini as PID 1, non-root loombre at
# uid/gid 1000, curl-driven HEALTHCHECK — minus everything server-specific:
# no ffmpeg, no db scripts, no /data volume. A Next standalone server is
# stateless; every API call happens from the BROWSER straight to the
# server's own origin, never through this container.
# ─────────────────────────────────────────────────────────────────────────
FROM node:24.18.0-bookworm-slim AS web

LABEL org.opencontainers.image.title="Loombre Web" \
      org.opencontainers.image.description="Loombre web client (Next.js standalone server)" \
      org.opencontainers.image.source="https://github.com/Loombre/Loombre" \
      org.opencontainers.image.licenses="NOASSERTION" \
      org.opencontainers.image.vendor="Loombre"
# licenses=NOASSERTION for the same reason as the `runtime` stage below —
# see its comment (LICENSE-INTENT.md: AGPL-3.0 is declared intent, not the
# license in force yet). ARG declarations are per-stage in Dockerfiles, so
# the version/revision/created trio is redeclared here; the values arrive
# from the same installers/docker/build.sh invocation either way.
ARG LOOMBRE_VERSION=0.0.0
ARG VCS_REF=unknown
ARG BUILD_DATE=unknown
LABEL org.opencontainers.image.version="${LOOMBRE_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.created="${BUILD_DATE}"

# Same rename-in-place of the base image's uid/gid-1000 "node" user as the
# `runtime` stage below — see its comment for why rename beats a second
# uid-1000 identity.
RUN usermod -l loombre -d /home/loombre -m node \
    && groupmod -n loombre node

# `curl` for the HEALTHCHECK below; `tini` as PID 1 (same reasoning as
# `runtime` — though the zombie-reaping half barely applies here, the
# standalone server spawns no child processes; direct SIGTERM delivery is
# the part that keeps `docker stop` from waiting out the kill timeout).
# NO ca-certificates, deliberately: the web process makes no outbound TLS
# calls of its own — all API traffic is browser-side (see web-builder's
# header) and the standalone server only renders routes and serves local
# assets. NO ffmpeg, obviously.
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Standalone monorepo layout (verified against a real `next build` of this
# workspace, not assumed from docs): <standalone>/apps/web/server.js is
# the entrypoint and <standalone>/node_modules the pruned dependency tree,
# so copying the standalone root onto /app puts the server at
# /app/apps/web/server.js.
COPY --from=web-builder --chown=loombre:loombre /repo/apps/web/.next/standalone ./
# Next's documented standalone contract: .next/static and public/ are NOT
# promised inside standalone output and must be placed at
# <app dir>/.next/static and <app dir>/public by the deployer. Copied
# explicitly from the real build output — a no-op layer if a given Next
# version happens to have included them, and correct when it doesn't;
# never rely on the undocumented behavior.
COPY --from=web-builder --chown=loombre:loombre /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=web-builder --chown=loombre:loombre /repo/apps/web/public ./apps/web/public

# HOSTNAME=0.0.0.0: the standalone server.js binds process.env.HOSTNAME
# and defaults to localhost — unreachable through container networking
# without this. NEXT_TELEMETRY_DISABLED: D14 no-phone-home, same as the
# build stages (Next phones home from the running server too, not only
# `next build`). LOOMBRE_SERVER_ORIGIN (optional per-request CSP
# tightening, src/proxy.ts) deliberately has NO default here — it is a
# per-deployment value; docker-compose.prod.yml wires it with a
# commented rationale.
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1

EXPOSE 3000

USER loombre:loombre

# /manifest.webmanifest is Next's file-based metadata route
# (apps/web/src/app/manifest.ts) — statically generated at build time,
# always-200, zero data/API dependency — a far cheaper every-30s liveness
# probe than rendering /login. The /login page itself is asserted
# end-to-end (once, through the published port) by
# installers/docker/smoke.mjs instead. start-period is shorter than
# runtime's 20s: no DB, nothing to warm — the standalone server binds in
# about a second.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl --fail --silent --show-error "http://127.0.0.1:${PORT}/manifest.webmanifest" || exit 1

# Same tini-as-PID-1 rationale as `runtime` below (correct under plain
# `docker run`, not only compose — see that stage's comment and
# installers/docker/BUILD-NOTES.md).
ENTRYPOINT ["tini", "--"]
CMD ["node", "apps/web/server.js"]

# ─────────────────────────────────────────────────────────────────────────
# Stage: runtime — the shipped SERVER/WORKER image. Assembled from three
# independent stages above rather than one mutated tree, specifically so no
# stage's devDependency install ever touches this stage's filesystem
# history. Kept as the LAST stage in this file so an untargeted
# `docker build .` still builds this image, not the `web` stage above
# (BuildKit's default target is the final stage) — though every real
# consumer (compose, bake) now names its target explicitly anyway.
# ─────────────────────────────────────────────────────────────────────────
FROM node:24.18.0-bookworm-slim AS runtime

LABEL org.opencontainers.image.title="Loombre" \
      org.opencontainers.image.description="Loombre media server (server + worker roles, selected by command)" \
      org.opencontainers.image.source="https://github.com/Loombre/Loombre" \
      org.opencontainers.image.licenses="NOASSERTION" \
      org.opencontainers.image.vendor="Loombre"
# licenses=NOASSERTION, not AGPL-3.0: per LICENSE-INTENT.md this repo is
# private/proprietary today ("all rights reserved") with AGPL-3.0 a
# declared future intent at public launch, not the license in force yet —
# asserting AGPL-3.0 now would be simply false. ARGs below (version/
# revision/created) are build-time-supplied by installers/docker/build.sh
# so this Dockerfile itself never hardcodes a value that would go stale.
ARG LOOMBRE_VERSION=0.0.0
ARG VCS_REF=unknown
ARG BUILD_DATE=unknown
LABEL org.opencontainers.image.version="${LOOMBRE_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.created="${BUILD_DATE}"

# Non-root user at uid/gid 1000 named "loombre" per this lane's brief.
# node:*-bookworm-slim already ships a "node" user at uid/gid 1000 (Debian
# base images don't leave 1000 free) — renamed in place rather than
# creating a second uid-1000 identity, which Linux permits but which would
# make `id`/ownership output confusing for anyone inspecting the image.
RUN usermod -l loombre -d /home/loombre -m node \
    && groupmod -n loombre node

# ffmpeg/ffprobe need their runtime shared-library deps (the BtbN GPL build
# statically links libx264/libx265 but still dynamically links against
# system libs — glibc, zlib, etc. — all already present in bookworm-slim's
# base layer since it's the same Debian family the build was made for; no
# extra apt packages needed here for ffmpeg itself). `curl` is for the
# HEALTHCHECK below (server's GET /healthz); `tini` is PID 1 so SIGTERM
# reaches node directly instead of being swallowed by a shell, and reaps
# any zombie ffmpeg children the worker's transcode runtime leaves behind
# (docs/PLAYBACK.md §9 spawns real ffmpeg child processes per session).
# `ca-certificates` is for the worker's outbound HTTPS calls (TMDB/TVDB/
# MusicBrainz providers, the future release-manifest update check).
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 1) prod-only node_modules (every level: root + each workspace member's
#    local node_modules) + the tsx/ajv/esbuild runtime shims restored into
#    it, + skeleton package.json files (from turbo prune's out/json).
COPY --from=prod-deps --chown=loombre:loombre /repo/. .
# 2) compiled output for the packages that ship dist/ and are actually
#    loaded from it (server, worker, and jobs's sibling packages that DO
#    wire their `exports` at dist — playback-engine, shared, provisioning,
#    provisioning-pg; NOT jobs itself, see the builder stage's comment
#    above for why). provisioning/provisioning-pg are FROZEN contracts
#    this lane never edits (see this file's own top-level header) but
#    still must package correctly now that apps/server actually imports
#    them (apps/server/src/bootstrap/provisioning.ts) — the embedded-PG
#    code paths inside provisioning-pg stay dormant whenever DATABASE_URL
#    is set (this image's only supported mode — see this file's own header
#    "Embedded PG is NOT in the image"), but the module still needs to
#    RESOLVE at import time regardless of which path executes.
COPY --from=builder --chown=loombre:loombre /repo/apps/server/dist ./apps/server/dist
COPY --from=builder --chown=loombre:loombre /repo/apps/worker/dist ./apps/worker/dist
COPY --from=builder --chown=loombre:loombre /repo/packages/playback-engine/dist ./packages/playback-engine/dist
COPY --from=builder --chown=loombre:loombre /repo/packages/shared/dist ./packages/shared/dist
COPY --from=builder --chown=loombre:loombre /repo/packages/provisioning/dist ./packages/provisioning/dist
COPY --from=builder --chown=loombre:loombre /repo/packages/provisioning-pg/dist ./packages/provisioning-pg/dist
# @loombre/release-manifest (P4.16 update checks) + @loombre/secrets (P4.7
# keychain/JWT-secret persistence, imported by main.ts's boot) +
# @loombre/controller-ipc (the loopback IPC listener, apps/server/src/ipc).
# secrets + controller-ipc were ADDED in Wave 2 AFTER this COPY list was
# first written — their absence crash-looped both containers on boot
# (Wave-3 Linux install-smoke finding D2, fixed here). All are real
# workspace deps now, resolving via bare specifier to THIS dist/.
COPY --from=builder --chown=loombre:loombre /repo/packages/release-manifest/dist ./packages/release-manifest/dist
COPY --from=builder --chown=loombre:loombre /repo/packages/secrets/dist ./packages/secrets/dist
COPY --from=builder --chown=loombre:loombre /repo/packages/controller-ipc/dist ./packages/controller-ipc/dist
# @loombre/plugin-host + @loombre/plugin-protocol (LPP v1): imported at
# runtime by apps/server's PluginsModule and apps/worker's metadata
# adapter/delivery loop. SAME drift pattern as secrets/controller-ipc
# above — LPP landed after this COPY list, and the first post-LPP image
# smoke (supported-latest sweep 2026-07-25) crash-looped the server on
# ERR_MODULE_NOT_FOUND plugin-host/dist. (@loombre/contract needs no
# entry: it ships schema files, not a dist — present via the full-tree
# COPY in 1.)
COPY --from=builder --chown=loombre:loombre /repo/packages/plugin-host/dist ./packages/plugin-host/dist
COPY --from=builder --chown=loombre:loombre /repo/packages/plugin-protocol/dist ./packages/plugin-protocol/dist
# 3) @loombre/db + @loombre/jobs: as of Phase 4 Wave 3 (lane STRUCT) both ship
#    REAL dist builds (exports point at dist/, no runtime loader) — copied
#    from the builder like every sibling above, NOT raw src. db additionally
#    needs its migrate/seed CLI scripts + migrations + schema.sql at runtime
#    (the operator migration/upgrade path runs these via `docker compose run`,
#    not a compiled entrypoint) — those are data files, kept from the pruner.
COPY --from=builder --chown=loombre:loombre /repo/packages/db/dist ./packages/db/dist
COPY --from=builder --chown=loombre:loombre /repo/packages/jobs/dist ./packages/jobs/dist
COPY --from=pruner --chown=loombre:loombre /repo/out/full/packages/db/scripts ./packages/db/scripts
COPY --from=pruner --chown=loombre:loombre /repo/out/full/packages/db/seed ./packages/db/seed
COPY --from=pruner --chown=loombre:loombre /repo/out/full/packages/db/migrations ./packages/db/migrations
COPY --from=pruner --chown=loombre:loombre /repo/out/full/packages/db/schema.sql ./packages/db/schema.sql
# 4) vendored ffmpeg/ffprobe (see ffmpeg-fetch stage) + their bundled
#    license text, kept alongside for anyone auditing the image.
COPY --from=ffmpeg-fetch --chown=loombre:loombre /vendor/*/ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg-fetch --chown=loombre:loombre /vendor/*/ffprobe /usr/local/bin/ffprobe
COPY --from=ffmpeg-fetch --chown=loombre:loombre /vendor/*/LICENSE.txt /usr/local/share/doc/loombre-ffmpeg/LICENSE.txt

ENV NODE_ENV=production \
    LOOMBRE_FFMPEG=/usr/local/bin/ffmpeg \
    LOOMBRE_FFPROBE=/usr/local/bin/ffprobe \
    LOOMBRE_DATA_DIR=/data \
    LOOMBRE_CONFIG_DIR=/data/config \
    LOOMBRE_TRANSCODE_DIR=/data/transcode \
    LOOMBRE_AUTH_LOG_FILE=/data/logs/auth-anomaly.log \
    PORT=3001 \
    LOOMBRE_SUPERVISOR=container
# LOOMBRE_SUPERVISOR=container: tells the server its supervisor restarts it
# on ANY exit (compose ships restart:unless-stopped, which ignores exit
# codes), so POST /system/shutdown refuses honestly (409 — an in-process
# exit cannot keep the container down; `docker compose stop` is the real
# shutdown) while POST /system/restart works unchanged. See
# apps/server/src/common/server-power.service.ts.

# App-data volume mount point (images, transcode staging — see
# docker-compose.prod.yml's `loombre_data` named volume). Created + owned
# ahead of time so the non-root user can write to it regardless of what
# gets bind-mounted/volume-mounted over it at `docker run`/compose time.
#
# LOOMBRE_AUTH_LOG_FILE and LOOMBRE_CONFIG_DIR are set above for the same
# reason (`/data/logs`, `/data/config` — created here too): a real,
# discovered boot failure, not a defensive guess — apps/server/src/session/
# anomaly-log.service.ts defaults to `<process.cwd()>/logs/auth-anomaly.log`
# when LOOMBRE_AUTH_LOG_FILE is unset, and `mkdirSync`s that directory at
# construction time, in the SessionModule's constructor chain, unconditionally
# (not lazily on first log write). `/app` (this image's WORKDIR / cwd) is
# intentionally NOT owned by the non-root `loombre` user — the application
# code directory stays effectively read-only to its own runtime process,
# which is the point of running non-root at all — so leaving this env unset
# makes every container crash on boot with `EACCES: permission denied,
# mkdir '/app/logs'` before Nest even finishes wiring providers. Confirmed
# by reproducing the crash, then fixing it exactly this way; see
# installers/docker/BUILD-NOTES.md.
RUN mkdir -p /data/transcode /data/logs /data/config && chown -R loombre:loombre /data

USER loombre:loombre

# Liveness only (gateway/health.controller.ts — not a contract route, see
# its own header comment). start-period covers cold start against a
# freshly-migrated but still-cold-cache Postgres; the worker container
# does not get an HTTP healthcheck (it exposes no port — see
# docker-compose.prod.yml's header comment for how its liveness is
# represented instead).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl --fail --silent --show-error "http://127.0.0.1:${PORT}/healthz" || exit 1

# tini as PID 1: forwards SIGTERM to node directly (no shell in between to
# swallow it) and reaps zombie ffmpeg children. Baked into the image via
# ENTRYPOINT (rather than relying on `docker compose`'s own `init: true`,
# which wraps the SAME tini one level higher) so the image behaves
# correctly under plain `docker run` too, not only under this repo's own
# compose file — see installers/docker/BUILD-NOTES.md for the two-option
# comparison this decision was made from.
ENTRYPOINT ["tini", "--"]
CMD ["node", "apps/server/dist/main.js"]
