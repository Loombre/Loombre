# Loombre

**Your movies, shows, and music — on your own hardware, under your own rules.**

[![CI](https://github.com/Loombre/Loombre/actions/workflows/ci.yml/badge.svg)](https://github.com/Loombre/Loombre/actions/workflows/ci.yml)
[![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-blue)](LICENSE)
[![Node 24](https://img.shields.io/badge/node-24-brightgreen)](.nvmrc)

## What it is

Loombre is a ground-up, self-hosted media streaming platform: a server, a web
client, and (later) native apps, all built contract-first on PostgreSQL. It
organizes and streams your library — locally and remotely — to any device. It
is not a fork, client, or compatible implementation of any other media server;
it shares no API surface, schema, or naming with one.

> **Status:** version `0.9.0-rc.7`, pre-release. No published release has shipped yet.

## Screenshots

| Home screen | Now playing |
|---|---|
| ![Home screen](docs/public/screenshots/home.png) | ![Now playing](docs/public/screenshots/player.png) |
| **Browsing a music library** | **Movie detail page** |
| ![Browsing a music library](docs/public/screenshots/browse-music.png) | ![Movie detail page](docs/public/screenshots/movie-detail.png) |
| **HDR content, tone-mapped for a non-HDR display** | |
| ![HDR tone-mapping](docs/public/screenshots/hdr-tonemap.jpeg) | |

## Why Loombre

A few design choices, made from the start rather than bolted on later:

- **PostgreSQL from day one** — real columns, foreign keys, and enums;
  concurrent writes and horizontal scale aren't an eventual migration project.
- **Content filtering enforced at the data layer, not the UI.** Restricted
  libraries are invisible in search, browsing, and "recently added" until every
  gate (server capability, adult age verification, opt-in PIN, explicit
  per-library grant, live session unlock) passes — server-side, by
  construction, not by a client politely agreeing to hide something.
- **Budget hardware is a first-class target.** A ~$100 mini PC (Tier-0: 4-core,
  4 GB RAM) is a real
  [performance budget enforced in CI](docs/developer-guide/architecture/performance-budgets.md),
  not a degraded experience.
- **One contract, one generated SDK.** `packages/contract/openapi.yaml` is the
  source of truth; the client SDK is generated from it and tested for drift, so
  the API and what consumes it can never quietly disagree.
- **A pure, offline-testable playback decision engine.** Whether — and why — a
  file needs converting for a given device is a deterministic function with a
  500+ case regression matrix, not logic smeared across request handlers and
  only found wrong in production.
- **No telemetry, analytics, or phone-home of any kind.** Not opt-in, not
  behind a flag — architecturally absent, enforced by a CI grep gate. Crash
  logs stay on your machine.

## Features

| Area | Status |
|---|---|
| **Media types** | Movies, TV, music (v1). Photos, live TV, and native mobile/TV apps are planned — the data model already accounts for them, but they aren't built yet. |
| **Multi-user** | Per-user accounts, per-library permission grants, remote access. |
| **Restricted content** | Native, opt-in, PIN-gated, server-enforced content class — invisible unless every gate passes. |
| **Playback** | Direct play when your device supports the file as-is; automatic, on-the-fly conversion (with a documented, reason-coded decision) when it doesn't. |
| **Scanning** | Incremental, idempotent, rename-aware; watches your library folders continuously. |
| **Metadata** | Provider-based lookup (movies/TV/music), with local NFO/tag data always taking precedence over anything fetched remotely. |
| **Remote access** | Three first-class, documented paths: your own reverse proxy, built-in ACME (Let's Encrypt), or LAN-only — see [Remote access](#remote-access) below. |
| **Data freedom** | Export your entire catalog and progress as an open JSON archive; import it into another instance. No lock-in by design. |
| **Hardware tiers** | Explicit Tier-0/1/2 support, each with performance budgets enforced in CI. |
| **Telemetry** | None. Ever. Architecturally absent, not a setting. |
| **License** | AGPL-3.0-only. |

## Install

| Platform | Package | Guide |
|---|---|---|
| Docker / Compose | Recommended today | [docs/install/docker.md](docs/install/docker.md) |
| Linux | Tarball + systemd units | [docs/install/linux.md](docs/install/linux.md) |
| Windows | `.exe` installer + tray controller | [docs/install/windows.md](docs/install/windows.md) |
| macOS | `.pkg` + menubar controller | [docs/install/macos.md](docs/install/macos.md) |

Installer artifacts are published with tagged releases, and no tagged release
has shipped yet — Docker and running from source are the paths that work today.

### Quick start (Docker)

```bash
git clone https://github.com/Loombre/Loombre.git   # or your own release checkout
cd Loombre

cp installers/docker/loombre.env.example installers/docker/loombre.env
$EDITOR installers/docker/loombre.env   # set POSTGRES_PASSWORD and LOOMBRE_JWT_SECRET at minimum

# 1) bring up Postgres and wait for it to report healthy
docker compose -f docker-compose.prod.yml --env-file installers/docker/loombre.env up -d postgres

# 2) apply the schema (also the upgrade command — see docs/install/docker.md)
docker compose -f docker-compose.prod.yml --env-file installers/docker/loombre.env run --rm server \
  node packages/db/scripts/migrate.mjs migrate

# 3) bring up the server + worker + web UI
docker compose -f docker-compose.prod.yml --env-file installers/docker/loombre.env up -d
```

Loombre's web UI is now reachable at `http://<this host>:3000` (the HTTP
API is on `:3001`). A first-run web setup
wizard (admin account → library paths → hardware probe → optional
restricted-content setup → optional restore-from-backup) runs the first time
you open it — see [docs/admin-guide/wizard.md](docs/admin-guide/wizard.md) for
the full walkthrough.

Everything else — system requirements, the other platforms, troubleshooting —
starts at [docs/install/index.md](docs/install/index.md).

### Running from source

Needs Node 24, pnpm 11, and Docker (`pnpm dev` starts PostgreSQL on host port
5442 via `docker-compose.dev.yml`). Full walkthrough:
[docs/developer-guide/getting-started.md](docs/developer-guide/getting-started.md).

```bash
pnpm install
pnpm dev
pnpm gate
```

## Documentation

| Guide | Who it's for |
|---|---|
| [Install](docs/install/index.md) | Platform chooser, system requirements, verifying a release. |
| [User Guide](docs/user-guide/index.md) | Anyone watching or listening. Plain language, no jargon. |
| [Admin Guide](docs/admin-guide/index.md) | Whoever runs the server, from the settings screens. |
| [Operator Guide](docs/ops/index.md) | The technical self-hoster: reverse proxies, TLS, backups, external PostgreSQL. |
| [Developer Guide](docs/developer-guide/index.md) | Architecture tour, contract-first workflow, the playback matrix regression law. |
| [API Reference](docs/api-reference/index.md) | Generated from the OpenAPI contract. |

No hosted documentation site is published yet, so these are repo-relative
links; `pnpm docs:build` builds the real site locally into
`docs/.vitepress/dist/`.

**Project internals:** [docs/PLAN.md](docs/PLAN.md) is the authoritative
technical spec and [docs/PLAYBACK.md](docs/PLAYBACK.md) the playback engine
specification (neither is published to the docs site);
[CHANGELOG.md](CHANGELOG.md) has the release history,
[CONTRIBUTING.md](CONTRIBUTING.md) the contribution rules,
[SECURITY.md](SECURITY.md) private disclosure, and
[LICENSE-INTENT.md](LICENSE-INTENT.md) dependency provenance.

## Verifying releases

Loombre ships **unsigned installers** — no Apple notarization, no
Authenticode. That's deliberate, not an oversight: those certificates cost
money, and this project has no revenue and no telemetry to fund them from. In
their place, every release carries three independent layers of trust.

```bash
# built by this project's own CI, from this repo, at this commit — no keys to handle
gh attestation verify <downloaded-file> --repo Loombre/Loombre

# plain integrity: what you downloaded is what was published
sha256sum --ignore-missing -c SHA256SUMS

# the release manager's own signature (key published in keys/minisign.pub, the docs, and the release notes)
minisign -Vm SHA256SUMS -P <public key — see docs/ops/updating.md>
```

Docker images are additionally signed keyless via cosign, using GitHub's OIDC
identity:

```bash
cosign verify \
  --certificate-identity-regexp "^https://github.com/Loombre/Loombre/" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/loombre/loombre:<version>
```

The full trust model is in
[the install guide](docs/install/index.md#why-are-the-installers-unsigned). The
built-in update checker is notify-only — it never downloads, installs, or
applies anything — and its exact network request is specified in
[docs/ops/updating.md](docs/ops/updating.md).

## Remote access

Three first-class, mutually-exclusive ways to reach Loombre from outside
your own network — a decision tree, an honest comparison, and one
self-contained guide per path: [docs/ops/remote-access/](docs/ops/remote-access/index.md).

- **[Loombre Remote](docs/ops/remote-access/loombre-remote.md)** — a private
  network built into Loombre itself, no third party involved.
- **[Tunnel](docs/ops/remote-access/tunnel.md)** — Cloudflare Tunnel, no open
  ports on your router.
- **[Direct](docs/ops/remote-access/direct.md)** — your server, directly on
  the public internet, with its own certificate (built-in ACME or your own
  reverse proxy: [docs/ops/remote-access/acme.md](docs/ops/remote-access/acme.md) /
  [docs/ops/remote-access/reverse-proxy.md](docs/ops/remote-access/reverse-proxy.md)).
- **LAN-only** — no TLS, no port-forward, no extra configuration; see the
  final section of [docs/ops/remote-access/reverse-proxy.md](docs/ops/remote-access/reverse-proxy.md).

Pick one, don't mix two on the same install.

## Privacy & license

Loombre is licensed under **[AGPL-3.0-only](LICENSE)** — see
[LICENSE-INTENT.md](LICENSE-INTENT.md) for dependency provenance and the
relicense history.

**No telemetry, analytics, or phone-home of any kind — architecturally, not by
policy.** Loombre never reports anything about you or your library to anyone.
The only network request the server ever makes unprompted is the built-in,
notify-only update check (fully specified, byte for byte, in
[docs/ops/updating.md](docs/ops/updating.md)); metadata provider lookups
(TMDB/TVDB/MusicBrainz) happen only for libraries you configure, using keys you
supply. Crash logs are written locally and never transmitted. A CI gate
(`grep-gates`, part of `pnpm gate`) scans the entire source tree for known
telemetry SDK import patterns and fails the build if it finds one — this is
enforced, not aspirational.

## Contributing

- **[CONTRIBUTING.md](CONTRIBUTING.md)** — the short version: feedback-loop-first
  (no code before a failing check exists), `pnpm gate:full` must pass, and new
  playback decision rules ship with matrix cases in the same PR.
- **[SECURITY.md](SECURITY.md)** — found a security issue? Report it privately,
  not as a public issue.
- **[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)** — the standards expected of
  everyone taking part.
