# systemd

Loombre's Linux tarball install (the alternative to the Docker/Compose
canonical path — see `docs/install/linux.md`) ships three systemd unit
templates and an installer that renders them for your system:

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
for the exact `AmbientCapabilities=CAP_NET_BIND_SERVICE` addition (and
the `setcap`/`authbind` alternatives) — this is the one systemd-specific
piece of that story, kept here as the canonical spot so both docs can
point at each other instead of drifting out of sync.

## Everything else (service management, logs, upgrades)

`docs/install/linux.md` is authoritative — `systemctl start|stop|status
loombre-server`, `journalctl -u loombre-server -f`, upgrade-in-place steps,
and the full directory layout are all covered there, not duplicated here.
