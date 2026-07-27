# Installing Loombre on Linux (tarball + systemd)

Loombre ships as a self-contained tarball: a bundled Node runtime, bundled
ffmpeg, and a systemd-ready payload — no system Node, no system ffmpeg, no
Docker required. 

**Docker/Compose is the recommended path** (see `docs/install/docker.md`).
This page covers the tarball alternative: bare-metal installs, containers
without Docker-in-Docker, or anyone who prefers systemd-managed services.

## 1. Download

```sh
# Replace <version>/<arch> — arch is x64 or arm64.
curl -LO https://github.com/Loombre/Loombre/releases/download/v<version>/loombre-<version>-linux-<arch>.tar.gz
curl -LO https://github.com/Loombre/Loombre/releases/download/v<version>/SHA256SUMS
curl -LO https://github.com/Loombre/Loombre/releases/download/v<version>/SHA256SUMS.minisig
```

`SHA256SUMS`/`SHA256SUMS.minisig` are **shared across every artifact in the
release** (this tarball, the Windows `.msi`, the macOS `.pkg`, …) — one
checksum listing, one signature, covering the whole release; there is no
per-artifact `<file>.sha256`/`<file>.minisig`. You don't need to know every
other filename in it — the commands below only touch the line for the file
you actually downloaded.

## 2. Verify what you downloaded

Loombre ships unsigned — no code-signing certificate (see "Why unsigned?" below).
Checksum + signature verification is the primary trust ritual. **Do this every
time**, not just the first install. This is the same three-layer model
`docs/ops/updating.md`'s "Verifying releases" section documents for the
in-app update checker — released files use exactly the same files/commands.

### 1. GitHub artifact attestation (no key handling required)

```sh
gh attestation verify loombre-<version>-linux-<arch>.tar.gz --repo Loombre/Loombre
```

Proves this exact file was built by Loombre's own CI, from this exact
repository, at this exact commit. Needs the `gh` CLI, signed in
(`gh auth login`).

### 2. Checksum (integrity — did the download complete correctly?)

```sh
sha256sum --ignore-missing -c SHA256SUMS
```

`SHA256SUMS` lists every artifact in the release, not just this tarball —
`--ignore-missing` skips the lines for files you didn't download instead of
failing the whole check on them. This verifies your download wasn't
corrupted in transit. It does **not** prove the file came from Loombre —
that's what the minisign signature (next) is for.

### 3. minisign signature (authenticity — did this come from Loombre?)

The signature covers `SHA256SUMS` itself — not each individual artifact —
so verifying it, combined with the checksum match above, transitively
proves this tarball is authentic too:

```sh
# Install minisign if you don't have it already:
# apt install minisign   (Debian/Ubuntu)
# dnf install minisign   (Fedora)
# pacman -S minisign     (Arch)

minisign -Vm SHA256SUMS -P <public key — see below>
```

The minisign public key is published, byte-identical, in multiple
independently-maintained places — this page, `docs/ops/updating.md`'s
"Verifying releases" section, `keys/minisign.pub` in the repository, and
every release's notes — so substituting all of them simultaneously would
be required to defeat verification. `scripts/release/check-pubkey-
consistency.mjs` is the CI-runnable proof they all agree (this page
included, as of the H5 hardening pass); `keys/README.md` documents the
full key-rotation and key-generation story.

<!-- LOOMBRE_MINISIGN_PUBLIC_KEY_BEGIN -->
```
untrusted comment: minisign public key 9EA9BD1D8785E084
RWSE4IWHHb2pnrgvN8eVIFOOv1vK84f5Zkk8lMtw6t4VlggsYAOj2oA5
```
<!-- LOOMBRE_MINISIGN_PUBLIC_KEY_END -->

If verification fails, or the published locations disagree with each
other, **do not install** — that is exactly the scenario minisign
verification exists to catch.

## 3. Extract + install

```sh
tar xzf loombre-<version>-linux-<arch>.tar.gz
cd loombre-<version>-linux-<arch>
sudo ./install.sh
```

Default layout: app at `/opt/loombre`, data at `/var/lib/loombre`, config at
`/etc/loombre/loombre.env`, system user `loombre`. Override with
`--prefix`/`--data-dir`/`--config-dir`/`--user` — see `install.sh --help`.
Full on-disk layout: `installers/linux/LAYOUT.md`.

### No systemd? (containers, WSL1, minimal chroots)

`install.sh`'s last step needs `systemctl` to install + enable the two
units. If your host doesn't run systemd as PID 1 — a Docker/Podman
container, WSL1, a minimal chroot — that step fails with `systemctl not
found but --no-systemd was not passed`. Pass `--no-systemd` instead:
everything else (system user, app payload, data dir, env file) still
happens exactly the same; only the unit-file install is skipped:

```sh
sudo ./install.sh --no-systemd
```

See [Start](#5-start) below for how to run the two processes directly in
this mode — there's no `systemctl start` without systemd.

## 4. Configure

Edit `/etc/loombre/loombre.env` — at minimum, point `DATABASE_URL` at a real
PostgreSQL 17+ instance (external-PG path; embedded PostgreSQL is a
separate, still-landing Phase 4 deliverable — see the file's own
comments) and set `LOOMBRE_JWT_SECRET` (`openssl rand -base64 48`) so
restarts don't log every device out.

Run migrations against that database (until the `loombre` CLI gains a
first-class subcommand for this):

```sh
# from a repo checkout with the same DATABASE_URL, or an equivalent tool
# once one ships in the tarball itself
pnpm db:migrate
```

**Do not run `pnpm db:seed` (or `db:seed-large`) against a real instance.**
Those scripts exist to populate throwaway dev/test/CI databases with fixture
data — including an `admin` account whose password is a fixed, publicly
documented string committed in `packages/db/seed/seed.mjs`. Running either
against your real database would give an internet- or LAN-reachable
instance an admin account with a published password; treat that as a
security mistake, not a shortcut. `pnpm db:migrate` alone leaves the
`users` table empty, which is what the next step needs.

## 5. Start

```sh
sudo systemctl start loombre-server loombre-worker
sudo systemctl status loombre-server loombre-worker
curl http://127.0.0.1:3001/healthz
```

**If you installed with `--no-systemd`** (see [step 3](#3-extract--install)),
there are no units to start — `install.sh` printed the exact commands at
the end of its own output; they run the two binaries directly, as the
`loombre` user, with the env file's contents exported:

```sh
sudo -u loombre env $(cat /etc/loombre/loombre.env | grep -v '^#' | xargs) /opt/loombre/bin/loombre-server
sudo -u loombre env $(cat /etc/loombre/loombre.env | grep -v '^#' | xargs) /opt/loombre/bin/loombre-worker
```

(Run each in its own terminal/session, or background them yourself —
this mode is for testing/containers; a real host should use systemd.)
Minimal container base images often don't have `sudo` installed at all
(`apt-get install -y sudo`, or swap `sudo -u loombre` for
`su -s /bin/sh -c '<command>' loombre` if you'd rather not add it).
Then, from a third terminal: `curl http://127.0.0.1:3001/healthz`.

Either way, once `/healthz` returns `200`, open `http://<this host>:3001`
in a browser (`http://127.0.0.1:3001` locally). Because step 4 ran
`pnpm db:migrate` only — not `db:seed` — the `users` table is still empty:
`GET /setup/state` reports `needsSetup: true` and the web client shows the
first-run wizard (admin account creation → library paths → hardware
capability probe), exactly as described in
[the overview's onboarding section](index.md#first-run-onboarding-wizard).
There is no default account to look up — you create the real one here.

## Why unsigned?

Code-signing certificates (Windows Authenticode, Apple notarization) cost
money a project with no telemetry and no revenue doesn't take. Checksum +
minisign-signature verification is the open-source trust model instead —
see `docs/PLAN.md` §11/P4.9. This is a deliberate, disclosed tradeoff, not
an oversight.

## Uninstalling

```sh
cd loombre-<version>-linux-<arch>   # or wherever you extracted it
sudo ./uninstall.sh                 # leaves only /var/lib/loombre (the data dir) behind
sudo ./uninstall.sh --purge          # also deletes them — irreversible
```

## Systemd hardening (for reference)

Both units run as the dedicated `loombre` system user with `ProtectSystem=strict`
(the entire filesystem read-only except the data dir), `PrivateTmp`,
`NoNewPrivileges`, and a locked-down capability set. See
`installers/linux/systemd/*.service.template` for the full unit definitions.

This means:
- Loombre cannot read or write files outside `/opt/loombre` and `/var/lib/loombre`
- No new capabilities or privilege escalation after startup
- Crash logs and temporary files stay in the private container

---

## Troubleshooting

### Server won't start / systemd reports "Failed"

```sh
journalctl -u loombre-server -f
```

This shows the server's boot logs in real time. (Installed with
`--no-systemd`? There's no unit for `journalctl` to read — run
`/opt/loombre/bin/loombre-server` in the foreground instead, or check
wherever you redirected its stdout/stderr when you backgrounded it.)
Common issues:

- **`ERR_MODULE_NOT_FOUND` or `Cannot find module`** — usually a build/packaging
  issue. Confirm the tarball extracted completely: `tar -tzf loombre-*.tar.gz |
  wc -l` should show thousands of files. If you extracted it manually, re-extract
  and reinstall.
- **`EADDRINUSE: Address already in use`** — port 3001 (or another port if you
  changed `LOOMBRE_PORT`) is already in use. Check `lsof -i :3001` or `netstat
  -tuln | grep 3001` to see what's using it.
- **`connect ECONNREFUSED` on startup** — usually the PostgreSQL connection.
  Check `DATABASE_URL` in `/etc/loombre/loombre.env`; for embedded PG, confirm
  the data directory exists and is owned by `loombre`: `ls -ld /var/lib/loombre/`

### Permission errors reading library folders

The scanner runs as the `loombre` user. If you're bind-mounting library folders
or using network mounts, the `loombre` user must be able to read them:

```sh
sudo chown -R loombre:loombre /mnt/media   # or your library path
sudo chmod -R o+rx /mnt/media             # if using NFO sidecars
```

For network mounts, check that the mount itself is readable by the `loombre` user:
`sudo -u loombre ls /mnt/media` should list files without errors.

### Worker container is "Starting" and never becomes "Running"

```sh
journalctl -u loombre-worker -f
```

The worker needs database connectivity and must wait for the server to be up
(they share the same `DATABASE_URL`). If the server is running and the worker
still fails to connect, check:

- `DATABASE_URL` syntax (must be valid, same as the server)
- Firewall rules or network connectivity to the PostgreSQL host (external mode)

### Logs are full of "No such file or directory" during scan

This is often NFO sidecars or other per-file metadata. Loombre reads NFO files
but never writes them (D8) — having stale/moved NFO files alongside your media
is safe; they're just logged as not-found. If you want to clean them up:

```sh
find /path/to/media -name "*.nfo" -mtime +180 -delete  # delete old ones
```

### Port already in use (for ACME/TLS)

If you're using built-in ACME (`LOOMBRE_TLS_MODE=acme` with `http-01`), the
server needs to bind port 80. Check what's using it:

```sh
sudo lsof -i :80
sudo systemctl stop apache2   # if httpd is running
sudo systemctl disable apache2
```

For systemd, add the capability as described in `docs/ops/acme.md`: edit
`/etc/systemd/system/loombre-server.service` and add
`AmbientCapabilities=CAP_NET_BIND_SERVICE` to the `[Service]` section, then
`sudo systemctl daemon-reload && sudo systemctl restart loombre-server`.
