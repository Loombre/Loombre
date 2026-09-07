# Installing Loombre on Linux (rpm, deb, or tarball)

Loombre ships self-contained on Linux: a bundled Node runtime, bundled
ffmpeg, an embedded PostgreSQL, and a desktop tray controller — no system
Node, no system ffmpeg, no Docker required.

**Docker/Compose is the recommended path** (see `docs/install/docker.md`).
This page covers the three native alternatives: bare-metal installs,
containers without Docker-in-Docker, or anyone who prefers systemd-managed
services.

## Choose a channel

All three carry the **same payload** — the `.rpm` and `.deb` are built from
the very tarball below, so a given version ships identical bytes on every
channel. They differ only in who owns the files afterwards.

| Channel | Use it on | Install with |
|---|---|---|
| **`.rpm`** | Fedora (currently supported releases), RHEL 9 and 10 and their rebuilds (Rocky, Alma), openSUSE Leap 15.6 | `sudo dnf install ./loombre-<version>-linux-x64.rpm` |
| **`.deb`** | Debian 12 and 13, Ubuntu 22.04 LTS, 24.04 LTS and 26.04 LTS (25.10 too) | `sudo apt install ./loombre-<version>-linux-x64.deb` |
| **tarball** | any glibc ≥ 2.34 distro; the only channel with relocatable paths (`--prefix`, `--data-dir`, `--user`) and the only one that runs without a package manager | `sudo ./install.sh` |

**glibc ≥ 2.34 is the floor on every channel.** It comes from the bundled
PostgreSQL binaries, not from Loombre's own code. On the two package
channels that floor is a real dependency, so RHEL 8, Debian 11 and Ubuntu
20.04 **refuse at dependency resolution** — `nothing provides
libc.so.6(GLIBC_2.34)(64bit)` on rpm, `libc6 (>= 2.34)` on deb — rather
than installing and crashing later. Those releases need the Docker path.

**Published releases carry x64 artifacts only.** The release pipeline
builds Linux on an x64 runner, so `loombre-<version>-linux-x64.rpm`,
`…-x64.deb` and `…-x64.tar.gz` are what a release page offers. For arm64
(a Pi 5, an Ampere box) build from a checkout of the same version, on the
arm64 machine — the tarball first, then a package from it if you want one:

```sh
node installers/linux/build-tarball.mjs --arch arm64
node installers/linux/build-rpm.mjs --tarball installers/linux/dist/loombre-<version>-linux-arm64.tar.gz
node installers/linux/build-deb.mjs --tarball installers/linux/dist/loombre-<version>-linux-arm64.tar.gz
```

(The package builders need either `rpmbuild`/`dpkg-deb` on `PATH` or a
running Docker — see each script's `--help`. The arm64 tarball installs
with its bundled `install.sh` exactly like the published x64 one.)

## 1. Download

```sh
# Replace <version> — and pick ONE of the three artifacts.
# Published releases are x64 only (arm64: build from source, see above).
curl -LO https://github.com/Loombre/Loombre/releases/download/v<version>/loombre-<version>-linux-x64.rpm
curl -LO https://github.com/Loombre/Loombre/releases/download/v<version>/loombre-<version>-linux-x64.deb
curl -LO https://github.com/Loombre/Loombre/releases/download/v<version>/loombre-<version>-linux-x64.tar.gz

curl -LO https://github.com/Loombre/Loombre/releases/download/v<version>/SHA256SUMS
curl -LO https://github.com/Loombre/Loombre/releases/download/v<version>/SHA256SUMS.minisig
```

`SHA256SUMS`/`SHA256SUMS.minisig` are **shared across every artifact in the
release** (the tarball, the packages, the Windows `.exe`, the macOS
`.pkg`, …) — one checksum listing, one signature, covering the whole
release; there is no per-artifact `<file>.sha256`/`<file>.minisig`. You
don't need to know every other filename in it — the commands below only
touch the line for the file you actually downloaded.

## 2. Verify what you downloaded

Loombre ships unsigned — no code-signing certificate, and **no GPG key on
the `.rpm`/`.deb` either** (see "Why unsigned?" below). Checksum +
signature verification is the primary trust ritual, and on the package
channels it is the *only* one: `dnf` and `apt` install a local file with no
signature prompt at all, and `zypper` installs one as soon as you pass
`--allow-unsigned-rpm` (step 3a). **Do this every time**, not just the
first install, and do it *before* you hand the file to a package manager. This is the same three-layer model
`docs/ops/updating.md`'s "Verifying releases" section documents for the
in-app update checker — released files use exactly the same files/commands.

Substitute the file you downloaded for `<file>` in the commands below —
`loombre-<version>-linux-x64.rpm`, `…-x64.deb`, or
`…-linux-<arch>.tar.gz`.

### 1. GitHub artifact attestation (no key handling required)

```sh
gh attestation verify <file> --repo Loombre/Loombre
```

Proves this exact file was built by Loombre's own CI, from this exact
repository, at this exact commit. Needs the `gh` CLI, signed in
(`gh auth login`).

### 2. Checksum (integrity — did the download complete correctly?)

```sh
sha256sum --ignore-missing -c SHA256SUMS
```

`SHA256SUMS` lists every artifact in the release, not just your file —
`--ignore-missing` skips the lines for files you didn't download instead of
failing the whole check on them. This verifies your download wasn't
corrupted in transit. It does **not** prove the file came from Loombre —
that's what the minisign signature (next) is for.

### 3. minisign signature (authenticity — did this come from Loombre?)

The signature covers `SHA256SUMS` itself — not each individual artifact —
so verifying it, combined with the checksum match above, transitively
proves your download is authentic too:

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

## 3. Install

Pick the section for your channel. Skip to
[step 4](#_4-configure) once the install prints its URLs.

### 3a. The `.rpm` package (Fedora, RHEL 9/10, Rocky, Alma, openSUSE)

```sh
sudo dnf install ./loombre-<version>-linux-x64.rpm
```

**The `./` is required.** Without it `dnf` treats `loombre-…rpm` as the
name of a package in a repository and reports that no match was found.

On **openSUSE Leap 15.6**, `zypper` refuses an unsigned rpm unless you say
so explicitly:

```sh
sudo zypper install --allow-unsigned-rpm ./loombre-<version>-linux-x64.rpm
```

### 3b. The `.deb` package (Debian 12/13, Ubuntu 22.04/24.04/26.04 LTS)

```sh
sudo apt install ./loombre-<version>-linux-x64.deb
```

**The `./` is required** here too — without it `apt` looks for a
repository package by that name. If the file sits in a directory the
unprivileged `_apt` user cannot read (your home directory, typically),
`apt` prints `_apt` **couldn't access** … / **Download is performed
unsandboxed** … and carries on. That notice is harmless: the install
proceeds as root.

**Ubuntu 25.10 and 26.04 LTS** ship `libxml2-16` and no `libxml2.so.2`,
which the bundled PostgreSQL links against — so Loombre carries its own
copy of that library next to PostgreSQL's other libraries (an MIT-licensed
`libxml2.so.2` taken from Rocky Linux 9's package, pinned by checksum in
`installers/libxml2-manifest.json`; PostgreSQL's own `RUNPATH` finds it
first). The `.deb` therefore installs on those releases exactly as on
24.04, and the package never depends on a `libxml2` package at all.

### 3c. The tarball (any glibc ≥ 2.34 distro)

Two small shared libraries are needed by the bundled PostgreSQL (the
default embedded-database mode). Ordinary server installs usually have
them already; minimal/container images may not. **This step is for the
tarball only** — the `.rpm`/`.deb` declare these as real dependencies and
their package manager pulls them in for you:

```sh
# Debian/Ubuntu (24.04 and later resolve libreadline8 to libreadline8t64 by themselves)
apt install libgssapi-krb5-2 libreadline8
# openSUSE
zypper install krb5 libreadline8
# Fedora/RHEL
dnf install krb5-libs readline
```

(libxml2 is not on the list on purpose: the tarball ships its own
`libxml2.so.2` beside the embedded PostgreSQL — see step 3b — so no
distro package is needed for it, on any release.)

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

### What the package install does

Both packages run the same scriptlets, and they do exactly what the
tarball's `install.sh` does with default flags:

- create the **`loombre` system user** (adopting the uid of an existing
  `/var/lib/loombre` when that uid is orphaned — see
  [Migrating from a tarball install](#migrating-from-a-tarball-install-to-a-package))
  and add it to the **`render` and `video` groups** where they exist, so
  the worker can open the GPU for hardware transcoding (see
  [Hardware acceleration](#hardware-acceleration-intel-quick-sync-vaapi-nvidia-nvenc));
- put the payload at **`/opt/loombre`**;
- create **`/etc/loombre/loombre.env`** by copying the shipped default
  `/usr/share/loombre/loombre.env` — **only if that file is absent**, so a
  config you restored beforehand is honoured (`root:loombre`, mode `0640`);
- create **`/var/lib/loombre`** (mode `0750`, owned by `loombre`);
- install the three units at **`/usr/lib/systemd/system`**;
- put the `loombre` CLI at **`/usr/bin/loombre`**;
- install the **desktop tray**: a *Loombre* entry in the application menu
  (`/usr/share/applications/loombre.desktop`), its icons, and a login
  autostart entry for the tray (`/etc/xdg/autostart/loombre-tray.desktop`)
  — see [The desktop tray](#the-desktop-tray);
- **enable and start** `loombre-server`, `loombre-worker` and
  `loombre-web`, then print the web UI and API URLs.

First boot provisions the embedded PostgreSQL and runs migrations, so give
`/healthz` a little longer that very first time (see
[step 5](#_5-start)).

### Installing without starting anything

If you need to edit the env file **before any port is bound** — an external
PostgreSQL, different ports — create the flag file *before* installing:

```sh
sudo mkdir -p /etc/loombre && sudo touch /etc/loombre/no-autostart
sudo dnf install ./loombre-<version>-linux-x64.rpm     # or: sudo apt install ./…deb
```

The install then enables the units but does not start them, deletes the
flag (it is consumed, not sticky), and prints the `systemctl start`
command to run once you have edited `/etc/loombre/loombre.env`. This is
the package channel's equivalent of `install.sh --no-start`.

### No systemd? (containers, WSL1, minimal chroots)

**Packages:** nothing to do. Inside a container or chroot with no systemd
as PID 1, the package installs normally, still *enables* the three units
(enabling only writes symlinks, so the image boots with them on), starts
nothing, and prints the manual-start commands instead. See
[step 5](#_5-start).

**Tarball:** `install.sh`'s last step needs `systemctl` to install + enable
the three units. Without systemd as PID 1 that step fails with `systemctl
not found but --no-systemd was not passed`. Pass `--no-systemd` instead:
everything else (system user, app payload, data dir, env file) still
happens exactly the same; only the unit-file install is skipped:

```sh
sudo ./install.sh --no-systemd
```

See [Start](#_5-start) below for how to run the three processes directly in
this mode — there's no `systemctl start` without systemd.

## 4. Configure

Edit `/etc/loombre/loombre.env` — the same path on every channel — and
consider setting `LOOMBRE_JWT_SECRET` explicitly (`openssl rand -base64
48`). Not required for correctness: an unset secret is generated once at
first boot and persisted under the data dir (P4.7/P4.17), so restarts keep
every device signed in either way — an explicit value in the env file
survives a wiped data directory and gets backed up with the rest of your
configuration.

**Database: nothing to do by default.** Leave `DATABASE_URL` unset and the
server uses the **bundled embedded PostgreSQL**: on first start it
initializes a cluster under the data dir (`/var/lib/loombre`), supervises
it, and **runs migrations automatically at every boot** — no repo checkout,
no separate database, no manual migration step, ever.

**Performance tier: set it on anything bigger than a small box.**
`LOOMBRE_TIER` is not autodetected: unset means Tier 0, the N100 / Pi 5
posture — two simultaneous conversions, a capped quality ladder, and no
processor-based HDR tone-mapping at 1080p and above. On a desktop or
server (a many-core CPU, a discrete GPU) set `LOOMBRE_TIER=2` in the env
file and restart `loombre-server`; see
[Hardware acceleration](#hardware-acceleration-intel-quick-sync-vaapi-nvidia-nvenc)
for why this matters for HDR titles.

**Transcode staging: nothing to do by default.** While a video is being
converted, its HLS segments live under `/var/lib/loombre/transcode` (the
`bin/` wrappers default `LOOMBRE_TRANSCODE_DIR` there). That directory
has to be one **both** `loombre-server` and `loombre-worker` can see: the
units run with `PrivateTmp=true`, so anything under `/tmp` is private to
each service and playback would never start. To move staging to faster
storage, set `LOOMBRE_TRANSCODE_DIR` in the env file **and** add a
`ReadWritePaths=<that path>` drop-in to both units (`sudo systemctl edit
loombre-server`, then `loombre-worker`) — the units are
`ProtectSystem=strict`.

**External PostgreSQL instead?** Point `DATABASE_URL` at your own
PostgreSQL 17+ instance (first-class and equally tested), and run
migrations against it yourself. `loombre` (now on `PATH` — see
[step 3](#_3-install)) does not have a migration subcommand yet;
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

**On the package channels the three are already running** — the install
started and enabled them, and printed the URLs. The commands below are how
you check on them, restart them after an env-file edit, or start them if
you installed with the `no-autostart` flag.

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

**With no systemd** — a container or chroot install of either package, or a
tarball installed with `--no-systemd` (see [step 3](#_3-install)) — there
are no units to start. The install printed the exact commands at the end of
its own output; they run the three binaries directly, as the `loombre`
user, with the env file's contents exported:

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

### Reaching it from other machines on the LAN

This applies to all three native channels. Two things have to change: the
firewall, and two variables in `/etc/loombre/loombre.env`.

Open both ports — 3000 (web UI) and 3001 (API the browser calls
directly):

```sh
# Fedora Server / RHEL and rebuilds (firewalld)
sudo firewall-cmd --permanent --add-port=3000/tcp --add-port=3001/tcp && sudo firewall-cmd --reload

# Ubuntu with ufw
sudo ufw allow 3000/tcp && sudo ufw allow 3001/tcp
```

Then set **both** of these in `/etc/loombre/loombre.env`, using the host
name or IP those other machines actually use — not `localhost`:

```sh
LOOMBRE_CORS_ORIGINS=http://<host>:3000
LOOMBRE_SERVER_ORIGIN=http://<host>:3001
```

The second one is the easy one to miss: the web client's
Content-Security-Policy allows calls to that API origin **only**, and the
`bin/loombre-web` wrapper defaults it to `http://localhost:3001`. Left at
the default, a browser on another machine loads the page and then blocks
every API call. Restart afterwards:

```sh
sudo systemctl restart loombre-server loombre-worker loombre-web
```

### The desktop tray

The Linux counterpart of the macOS menubar app and the Windows tray:
`/opt/loombre/bin/loombre-tray`, a small static binary that puts a
Loombre icon in the system tray with the same menu as the other two
platforms — status, **Open Loombre**, **Start Loombre** / **Stop server**,
**Shut down Loombre…**, **Reveal crash files**, the version, and **Quit**.
Every channel installs it the same way:

- **Application menu:** a *Loombre* entry (`/usr/share/applications/
  loombre.desktop`). Opening it starts the tray if it is not running and
  opens the web UI in your browser as soon as the server answers.
- **Starts at every desktop login** (`/etc/xdg/autostart/loombre-tray.desktop`,
  background only — it never opens a browser uninvited). It is *not*
  started by the install itself (a package install has no desktop session
  to start it in): log out and back in, or run `/opt/loombre/bin/loombre-tray`
  once. To keep it off for your account, copy that file to
  `~/.config/autostart/` and add `Hidden=true`.
- **Who can connect:** the server writes the tray's discovery file and
  bearer token to `/run/loombre/` (a directory the unit's root-run setup
  step creates, setgid to the admin group), token readable by the host's
  local-administrator group — `wheel` on Fedora,
  openSUSE and Arch, `sudo` on Debian and Ubuntu (the same "admins only"
  rule the macOS installer applies with its `admin` group). If your
  desktop account is not in that group the tray still runs, says so, and
  names the exact `usermod` command; **Open Loombre** and **Shut down**
  keep working regardless, since neither needs the connection. A different
  group can be granted with `LOOMBRE_IPC_GROUP` in the env file (members
  can stop the server and list crash files from the tray — nothing more).
- **Start / shut down** go through systemd — `systemctl start loombre-server
  loombre-worker loombre-web` and the matching `stop` — so your desktop's
  polkit agent asks for a password each time, exactly as macOS asks for
  administrator authorization. The install ships a polkit rule
  (`/usr/share/polkit-1/rules.d/50-loombre.rules`) so a member of `wheel`,
  `sudo` or `admin` is asked for **their own** password for these three
  units only; a distribution with an older, non-JavaScript polkit ignores
  the rule and asks whatever its default is (root's password on some).
  **Shut down Loombre…** asks you to click it a second time to confirm
  (there is no dialog toolkit in a static tray binary), then stops all
  three services and quits the tray; the services come back at the next
  boot, or sooner from **Start Loombre**.
- **Stop server** is the graceful, everyday stop over the tray's own
  connection (no password). The embedded PostgreSQL stops with the server,
  so the worker and web UI go idle — the worker logs that its database
  connection dropped, keeps running, and reconnects by itself the moment
  **Start Loombre** brings the server back.
- **Reveal crash files** opens the crash folder when your account can
  read it; on the packaged layout the data directory belongs to the
  service account, so it opens the Dashboard's crash card in the browser
  instead (the same files, through the API) and names the folder in a
  notification for `sudo ls`.
- **GNOME:** GNOME Shell has no system tray of its own — install the
  *AppIndicator and KStatusNotifierItem Support* extension and the icon
  appears; the tray tells you so with a desktop notification when it finds
  no tray host. KDE Plasma, Cinnamon, XFCE, MATE, LXQt and Budgie work as
  they are.
- **Headless host, no desktop?** Nothing to do — the entries are inert
  without a session. To switch the server's tray listener off entirely,
  set `LOOMBRE_IPC_DISABLED=1` in the env file.

### Hardware acceleration (Intel Quick Sync, VAAPI, NVIDIA NVENC)

The worker runs a hardware self-test at boot (and again whenever the
ffmpeg build, the GPUs on the PCI bus, **or its own access to the GPU
device nodes** changes) and the admin Dashboard's *Verified hardware
capabilities* card shows what passed. Three things have to be true on
Linux for a backend to pass:

1. **Device access.** Intel Quick Sync and VAAPI open a DRM render node
   (`/dev/dri/renderD*`), which is group `render` (or `video`) and mode
   `0660`. The install puts the `loombre` account into both groups where
   they exist; if you installed an earlier build, or created the account
   yourself, do it by hand and restart the worker — the self-test notices
   the change and re-runs on its own:

   ```sh
   sudo usermod -aG render,video loombre
   sudo systemctl restart loombre-worker
   ```

   NVIDIA's `/dev/nvidia*` nodes are world-accessible and need no group.
2. **Runtime libraries.** The bundled ffmpeg loads the vendor runtimes
   from the host at runtime: for Quick Sync the Intel media driver plus the
   oneVPL GPU runtime (`intel-media-driver` and `libmfx-gen`/`onevpl-intel-gpu`
   — package names vary by distro; `vainfo` from `libva-utils` confirms the
   driver loads), for VAAPI the same media driver (or Mesa's for AMD), for
   NVENC/CUDA the proprietary NVIDIA driver.
3. **NVIDIA only: the `nvidia_uvm` module.** CUDA (the decode and
   tone-mapping side of NVENC) needs it loaded. On a desktop it usually is,
   but the worker's sandbox (`NoNewPrivileges`) cannot auto-load it, so on
   a server make it explicit:

   ```sh
   echo nvidia_uvm | sudo tee /etc/modules-load.d/nvidia-uvm.conf
   sudo modprobe nvidia_uvm && sudo systemctl restart loombre-worker
   ```

When something is missing, the worker log says exactly what — every
self-test run logs the per-backend outcomes and, on Linux, the device
nodes it could and could not open with the command that fixes it:

```sh
journalctl -u loombre-worker | grep -E 'hwprobe'
# or: grep hwprobe /var/lib/loombre/logs/worker.log
```

A machine with two GPUs (an Intel iGPU and an NVIDIA card is the common
case) gets both: Quick Sync/VAAPI on the Intel render node and NVENC on
the NVIDIA card, tried in the order NVENC → Quick Sync → VAAPI → software.

**HDR titles.** An HDR10/HLG source played on a standard-range screen needs
tone-mapping. The self-test's hardware tone-map checks currently fail on
Linux (the recipes are being reworked — see the worker log's stderr
tails), so tone-mapping falls to the processor, which Loombre allows only
on Tier 1 and 2 (`LOOMBRE_TIER`, above) or when the admin setting
*transcode.allowToneMapCpu* is `always`. On an unset (Tier 0) install every
HDR title is refused as unplayable with the reasons `hdr-tone-map-required`
and `tone-map-refused-by-policy` — set the tier, or the setting, and it
plays.

### SELinux (Fedora / RHEL in enforcing mode)

The units execute binaries under `/opt`, for which no Loombre SELinux
policy module is shipped, so the three services are expected to run in the
unconfined `unconfined_service_t` domain rather than a Loombre-specific
one. **This has not been tested under enforcing mode yet.** If you run
enforcing SELinux, please report what you see — denials in
`ausearch -m avc -ts recent`, or a clean run — so this section can say
something better than "expected".

## Upgrading

### Packages

```sh
sudo dnf upgrade ./loombre-<new version>-linux-x64.rpm
sudo apt install ./loombre-<new version>-linux-x64.deb
```

Verify the new file first, exactly as in
[step 2](#_2-verify-what-you-downloaded).

**The running services stop before the files change and start again
afterwards** — a few seconds of downtime, by design. Restarting *after* the
unpack instead would leave a running postmaster and Node pointed at files
the unpack has already deleted (a PostgreSQL minor bump replaces the
running server's whole library tree), which is a worse trade than a short,
predictable gap. Only the units that were actually running are started
again.

**Your env file is never touched by an upgrade** — no `.rpmnew`, no dpkg
conffile prompt. New releases sometimes add knobs, so compare yours with
the shipped default afterwards and copy across anything you want:

```sh
diff /etc/loombre/loombre.env /usr/share/loombre/loombre.env
```

**Re-installing the same version** (a re-cut build, or a file you
re-downloaded) is a different command — package managers see an identical
version as already installed and do nothing:

```sh
sudo dnf reinstall ./loombre-<version>-linux-x64.rpm
sudo apt reinstall ./loombre-<version>-linux-x64.deb
```

(`sudo dpkg -i ./loombre-<version>-linux-x64.deb` does the same job on the
deb side — every dependency is already satisfied at that point, which is
why the package's own container smoke uses it.)

### Tarball

Extract the new tarball and run `sudo ./install.sh` again with the same
flags you used the first time. It is idempotent: the payload is replaced,
the env file is left alone, and the units are re-rendered.

## Stopping / shutting down completely

Same on all three channels — one command stops the whole stack, worker and
web first, then the server (systemd derives the stop order from the units'
own `After=loombre-server.service` ordering, so the PostgreSQL-hosting
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
and the Windows tray's "Shut down Loombre…" perform — and what the Linux
tray's **Shut down Loombre…** runs for you, with a polkit password prompt;
see [The desktop tray](#the-desktop-tray).)

## Removing Loombre

What survives a removal differs by channel — deliberately. Your library
database lives in `/var/lib/loombre`, and no channel deletes it unless you
ask twice.

| Command | `/var/lib/loombre` (library DB, caches) | `/etc/loombre/loombre.env` | the `loombre` user |
|---|---|---|---|
| `sudo dnf remove loombre` | kept | kept | kept |
| `sudo apt remove loombre` | kept | kept | kept (units masked) |
| `sudo apt purge loombre` | **deleted** (unless it is a mount point) | **deleted** | **deleted** |
| `sudo ./uninstall.sh` (tarball) | kept | **deleted** | **deleted** |
| `sudo ./uninstall.sh --purge` | **deleted** | **deleted** | **deleted** |

Notes per channel:

**`.rpm`** — `dnf remove loombre` stops and disables the units, removes
`/opt/loombre`, and prints exactly what it kept, along with the clean-slate
command if that is what you wanted:

```sh
sudo rm -rf /var/lib/loombre /etc/loombre && sudo userdel loombre
```

The user is kept on purpose: Fedora's packaging guidelines say a uid may
still own files elsewhere on the system, so a package must not delete one.

**`.deb`** — `apt remove loombre` keeps the same three things and
additionally **masks** the units, so nothing can start them by accident
while the package is in the removed-but-not-purged state. `apt purge
loombre` unmasks them and removes the data dir, the config dir and the
user. One exception: **if `/var/lib/loombre` is a separate mount point**,
purge leaves its contents alone and says so — a mounted data volume is
yours, not the package's.

**tarball** —

```sh
cd loombre-<version>-linux-<arch>   # or wherever you extracted it
sudo ./uninstall.sh                 # leaves only /var/lib/loombre (the data dir) behind
sudo ./uninstall.sh --purge         # also deletes that — irreversible
```

Note the difference from the packages: `uninstall.sh` **does** delete the
config dir and the system user. It also removes the `/usr/local/bin/loombre`
PATH shim — but only when it's still a symlink pointing into this install's
own prefix; a foreign file (or a symlink some other install/program put
there) is left alone, untouched.

## Package vs tarball: the deliberate differences

Same payload, same three unit names, same env-file path — but a package
owns its files and a tarball doesn't, and that changes five things:

| | `.rpm` / `.deb` | tarball |
|---|---|---|
| systemd units | `/usr/lib/systemd/system` (package-owned) | `/etc/systemd/system` (admin-owned) |
| `loombre` CLI | `/usr/bin/loombre` | `/usr/local/bin/loombre` |
| the system user on removal | kept (`rpm` erase, `apt remove`); deleted only by `apt purge` | deleted by `uninstall.sh` |
| paths | fixed | relocatable: `--prefix`, `--data-dir`, `--config-dir`, `--user` |
| install without starting | create `/etc/loombre/no-autostart` first | `install.sh --no-start` |

`/usr/local` is why the CLI moves: FHS, Debian Policy and Fedora's
guidelines all reserve it for the local administrator, so a package must
never write there. Need relocatable paths — a data dir on another volume,
a different service user? That is the tarball's job; the packages have no
equivalent flags.

## Customising the units

**Use drop-ins, on every channel.** `systemctl edit` writes
`/etc/systemd/system/loombre-server.service.d/override.conf`, which layers
on top of the shipped unit instead of replacing it — so it survives every
upgrade, on packages and tarball alike:

```sh
sudo systemctl edit loombre-server
```

```ini
[Service]
Environment=SOME_KNOB=value
```

```sh
sudo systemctl restart loombre-server
```

(`systemctl edit` runs `daemon-reload` for you when you save.) A **full
copy** of a unit in `/etc/systemd/system/loombre-server.service` is
different: it shadows the packaged unit entirely, so unit changes shipped
in later releases silently never reach you. The package install prints a
NOTE when it finds one — `systemctl cat loombre-server` shows which file is
actually in force.

## Migrating from a tarball install to a package

The package **refuses to install** while an unpackaged Loombre is present —
a payload at `/opt/loombre` (it looks for that directory's `VERSION` file),
or a regular `/etc/systemd/system/loombre-server.service` whose
`ExecStart=` points at some other prefix.
It says so and exits before writing a single file, because two installs
fighting over one data directory is worse than a failed install. Do this
instead:

```sh
# 1. Back up the env file — uninstall.sh deletes /etc/loombre.
sudo cp /etc/loombre/loombre.env ~/loombre.env.bak

# 2. Remove the tarball install. This KEEPS /var/lib/loombre.
cd loombre-<version>-linux-<arch>   # wherever you extracted it
sudo ./uninstall.sh

# 3. Restore the env file. Doing it now is fine — the package only ever
#    creates that file when it is absent, so yours is never overwritten.
sudo mkdir -p /etc/loombre
sudo cp ~/loombre.env.bak /etc/loombre/loombre.env

# 4. Install the package.
sudo dnf install ./loombre-<version>-linux-x64.rpm     # or: sudo apt install ./…deb
```

Your library and its PostgreSQL cluster carry over untouched.
`uninstall.sh` deletes the `loombre` account but keeps the data directory,
which leaves that directory owned by an orphaned uid; the package's install
scriptlet notices and **recreates `loombre` with that same uid**, so the
existing cluster stays readable with no recursive `chown`. If the uid has
meanwhile been taken by some other account, the scriptlet re-owns the tree
instead and says so.

Going the other way (package → tarball) is the same shape: back up the env
file, `dnf remove` / `apt remove` (not `purge` — that would delete the data
dir), restore the env file, then run the tarball's `install.sh`.

## Why unsigned?

Code-signing certificates (Windows Authenticode, Apple notarization) cost
money a project with no telemetry and no revenue doesn't take. The same
reasoning covers the `.rpm`/`.deb`: no GPG signing key, no repository to
host one in. Checksum + minisign-signature verification is the open-source
trust model instead — see `docs/PLAN.md` §11 and STATE.md P4.9, and do
[step 2](#_2-verify-what-you-downloaded) every time. This is a deliberate,
disclosed tradeoff, not an oversight.

## Systemd hardening (for reference)

All three units run as the dedicated `loombre` system user with
`ProtectSystem=strict` (the entire filesystem read-only except the data
dir — plus, for `loombre-web` only, the web app's own Next runtime-cache
directory under `/opt/loombre/web/`, which Next writes at request time),
`PrivateTmp`, `NoNewPrivileges`, and a locked-down capability set. See
`installers/linux/systemd/*.service.template` for the full unit
definitions — the packages render those same templates, so the units are
identical on every channel. (`MemoryDenyWriteExecute` is deliberately not
set — it is incompatible with V8's JIT, i.e. with Node itself; the
templates document this.)

This means:
- Loombre cannot write files outside `/var/lib/loombre` (and the web cache
  dir above, and `/run/loombre` — where it publishes the desktop tray's
  discovery file and token; a root-run `ExecStartPre` step creates that
  directory, setgid to the admin group, and a stop removes it)
- No new capabilities or privilege escalation after startup
- A stop signals only the Node process (`KillMode=mixed`); the log tee,
  the embedded PostgreSQL and any ffmpeg helper are cleaned up after it
  exits, so a clean stop never files a crash report
- Crash logs and temporary files stay in the private container — which is
  also why transcode staging lives under the data dir rather than `/tmp`:
  each service's `/tmp` is its own (see [Configure](#_4-configure))
- GPU access is by ordinary group membership (`render`/`video`), not by
  weakening the sandbox — see
  [Hardware acceleration](#hardware-acceleration-intel-quick-sync-vaapi-nvidia-nvenc)

---

## Troubleshooting

### Server won't start / systemd reports "Failed"

```sh
journalctl -u loombre-server -f
```

This shows the server's boot logs in real time. (No systemd — a container
install, or a tarball installed with `--no-systemd`? There's no unit for
`journalctl` to read — run `/opt/loombre/bin/loombre-server` in the
foreground instead, or check wherever you redirected its stdout/stderr when
you backgrounded it.)

Every service also writes its own copy of that same output to
`<data dir>/logs/<name>.log` (`server.log` / `worker.log` / `web.log`;
`<data dir>` defaults to `/var/lib/loombre`) — set automatically as
`LOOMBRE_LOG_FILE`, so the admin Dashboard's log-tail card shows the same
content in the browser too, no `journalctl` needed there. See
[Environment variable reference](/ops/env-reference) if you want to point
it somewhere else. Common issues:

- **`ERR_MODULE_NOT_FOUND` or `Cannot find module`** — usually a build/packaging
  issue. On the tarball, confirm it extracted completely: `tar -tzf loombre-*.tar.gz |
  wc -l` should show thousands of files. If you extracted it manually, re-extract
  and reinstall. On a package, `rpm -V loombre` / `dpkg -V loombre` verifies
  the installed files against the package's own checksums.
- **`EADDRINUSE: Address already in use`** — port 3001 (or another port if you
  changed `PORT` in the env file — that is the variable's real name; for the
  web UI's port it's `LOOMBRE_WEB_PORT`, default 3000) is already in use.
  Check `lsof -i :3001` or `netstat -tuln | grep 3001` to see what's using it.
  (Installing a package starts the services immediately; to edit ports before
  anything binds, use the `no-autostart` flag in
  [step 3](#installing-without-starting-anything).)
- **`connect ECONNREFUSED` on startup** — usually the PostgreSQL connection.
  Check `DATABASE_URL` in `/etc/loombre/loombre.env`; for embedded PG, confirm
  the data directory exists and is owned by `loombre`: `ls -ld /var/lib/loombre/`

### Media permissions: the `loombre` account, `ProtectHome`, and `/media/<you>`

All three services run as the dedicated `loombre` system user — never as
you, never as root — inside systemd's sandbox (see
[Systemd hardening](#systemd-hardening-for-reference)). Two consequences
for where media can live:

**Nothing under `/home`, `/root` or `/run/user` is visible to the services
at all.** `ProtectHome=true` mounts an empty, inaccessible directory over
those paths, so no permission change on your actual home folder can help.
The folder picker marks `/home` **No access**, and browsing into it says
so. Keep media under `/srv`, `/mnt` or `/media` — or bind-mount your media
folder to a path outside `/home`:

```sh
sudo mkdir -p /srv/media
sudo mount --bind /home/you/Media /srv/media
# make it permanent — add to /etc/fstab:
# /home/you/Media  /srv/media  none  bind  0  0
```

(Weakening the sandbox instead — a `sudo systemctl edit loombre-server`
drop-in setting `ProtectHome=read-only`, repeated for `loombre-worker` and
`loombre-web` — makes `/home` visible but still leaves your home folder's
own permissions in the way; the bind mount is the simpler answer.)

**Everything else needs ordinary read access for `loombre`.** The folder
picker offers the exact commands for the folder you clicked: a
traverse-only grant for each folder above it that the service cannot pass
through (this reveals nothing else in those folders), then a read grant on
the media folder itself that files added later inherit. Copy, run in a
terminal, then click **Check again**:

```sh
sudo setfacl -m u:loombre:x /media/you                      # pass through only
sudo setfacl -R -m u:loombre:rX,d:u:loombre:rX /media/you/Drive/Movies
```

These ACL grants are additive and revocable — unlike `chown -R`, they don't
take the files away from you. Inspect with `getfacl`; undo with
`sudo setfacl -R -x u:loombre,d:u:loombre /media/you/Drive/Movies` and
`sudo setfacl -x u:loombre /media/you`. Verify with
`sudo -u loombre ls /media/you/Drive/Movies` — it should list files without
errors. (The picker knows that **`/media/<you>/…`** — where desktop Linux
auto-mounts removable drives, in a directory private to you — is where the
traverse grant usually has to start.)

**Drives without ACLs (FAT32, exFAT, NTFS via ntfs-3g).** `setfacl` reports
`Operation not supported` on these, and the picker offers no command for
them. Their permissions come from the mount options instead: mount the
drive yourself with `uid`/`gid`/`umask` values that let `loombre` read it,
for example in `/etc/fstab` (find `loombre`'s numeric group with
`id -g loombre`):

```
UUID=XXXX-XXXX  /mnt/usb  exfat  uid=1000,gid=<loombre gid>,umask=027,nofail  0  0
```

**Network mounts (NFS, SMB/CIFS).** The mount itself must be readable by
`loombre`: for CIFS pass `uid=`/`gid=`/`file_mode=`/`dir_mode=` values that
include it; for NFS the export's ownership and mode govern (map `loombre`'s
uid on the server, or export with `all_squash` and an `anonuid` the service
can read). Verify the same way: `sudo -u loombre ls /mnt/nas`.

### Playback never starts — the player spins forever

Every play request creates a session, the worker starts converting, and the
player waits for the first segment that never arrives. Two causes on
native installs:

- **Transcode staging under `/tmp`** (every 1.0.0-beta.2 install). The
  worker wrote its segments to `/tmp/loombre-transcode`, but the units run
  with `PrivateTmp=true`, so the server's `/tmp` is a different directory
  and it never found them. Fixed from the next release on (the wrappers
  default `LOOMBRE_TRANSCODE_DIR` to `/var/lib/loombre/transcode`); on an
  existing install, set it yourself in `/etc/loombre/loombre.env` and
  restart:

  ```sh
  echo 'LOOMBRE_TRANSCODE_DIR=/var/lib/loombre/transcode' | sudo tee -a /etc/loombre/loombre.env
  sudo systemctl restart loombre-server loombre-worker
  ```

- **A custom staging path outside the data dir** without the matching
  `ReadWritePaths=` drop-in on both units — `journalctl -u loombre-worker`
  shows `EROFS`/`EACCES` creating the session directory. See
  [Configure](#_4-configure).

### Hardware capabilities show "no accelerated paths" on a machine with a GPU

Open the worker log and read the self-test's own explanation:

```sh
journalctl -u loombre-worker | grep -E 'hwprobe'
```

The usual finding is `no DRM render node is accessible` — the `loombre`
account is not in the `render`/`video` group (installs before this
version did not add it). The log line carries the exact `usermod`
command; run it, restart the worker, and the self-test re-runs by itself.
The other causes — a missing oneVPL/media driver, an unloaded
`nvidia_uvm` — are covered in
[Hardware acceleration](#hardware-acceleration-intel-quick-sync-vaapi-nvidia-nvenc).

### Tray icon missing, or the tray says it can't read the token

- **No icon at all on GNOME:** install the *AppIndicator and
  KStatusNotifierItem Support* extension (GNOME Shell ships no tray).
- **Not running:** it starts at login — log out and in, or run
  `/opt/loombre/bin/loombre-tray` from a terminal to see its messages.
- **"Can't read the Loombre IPC token":** your desktop account is not in
  the local-administrator group the token is readable by (`wheel` or
  `sudo`; `ls -ld /run/loombre` shows which — the directory is setgid to
  that group, `drwxr-s---`). Add yourself and log in again:
  `sudo usermod -aG wheel $USER` (or `sudo`). See
  [The desktop tray](#the-desktop-tray).

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

Then grant the one capability that allows binding a privileged port, as a
drop-in (the same recipe on every channel — see
[Customising the units](#customising-the-units) and
`docs/ops/remote-access/acme.md`):

```sh
sudo systemctl edit loombre-server
```

```ini
[Service]
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
AmbientCapabilities=CAP_NET_BIND_SERVICE
```

```sh
sudo systemctl restart loombre-server
```
