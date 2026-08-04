# Installing Loombre with Docker (recommended)

Docker is the friction-free path because it sidesteps the entire "unsigned
installer" trust conversation the native installers require (see
[windows.md](windows.md) for that story) — a Docker image's integrity is
provable by its content digest and, once an image is published under a
release tag, a cosign signature over that digest (see "Verifying the
image" below — the signing pipeline itself is already wired into
`.github/workflows/release.yml`; no tagged release has been published
yet). No SmartScreen, no Gatekeeper quarantine, no code-signing
certificate to not-buy.

## Prerequisites

- Docker Engine 24+ with the Compose plugin (`docker compose version` should
  print a v2.x line — this doc uses Compose v2 syntax throughout, not the
  standalone `docker-compose` v1 binary).
- A host with **at least 1 GB RAM free** beyond what Postgres + Loombre need
  under load (docs/PLAN.md §9.2's Tier-0 budget: ≤500 MB idle for
  server+worker+embedded-PG combined; add Postgres's own baseline here since
  this is a separate `postgres:18` container, not the embedded-PG path).
- Nothing else needs installing on the host — Node, ffmpeg, and every native
  dependency (sharp, argon2id hashing, etc.) ship inside the image.

## Quickstart

```bash
git clone https://github.com/Loombre/Loombre.git   # or your own release checkout
cd loombre

cp installers/docker/loombre.env.example installers/docker/loombre.env
$EDITOR installers/docker/loombre.env   # set POSTGRES_PASSWORD and LOOMBRE_JWT_SECRET at minimum

# 1) bring up Postgres and wait for it to report healthy
docker compose -f docker-compose.prod.yml --env-file installers/docker/loombre.env up -d postgres

# 2) apply the schema (also the upgrade command — see "Migrating / upgrading" below)
docker compose -f docker-compose.prod.yml --env-file installers/docker/loombre.env run --rm server \
  node packages/db/scripts/migrate.mjs migrate

# 3) bring up the server + worker + web UI
docker compose -f docker-compose.prod.yml --env-file installers/docker/loombre.env up -d
```

Only two files are actually needed to run Loombre this way —
`docker-compose.prod.yml` and `installers/docker/loombre.env.example` — a
full `git clone` is simply the easiest way to get both today. It also
happens to be required right now regardless, since no published image
exists yet (see "Pulling a published image" below): building `server`/
`worker` from source needs the whole repository as build context, not just
those two files.

The **web UI** is now at `http://<this host>:3000` (the `web` container;
`LOOMBRE_WEB_PORT` changes it) and the **HTTP API** at
`http://<this host>:3001` (`LOOMBRE_PORT`). The first-run setup wizard
(welcome → admin creation → library paths → hardware probe → restricted
content → restore-from-backup → done) lives in the web UI and runs the
first time you open it — see `docs/admin-guide/wizard.md` for the full
walkthrough; there is no default admin account and no manual `docker exec`
step required to create one. When the login screen asks for a server URL,
give it the API origin **as your browser reaches it** —
`http://<this host>:3001` — never a container-internal name like
`http://server:3001` (the browser, not the web container, makes every API
call).

Browsing from a *different* machine (LAN or beyond)? The localhost
defaults only cover a browser running on the Docker host itself — set two
variables in `loombre.env` to the origins browsers actually use, e.g.:

```bash
LOOMBRE_CORS_ORIGINS=http://192.168.1.20:3000    # the web UI origin (server-side CORS allowlist)
LOOMBRE_SERVER_ORIGIN=http://192.168.1.20:3001   # the API origin (web client's CSP allowance)
```

Both are documented in full — including the unset/empty/set distinction
each one carries — in `installers/docker/loombre.env.example`.

**Pulling a published image** (once a tagged release publishes images —
none has been published yet as of this writing):

```bash
export LOOMBRE_IMAGE=ghcr.io/loombre/loombre:v0.9.0
export LOOMBRE_WEB_IMAGE=ghcr.io/loombre/loombre-web:v0.9.0
docker compose -f docker-compose.prod.yml --env-file installers/docker/loombre.env pull
```

Until published images are available, `docker compose ... up -d` builds from
source automatically the first time (the `build:` sections in `docker-compose.prod.yml`),
which is what the Quickstart above does implicitly.

## What gets started

| Service | Image | Role |
|---|---|---|
| `postgres` | `postgres:18.4` | Catalog database (D1: Postgres-only, no embedded-PG path in the Docker distribution — see [External Postgres](#running-against-an-external-postgres) below) |
| `server` | built from the repo-root `Dockerfile` (`runtime` target) | HTTP API (`node apps/server/dist/main.js`) |
| `worker` | **same image as `server`**, different `command:` | Scanner, probe, metadata, image pipeline, transcode runtime (`node apps/worker/dist/index.js`) |
| `web` | built from the **same `Dockerfile`**, separate `web` target (`loombre-web`) | The browser UI — a Next.js standalone server (`node apps/web/server.js`) |

`server` and `worker` are two containers built from **one image** — see the
Dockerfile's own header comment for why (short version: they share their
entire dependency graph; a second image would duplicate every layer except
two small `dist/` directories, for a solo-maintainer project where keeping
both processes in exact version lockstep matters more than that marginal
pull-size saving). `web` is deliberately its **own image**: it shares
essentially none of that runtime graph (no ffmpeg, no db, no pg — a Next
standalone build carries its own pruned `node_modules`), so the one-image
rationale stops there — also covered in the Dockerfile's header.

The `web` container is stateless and makes no API calls of its own — every
API request happens **from your browser** directly to `server`'s published
port. That's why it has no `depends_on`, no volumes, and why the CORS/CSP
pairing above talks about browser-visible origins, never container names.

Only `server`'s and `web`'s HTTP ports are published to the host.
`postgres` and `worker` are reachable only from inside the compose network
— there is nothing to port-forward for either.

## Stopping / shutting down completely

```sh
# Stop every Loombre container (keeps containers + data; `up -d` resumes):
docker compose -f docker-compose.prod.yml --env-file installers/docker/loombre.env stop

# Stop AND remove the containers + network (data volumes survive):
docker compose -f docker-compose.prod.yml --env-file installers/docker/loombre.env down
```

Both leave your data intact — the catalog database and `/data` live on
named volumes. **`down -v` additionally deletes those volumes** (catalog,
covers, persisted secrets) — irreversible; don't add `-v` unless you mean
to erase the instance.

Stopped containers do **not** restart at the next host boot after a
`stop`/`down` — compose's restart policy only revives containers that
were running when the daemon stopped. `up -d` brings everything back.
(This is the same full shutdown the macOS menubar's "Shut Down Loombre…"
and the Windows tray's "Shut down Loombre…" perform — with Docker,
compose is the interface.)

## Environment variables

Every variable `docker-compose.prod.yml` reads is documented, with its
default and which service consumes it, in
[`installers/docker/loombre.env.example`](https://github.com/Loombre/Loombre/blob/main/installers/docker/loombre.env.example) —
copy it to `loombre.env` (gitignored) rather than editing the example in
place. The two you cannot skip:

- `POSTGRES_PASSWORD` — no default; compose refuses to start without it.
- `LOOMBRE_JWT_SECRET` — required by the compose file's own validation.
  Signs access JWTs; only the **server** reads it (the worker never does).
  The server *can* technically manage this itself — since P4.7/P4.17 an
  unset secret is generated once and **persisted** (here: under
  `/data/secrets` on the `loombre_data` volume), so restarts keep every
  outstanding token; the old "new ephemeral secret every restart" behavior
  is gone. The compose file still requires an explicit value because a
  secret in `loombre.env` survives `docker compose down -v` (which wipes
  `/data`, and a volume-persisted secret with it — logging every session
  out) and gets backed up with the rest of your configuration. Generate
  one with `openssl rand -base64 48`.

Everything else (CORS origins, trust-proxy, performance tier, transcode
concurrency, TMDB/TVDB provider keys, …) has a sane default and is
documented inline in the example file.

## Migrating / upgrading

The **same command** is both the first-run migration step and the upgrade
step for every future release — there is no separate "upgrade" tooling to
learn:

```bash
docker compose -f docker-compose.prod.yml --env-file installers/docker/loombre.env run --rm server \
  node packages/db/scripts/migrate.mjs migrate
```

This runs `packages/db`'s migration runner **inside the compose network**,
as a one-shot container built from the same image `server`/`worker` run
from — so it always uses exactly the migrations that ship with whatever
version of the image you're upgrading to, applies every migration not yet
recorded as applied (`schema_migrations` table), and exits. Run it:

1. Once, before the very first `up -d` (the Quickstart above).
2. Again, every time you pull/build a newer image, **before** restarting
   `server`/`worker` on that newer image — e.g.:

   ```bash
   docker compose -f docker-compose.prod.yml --env-file installers/docker/loombre.env build
   docker compose -f docker-compose.prod.yml --env-file installers/docker/loombre.env run --rm server \
     node packages/db/scripts/migrate.mjs migrate
   docker compose -f docker-compose.prod.yml --env-file installers/docker/loombre.env up -d
   ```

Migrations are additive-only in normal operation (docs/PLAN.md §4.2) — this
is not a destructive step. `docker compose ... run --rm server node
packages/db/scripts/migrate.mjs status` prints which migrations are applied
without changing anything, if you want to check first.

Loombre's own admin UI separately notifies you when a newer **signed release
manifest** is available (STATE.md P4.3) — it never downloads or applies
anything automatically; pulling/building a new image and running the
migration above is still a step you take.

## Running against an external Postgres

The `postgres` service in `docker-compose.prod.yml` is not required — it
exists for convenience. To point Loombre at a Postgres instance you already
run and manage:

1. Remove (or don't start) the `postgres` service.
2. Set `DATABASE_URL` directly in your env file to your own instance's
   connection string, overriding the `postgres://...@postgres:5432/...`
   value the compose file otherwise assembles from `POSTGRES_*`.
3. Run the same [migration command](#migrating-upgrading) against it once.

This is the `ProvisioningStatus: 'external'` path (`packages/provisioning`)
— the server behaves identically either way; it never probes or manages a
Postgres instance it didn't provision itself.

## Media library paths

`docker-compose.prod.yml` documents bind-mount examples (commented out) on
both `server` and `worker` — **both containers need the same host media
paths mounted at the same container-side paths**, since the scanner records
paths as given and both processes resolve them the same way:

```yaml
    volumes:
      - loombre_data:/data
      - /path/to/your/movies:/media/movies:ro
      - /path/to/your/tv:/media/tv:ro
      - /path/to/your/music:/media/music:ro
```

Read-only (`:ro`) is the recommended posture — Loombre never writes into
your media directories (D8: NFO/sidecar files are scanner *inputs* only,
never written). Add your real library paths via the first-run wizard (or
`POST /libraries` directly) after the containers are up, pointing at the
container-side path (`/media/movies`, above), not the host path.

**Media on a NAS (SMB/NFS)?** Filesystem-change events don't cross network
mounts into a container, so a native watch silently sees nothing and new
files only appear on manual rescans. Set `LOOMBRE_SCAN_POLL=1` in
`loombre.env` to force the scanner's polling mode for every watched path —
the documented escape hatch (see `installers/docker/loombre.env.example`).

## Hardware-accelerated ffmpeg (override)

The image ships a pinned, checksum-verified **software** ffmpeg/ffprobe
pair (`installers/ffmpeg-manifest.json`) — nothing to configure for a
working instance. If you need hardware acceleration the vendored build
lacks (VAAPI, NVENC, QSV), bring your own binaries:

1. Bind-mount your hw-accel-capable `ffmpeg`/`ffprobe` into **both** the
   `server` and `worker` containers at the same container-side path (the
   worker is what actually spawns them; both processes must resolve the
   same pair) — plus whatever device/driver mounts the acceleration needs
   (`/dev/dri` for VAAPI, the NVIDIA runtime for NVENC, etc.).
2. Point `LOOMBRE_FFMPEG` and `LOOMBRE_FFPROBE` in `loombre.env` at that
   container-side path. Both are passed through to both containers, with
   the image's vendored pair as the default when unset.

Historical note: `loombre.env.example` documented this override before it
actually worked — compose `--env-file` values are interpolation-only and
were never passed into the containers, so setting these did nothing. The
pass-through in `docker-compose.prod.yml` (with the vendored path as the
`:-` default) is what made it real; if you tried this before and saw no
effect, that was why, and it works now.

## Reverse proxy + TLS (the real deployment)

`docker-compose.prod.yml` deliberately publishes only `server`'s and
`web`'s own HTTP ports — putting either directly on the internet unproxied
is not the recommended posture for anything beyond local/LAN use. The documented v1 remote-access
path is plain HTTP behind a reverse proxy you already run and trust (nginx,
Caddy, Traefik) that terminates TLS, with `LOOMBRE_TRUST_PROXY` set so the
auth rate limiter and anomaly log see real client IPs (README.md's "Remote
access" section has a working nginx snippet and explains exactly what
`LOOMBRE_TRUST_PROXY` does and why it's off by default).

A full reverse-proxy + ACME/TLS operations guide lives in **docs/ops**
— see `docs/ops/reverse-proxy.md` and `docs/ops/acme.md` — pointer left
here rather than duplicating that content.

## Verifying the image

### Locally built images

```bash
docker inspect --format='{{index .RepoDigests 0}}' loombre:latest
```

This prints the image's content digest — the same `sha256:...` value across
any host pulling the same built image. If you built it locally, this proves
bit-for-bit reproducibility.

### Published images (once released)

Loombre Docker images are cosign-signed using GitHub's OIDC identity:

```bash
# Install cosign first: https://docs.sigstore.dev/cosign/installation/

cosign verify \
  --certificate-identity-regexp "^https://github.com/Loombre/Loombre/" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/loombre/loombre:v0.9.0
```

This proves the image was built by Loombre's own CI from the exact commit
tagged in the repository — no key file needed (cosign uses GitHub's OIDC
token as the trust root). The web-client image
(`ghcr.io/loombre/loombre-web:<version>`) verifies the same way — swap the
image reference.

## Building multi-arch images yourself

```bash
installers/docker/build.sh                # BOTH images (loombre + loombre-web), linux/amd64 + linux/arm64
installers/docker/build.sh --load          # single-platform (host arch), loads into `docker images`
installers/docker/build.sh loombre-amd64    # one target, one arch (also: loombre-web-amd64, etc.)
```

The default bake group builds both shipped images — `loombre`
(server/worker) and `loombre-web` (the web client) — from the one repo-root
`Dockerfile`'s two final stages. See `installers/docker/docker-bake.hcl`
for the full target definitions.
Both architectures were built and booted end-to-end — see
`installers/docker/BUILD-NOTES.md` for image sizes,
version pins, and native-dependency findings from that run.

## Data locations

| What | Where |
|---|---|
| Postgres data | named volume `loombre_pgdata` |
| Application data (image variants, transcode staging) | named volume `loombre_data`, mounted at `/data` in the `server` and `worker` containers (`web` is stateless — no volumes) |
| Your media | wherever you bind-mount it (see [Media library paths](#media-library-paths)) — never copied, never modified |

`docker compose -f docker-compose.prod.yml down` (without `-v`) stops
everything and **leaves both named volumes intact** — your catalog and
media stay put across restarts/upgrades. `down -v` additionally destroys
`loombre_pgdata`/`loombre_data` — only use it when you actually mean to wipe
the instance (this is exactly what `installers/docker/smoke.mjs` does at
the end of every run, on its own dedicated `loombre_i2` project, never on an
instance you're actually using).

## Crash reports

Loombre never sends crash data anywhere automatically (no telemetry, ever).
Both `server` and `worker` write local crash files under `/data/crashes`
inside the container — i.e. `loombre_data:/data/crashes` on the host side of
the named volume (see "Data locations" above) — viewable from the admin
System panel (`docs/admin-guide/capability-report.md`'s "Crash files"
section) or directly from the volume. `docker compose logs server` /
`docker compose logs worker` capture normal stdout/stderr regardless, and
are the first thing to check today.

## Troubleshooting

- **`POSTGRES_PASSWORD must be set` / `LOOMBRE_JWT_SECRET must be set`
  errors from `docker compose`.** You're missing `--env-file
  installers/docker/loombre.env` on the command, or haven't copied
  `loombre.env.example` to `loombre.env` and filled it in yet.
- **`server` never reports healthy.** `docker compose -f
  docker-compose.prod.yml logs server` — a common cause before the first
  migration run is simply that the schema doesn't exist yet; run
  [the migration command](#migrating-upgrading). The healthcheck itself
  only probes `GET /healthz` (a liveness check, not a DB check — see
  `apps/server/src/gateway/health.controller.ts`), so a server reporting
  healthy with an unmigrated database is expected, not a bug; catalog
  requests are what will fail until you migrate.
- **`worker` container exits immediately.** `docker compose -f
  docker-compose.prod.yml logs worker` — almost always `DATABASE_URL`
  unreachable (Postgres not healthy yet, or an external-Postgres
  `DATABASE_URL` that's wrong). Worker's own boot log names the specific
  connection failure.
- **Scanned library shows zero files despite a correct bind mount.** Confirm
  the bind-mount path matches what you gave the library in Loombre exactly
  (container-side path, e.g. `/media/movies` — see [Media library
  paths](#media-library-paths)), and that both `server` and `worker` mount
  it identically.
- **Library scans fine once but never notices new files (NAS media).**
  Network mounts don't deliver filesystem events into the container — set
  `LOOMBRE_SCAN_POLL=1` (see [Media library paths](#media-library-paths)).
- **Login page loads, but logging in / every API call fails.** Two
  browser-side pairings to check, both about the origins **your browser**
  uses (never container names): the server URL you entered must be the API
  origin as the browser reaches it (`http://<host>:3001`); and for any
  browser not running on the Docker host itself, `LOOMBRE_CORS_ORIGINS`
  (server-side allowlist) and `LOOMBRE_SERVER_ORIGIN` (web client's CSP)
  must both name the real origins — CSP violations in the browser console
  point at the latter, CORS errors at the former. See the
  [Quickstart](#quickstart)'s LAN note and
  `installers/docker/loombre.env.example`.

