# systemd

Loombre's native Linux installs (the alternative to the Docker/Compose
canonical path — see `docs/install/linux.md`) ship three systemd unit
templates, rendered for your system by whichever channel you installed
from — the `.rpm`, the `.deb`, or the tarball:

- `installers/linux/systemd/loombre-server.service.template`
- `installers/linux/systemd/loombre-worker.service.template`
- `installers/linux/systemd/loombre-web.service.template` — the
  browser-facing web UI (Next.js standalone server on `LOOMBRE_WEB_PORT`,
  default 3000); its `ReadWritePaths` additionally covers the web tree's
  `.next/cache` for Next's runtime cache.
- `installers/linux/install.sh` — renders all three templates
  (substituting the install prefix, data dir, config dir, and service
  user you choose) and installs them via `systemctl enable --now` by
  default (`--no-start` opts out of the immediate start).

The `.rpm`/`.deb` render the **same** templates, at package-build time,
with the default paths — proven byte-identical against `install.sh`'s own
substitutions by `installers/linux/native-package.test.mjs`. Where the
rendered units land is the one difference:

| Channel | Unit files live in |
|---|---|
| `.rpm` / `.deb` | `/usr/lib/systemd/system/` — package-owned; replaced on every upgrade |
| tarball | `/etc/systemd/system/` — written by `install.sh`, removed by `uninstall.sh` |

**Customise with drop-ins, not by editing the unit.** `sudo systemctl edit
loombre-server` writes
`/etc/systemd/system/loombre-server.service.d/override.conf`, which layers
on top of the shipped unit — the one form of customisation that survives an
upgrade on every channel. A full copy of a unit in
`/etc/systemd/system/loombre-server.service` shadows the packaged one
instead, so later releases' unit changes silently never reach you; the
package install prints a NOTE when it finds one, and `systemctl cat
loombre-server` shows which file is actually in force.

Full install/upgrade/uninstall instructions: `docs/install/linux.md`.

## One thing this page DOES cover: privileged ports

All three shipped unit templates run with an **empty** `CapabilityBoundingSet=`
/ `AmbientCapabilities=` by design — zero Linux capabilities beyond what
an ordinary unprivileged process gets, consistent with the rest of that
unit's hardening (`ProtectSystem=strict`, `NoNewPrivileges=true`, and the
full `Protect*`/`Restrict*` set). This is correct for the common case
(`LOOMBRE_TLS_MODE=off`, or `manual`/`acme` on an unprivileged port behind
your own port-forwarding rule) but means the unit **cannot bind port
80/443 as shipped**.

If you're turning on built-in ACME (`docs/ops/remote-access/acme.md`) or manual TLS
directly on 80/443, see that page's "The port story, honestly" section
for the exact `CapabilityBoundingSet=`/`AmbientCapabilities=CAP_NET_BIND_SERVICE`
drop-in (and the `setcap`/`authbind` alternatives) — this is the one
systemd-specific piece of that story, kept here as the canonical spot so
both docs can point at each other instead of drifting out of sync.

## Two more things the units decide

**`/run/loombre` on `loombre-server`** is where the server publishes the
desktop tray's discovery file and bearer token (`Environment=
LOOMBRE_IPC_DIR=/run/loombre`). The unit's
`ExecStartPre=+/opt/loombre/bin/loombre-ipc-dir-setup /run/loombre loombre`
line (the `+` runs it as root, outside the sandbox) creates the directory
owned by the service account, hands it to the host's local-administrator
group — `wheel`, `sudo` or `admin`, whichever exists first, or
`LOOMBRE_IPC_GROUP` from the env file — and makes it setgid `2750`, so
the `0640` files the server writes inherit that group: an admin's tray can
read them, nobody else can list them. Root has to do this: an
unprivileged process may only `chown` a file to a group it is a member
of, and `loombre` is deliberately not an administrator. It is not a
`RuntimeDirectory=` on purpose: systemd re-applies the unit's user, group
and mode to a runtime directory when it starts the main process, after
`ExecStartPre` has run, which undid exactly this grant. `ReadWritePaths`
lists the directory (with a `-`, so a missing one never fails the unit),
and an `ExecStopPost=+` line removes it on stop, which also retires any
stale discovery file.

**`PrivateTmp=true` on all three** means each service has its own `/tmp`.
Transcode staging therefore defaults to `<data dir>/transcode`
(`LOOMBRE_TRANSCODE_DIR`, set by the `bin/` wrappers), the one path both
`loombre-server` and `loombre-worker` may write. Moving it elsewhere is a
two-part change — the env variable, plus a `ReadWritePaths=<path>` drop-in
on BOTH units, because `ProtectSystem=strict` leaves everything else
read-only:

```sh
sudo systemctl edit loombre-server    # [Service]\nReadWritePaths=/mnt/nvme/loombre-staging
sudo systemctl edit loombre-worker    # the same drop-in
```

GPU access for hardware transcoding needs no unit change at all: the
service account is a member of `render`/`video` (the installers add it),
and systemd applies `/etc/group` membership on every start.

**`KillMode=mixed` on all three.** A stop sends SIGTERM to the Node
process alone and only SIGKILLs the rest of the control group after it
has exited. With systemd's default (`control-group`) every process was
signalled at once: the log `tee` the wrappers use died first, Node's next
log line crashed on EPIPE, and the embedded PostgreSQL went into shutdown
under the server's own graceful stop — two spurious crash reports on
every clean stop. `mixed` lets each process finish in the order the
software already enforces.

## Everything else (service management, logs, upgrades)

`docs/install/linux.md` is authoritative — `systemctl start|stop|status
loombre-server`, `journalctl -u loombre-server -f`, upgrade-in-place steps,
and the full directory layout are all covered there, not duplicated here.
