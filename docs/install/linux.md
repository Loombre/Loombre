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
release** (this tarball, the Windows `.exe`, the macOS `.pkg`, …) — one
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

Two small shared libraries are needed by the bundled PostgreSQL (the
default embedded-database mode). Ordinary server installs usually have
them already; minimal/container images may not:

```sh
# Debian/Ubuntu
apt install libgssapi-krb5-2 libxml2 libreadline8
# openSUSE
zypper install krb5 libxml2-2 libreadline8
# Fedora/RHEL
dnf install krb5-libs libxml2 readline
```

`install.sh` warns if they are missing (installs pointed at an external
`DATABASE_URL` never run the bundled PostgreSQL and are unaffected).


```sh
tar xzf loombre-<version>-linux-<arch>.tar.gz
cd loombre-<version>-linux-<arch>
sudo ./install.sh
```

Default layout: app at `/opt/loombre`, data at `/var/lib/loombre`, config at
`/etc/loombre/loombre.env`, system user `loombre`. Override with
`--prefix`/`--data-dir`/`--config-dir`/`--user` — see `install.sh --help`.
Full on-disk layout: `installers/linux/LAYOUT.md`.

`install.sh` also places a `loombre` command on `PATH`
(`/usr/local/bin/loombre`, a symlink into the install root — replaced
cleanly on re-install/upgrade). Confirm it:

```sh
loombre --version
```

If `/usr/local/bin/loombre` was occupied by something else already (not a
symlink Loombre itself created) or `/usr/local/bin` wasn't writable,
`install.sh` warns instead of failing and prints the exact command to
create the shim yourself; either way the install itself always succeeds,
and the full-path invocation (`docs/ops/cli.md`'s "Running it") always
works as a fallback.

### No systemd? (containers, WSL1, minimal chroots)

`install.sh`'s last step needs `systemctl` to install + enable the three
units. If your host doesn't run systemd as PID 1 — a Docker/Podman
container, WSL1, a minimal chroot — that step fails with `systemctl not
found but --no-systemd was not passed`. Pass `--no-systemd` instead:
everything else (system user, app payload, data dir, env file) still
happens exactly the same; only the unit-file install is skipped:

```sh
sudo ./install.sh --no-systemd
```

See [Start](#_5-start) below for how to run the three processes directly in
this mode — there's no `systemctl start` without systemd.

## 4. Configure

Edit `/etc/loombre/loombre.env` — at minimum set `LOOMBRE_JWT_SECRET`
(`openssl rand -base64 48`) so restarts don't log every device out.

**Database: nothing to do by default.** Leave `DATABASE_URL` unset and the
server uses the tarball's **bundled embedded PostgreSQL**: on first start
it initializes a cluster under the data dir (`/var/lib/loombre`),
supervises it, and **runs migrations automatically at every boot** — no
repo checkout, no separate database, no manual migration step, ever.

**External PostgreSQL instead?** Point `DATABASE_URL` at your own
PostgreSQL 17+ instance (first-class and equally tested), and run
migrations against it yourself. `loombre` (now on `PATH` — see
[step 3](#_3-extract-install)) does not have a migration subcommand yet;
until it does, external mode still means a repo checkout:

```sh
# EXTERNAL MODE ONLY — from a repo checkout with the same DATABASE_URL.
# Embedded mode (DATABASE_URL unset) needs none of this: it migrates
# itself at boot.
pnpm db:migrate
```

**Do not run `pnpm db:seed` (or `db:seed-large`) against a real instance.**
Those scripts exist to populate throwaway dev/test/CI databases with fixture
data — including an `admin` account whose password is a fixed, publicly
documented string committed in `packages/db/seed/seed.mjs`. Running either
against your real database would give an internet- or LAN-reachable
instance an admin account with a published password; treat that as a
security mistake, not a shortcut. A migrated-but-unseeded database has an
empty `users` table, which is exactly what the next step needs (embedded
mode's auto-migration never seeds either, for the same reason).

## 5. Start

Three services: `loombre-server` (the API, port **3001** — `PORT` in the
env file), `loombre-worker` (background jobs), and `loombre-web` (the
browser UI, port **3000** — `LOOMBRE_WEB_PORT` in the env file).

Optional pre-flight sanity check for **external mode** — read-only,
touches nothing (see `docs/ops/cli.md`; embedded mode has no
`DATABASE_URL` to pass and provisions itself on first start):

```sh
DATABASE_URL=<value from /etc/loombre/loombre.env> loombre doctor
```

```sh
sudo systemctl start loombre-server loombre-worker loombre-web
sudo systemctl status loombre-server loombre-worker loombre-web
curl http://127.0.0.1:3001/healthz
```

(Embedded mode's first start does a real `initdb` + migration run before
the API begins listening — give `/healthz` a little longer on that very
first boot.)

**If you installed with `--no-systemd`** (see [step 3](#_3-extract-install)),
there are no units to start — `install.sh` printed the exact commands at
the end of its own output; they run the three binaries directly, as the
`loombre` user, with the env file's contents exported:

```sh
sudo -u loombre env $(cat /etc/loombre/loombre.env | grep -v '^#' | xargs) /opt/loombre/bin/loombre-server
sudo -u loombre env $(cat /etc/loombre/loombre.env | grep -v '^#' | xargs) /opt/loombre/bin/loombre-worker
sudo -u loombre env $(cat /etc/loombre/loombre.env | grep -v '^#' | xargs) /opt/loombre/bin/loombre-web
```

(Run each in its own terminal/session, or background them yourself —
this mode is for testing/containers; a real host should use systemd.)
Minimal container base images often don't have `sudo` installed at all
(`apt-get install -y sudo`, or swap `sudo -u loombre` for
`su -s /bin/sh -c '<command>' loombre` if you'd rather not add it).
Then, from another terminal: `curl http://127.0.0.1:3001/healthz`.

Either way, once `/healthz` returns `200`, open the **web UI** —
`http://<this host>:3000` in a browser (`http://127.0.0.1:3000` locally;
`:3001` is the API, not a page you browse). The `users` table starts
empty in both database modes (auto-migration never seeds; step 4's manual
migrate doesn't either): `GET /setup/state` reports `needsSetup: true`
and the web client shows the first-run wizard (admin account creation →
library paths → hardware capability probe), exactly as described in
[the overview's onboarding section](index.md#first-run-onboarding-wizard).
There is no default account to look up — you create the real one here.

## Stopping / shutting down completely

One command stops the whole stack — worker and web first, then the
server (systemd derives the stop order from the units' own
`After=loombre-server.service` ordering, so the PostgreSQL-hosting
server goes down last):

```sh
sudo systemctl stop loombre-worker loombre-web loombre-server
```

The services stay stopped until the next boot (they're enabled units) or
until you `systemctl start` them again (the [Start](#_5-start) command).
To keep Loombre off across reboots too:

```sh
sudo systemctl disable --now loombre-worker loombre-web loombre-server
# and later, to bring it back:
sudo systemctl enable --now loombre-server loombre-worker loombre-web
```

(This is the same full shutdown the macOS menubar's "Shut Down Loombre…"
and the Windows tray's "Shut down Loombre…" perform — on Linux the
platform's own service manager is the interface, so there is no separate
Loombre UI for it.)

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

This also removes the `/usr/local/bin/loombre` PATH shim — but only when
it's still a symlink pointing into this install's own prefix; a foreign
file (or a symlink some other install/program put there) is left alone,
untouched.

## Systemd hardening (for reference)

All three units run as the dedicated `loombre` system user with
`ProtectSystem=strict` (the entire filesystem read-only except the data
dir — plus, for `loombre-web` only, the web app's own Next runtime-cache
directory under `/opt/loombre/web/`, which Next writes at request time),
`PrivateTmp`, `NoNewPrivileges`, and a locked-down capability set. See
`installers/linux/systemd/*.service.template` for the full unit
definitions. (`MemoryDenyWriteExecute` is deliberately not set — it is
incompatible with V8's JIT, i.e. with Node itself; the templates document
this.)

This means:
- Loombre cannot write files outside `/var/lib/loombre` (and the web cache dir above)
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

Every service also writes its own copy of that same output to
`<data dir>/logs/<name>.log` (`server.log` / `worker.log` / `web.log`;
`<data dir>` defaults to `/var/lib/loombre`) — set automatically as
`LOOMBRE_LOG_FILE`, so the admin Dashboard's log-tail card shows the same
content in the browser too, no `journalctl` needed there. See
[Environment variable reference](/ops/env-reference) if you want to point
it somewhere else. Common issues:

- **`ERR_MODULE_NOT_FOUND` or `Cannot find module`** — usually a build/packaging
  issue. Confirm the tarball extracted completely: `tar -tzf loombre-*.tar.gz |
  wc -l` should show thousands of files. If you extracted it manually, re-extract
  and reinstall.
- **`EADDRINUSE: Address already in use`** — port 3001 (or another port if you
  changed `PORT` in the env file — that is the variable's real name; for the
  web UI's port it's `LOOMBRE_WEB_PORT`, default 3000) is already in use.
  Check `lsof -i :3001` or `netstat -tuln | grep 3001` to see what's using it.
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

### Worker service fails to start / keeps restarting

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

For systemd, add the capability as described in `docs/ops/remote-access/acme.md`: edit
`/etc/systemd/system/loombre-server.service` and add
`AmbientCapabilities=CAP_NET_BIND_SERVICE` to the `[Service]` section, then
`sudo systemctl daemon-reload && sudo systemctl restart loombre-server`.
