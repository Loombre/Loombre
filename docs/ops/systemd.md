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

Both shipped unit templates run with an **empty** `CapabilityBoundingSet=`
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

## Everything else (service management, logs, upgrades)

`docs/install/linux.md` is authoritative — `systemctl start|stop|status
loombre-server`, `journalctl -u loombre-server -f`, upgrade-in-place steps,
and the full directory layout are all covered there, not duplicated here.
