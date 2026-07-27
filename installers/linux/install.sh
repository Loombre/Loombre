#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Loombre :: installers/linux/install.sh
#
# Installs a loombre-<version>-linux-<arch>.tar.gz payload (this script
# ships INSIDE that tarball, at its root, alongside bin/ lib/ runtime/
# ffmpeg/ web/ pg/ VERSION — see LAYOUT.md) into a running Linux system:
# a dedicated system user, an app-data directory, an env file, and
# (unless --no-systemd) systemd units. Re-run is idempotent — an existing
# user/prefix/data-dir is reused, not recreated.
#
# Usage:
#   sudo ./install.sh [--prefix /opt/loombre] [--data-dir /var/lib/loombre]
#                      [--config-dir /etc/loombre] [--user loombre]
#                      [--no-systemd] [--help]
#
# --no-systemd is for containerized/rootless smoke testing (installers/linux/
# smoke.mjs) where systemd is not PID 1: everything else (user, dirs, env
# file, app payload copy) still happens; only the unit-file install +
# `systemctl daemon-reload` step is skipped. Operators boot the two
# processes directly via <prefix>/bin/loombre-server and <prefix>/bin/loombre-worker
# in that mode.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"

PREFIX="/opt/loombre"
DATA_DIR="/var/lib/loombre"
CONFIG_DIR="/etc/loombre"
LOOMBRE_USER="loombre"
NO_SYSTEMD=0

usage() {
  cat <<'EOF'
Usage: sudo ./install.sh [options]

Options:
  --prefix DIR       Install location (default: /opt/loombre)
  --data-dir DIR      App-data directory — scan/transcode output, caches,
                       and (if used) the embedded PG cluster all live here
                       (default: /var/lib/loombre)
  --config-dir DIR    Env-file location (default: /etc/loombre)
  --user NAME          System user the services run as (default: loombre)
  --no-systemd         Skip systemd unit install (containerized/rootless
                        testing — see installers/linux/smoke.mjs)
  --help               Show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --config-dir) CONFIG_DIR="$2"; shift 2 ;;
    --user) LOOMBRE_USER="$2"; shift 2 ;;
    --no-systemd) NO_SYSTEMD=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "install.sh: unrecognized argument: $1" >&2; usage >&2; exit 1 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "install.sh: must run as root (sudo ./install.sh ...)" >&2
  exit 1
fi

if [ ! -f "${SCRIPT_DIR}/VERSION" ] || [ ! -x "${SCRIPT_DIR}/bin/loombre-server" ]; then
  echo "install.sh: ${SCRIPT_DIR} does not look like an extracted Loombre tarball (missing VERSION / bin/loombre-server)" >&2
  exit 1
fi
VERSION="$(cat "${SCRIPT_DIR}/VERSION")"

echo "install.sh: installing Loombre ${VERSION} -> prefix=${PREFIX} data-dir=${DATA_DIR} config-dir=${CONFIG_DIR} user=${LOOMBRE_USER} systemd=$([ "$NO_SYSTEMD" -eq 1 ] && echo no || echo yes)"

# ── system user (idempotent) ────────────────────────────────────────────
if id "${LOOMBRE_USER}" >/dev/null 2>&1; then
  echo "install.sh: system user '${LOOMBRE_USER}' already exists — reusing"
elif command -v useradd >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin "${LOOMBRE_USER}"
  echo "install.sh: created system user '${LOOMBRE_USER}'"
elif command -v adduser >/dev/null 2>&1; then
  # Alpine/BusyBox-style adduser (no useradd) — same effect.
  adduser -S -D -H -s /usr/sbin/nologin "${LOOMBRE_USER}"
  echo "install.sh: created system user '${LOOMBRE_USER}' (adduser)"
else
  echo "install.sh: neither useradd nor adduser found — cannot create system user '${LOOMBRE_USER}'" >&2
  exit 1
fi

# ── app payload -> PREFIX (read-only for the service; root-owned) ──────
mkdir -p "${PREFIX}"
for entry in bin lib runtime ffmpeg web pg packages VERSION; do
  if [ -e "${SCRIPT_DIR}/${entry}" ]; then
    rm -rf "${PREFIX:?}/${entry}"
    cp -R "${SCRIPT_DIR}/${entry}" "${PREFIX}/${entry}"
  fi
done
chown -R root:root "${PREFIX}"
chmod -R go-w "${PREFIX}"
chmod 755 "${PREFIX}/bin/loombre-server" "${PREFIX}/bin/loombre-worker" "${PREFIX}/bin/loombre"
echo "install.sh: app payload installed at ${PREFIX}"

# ── PATH shim: /usr/local/bin/loombre -> $PREFIX/bin/loombre (L2, ──────
#    the H2-recovery invocability fix — `loombre admin reset-pin` reachable
#    from a fresh shell with no path prefix). This script is root-gated
#    (see the gate above), so there is no "user-mode install" branch here
#    — placing the shim is purely DEFENSIVE instead: any failure to create
#    it (unwritable /usr/local/bin, a read-only mount, a foreign file
#    already occupying the path) WARNS and prints the exact manual command
#    but never fails the install (owner-brief adjudication B-1).
SHIM_PATH="/usr/local/bin/loombre"
SHIM_TARGET="${PREFIX}/bin/loombre"
# -sfn so the printed command works even when a (stale) symlink already
# occupies the path; sudo because the operator pasting it later is most
# likely NOT in the root shell this installer required (Lane R F3).
SHIM_MANUAL_CMD="sudo ln -sfn \"${SHIM_TARGET}\" \"${SHIM_PATH}\""
if [ -L "${SHIM_PATH}" ]; then
  # Already a symlink — a prior install/upgrade, or a stale link left over
  # from a different prefix. Always safe to replace outright (B-3): this is
  # the idempotent re-install/upgrade path, never a foreign file.
  if ln -sfn "${SHIM_TARGET}" "${SHIM_PATH}" 2>/dev/null; then
    echo "install.sh: PATH shim ${SHIM_PATH} -> ${SHIM_TARGET}"
  else
    echo "install.sh: WARNING — could not replace the PATH shim at ${SHIM_PATH} (continuing install)." >&2
    echo "install.sh: run this yourself to put 'loombre' on PATH:" >&2
    echo "  ${SHIM_MANUAL_CMD}" >&2
  fi
elif [ -e "${SHIM_PATH}" ]; then
  # A foreign, non-symlink file already occupies this path — never clobber
  # it (B-3). Warn and move on; the install itself is unaffected.
  echo "install.sh: WARNING — a foreign file already exists at ${SHIM_PATH} (not a symlink) — leaving it untouched." >&2
  echo "install.sh: run 'loombre' via its full path instead, or free up ${SHIM_PATH} yourself and re-run:" >&2
  echo "  ${SHIM_MANUAL_CMD}" >&2
else
  if mkdir -p "$(dirname "${SHIM_PATH}")" 2>/dev/null && ln -s "${SHIM_TARGET}" "${SHIM_PATH}" 2>/dev/null; then
    echo "install.sh: PATH shim ${SHIM_PATH} -> ${SHIM_TARGET}"
  else
    echo "install.sh: WARNING — could not create the PATH shim at ${SHIM_PATH} (unwritable or missing directory; continuing install)." >&2
    echo "install.sh: run this yourself to put 'loombre' on PATH:" >&2
    echo "  ${SHIM_MANUAL_CMD}" >&2
  fi
fi

# ── data dir (the ProvisioningInterface caller's app-data dir — P4.2) ──
mkdir -p "${DATA_DIR}"
chown -R "${LOOMBRE_USER}:${LOOMBRE_USER}" "${DATA_DIR}"
chmod 750 "${DATA_DIR}"
echo "install.sh: data dir ready at ${DATA_DIR} (owner ${LOOMBRE_USER}:${LOOMBRE_USER}, 0750)"

# ── env file (never overwritten once it exists — an operator's edits, ──
#    e.g. a real DATABASE_URL, must survive `install.sh` re-runs/upgrades) ─
mkdir -p "${CONFIG_DIR}"
ENV_FILE="${CONFIG_DIR}/loombre.env"
if [ -f "${ENV_FILE}" ]; then
  echo "install.sh: ${ENV_FILE} already exists — leaving it untouched"
else
  cat > "${ENV_FILE}" <<EOF
# Loombre environment file — installers/linux/install.sh generated this
# skeleton. Values here are read by both loombre-server and loombre-worker
# (systemd's EnvironmentFile=, or sourced directly in --no-systemd mode).

# Server HTTP port.
PORT=3001

NODE_ENV=production

# App-data directory (matches the --data-dir this was installed with).
LOOMBRE_DATA_DIR=${DATA_DIR}

# External PostgreSQL (P4.2's "external-PG env var path" — first-class and
# equally tested). Uncomment and point at your own Postgres 17+ instance.
# Embedded PostgreSQL (when lane B's payload is present under pg/) is the
# alternative — leave DATABASE_URL unset to use it once that path lands.
#DATABASE_URL=postgres://loombre:CHANGE_ME@127.0.0.1:5432/loombre

# JWT signing secret. STRONGLY recommended to set explicitly in any real
# deployment — without it the server falls back to an EPHEMERAL per-process
# secret (every restart logs every device out). Generate one with:
#   openssl rand -base64 48
#LOOMBRE_JWT_SECRET=

# Reverse-proxy deployments: uncomment if loombre-server sits behind your
# own trusted reverse proxy (nginx/Caddy/Traefik) that sets X-Forwarded-For.
#LOOMBRE_TRUST_PROXY=loopback

# CORS allow-list for the web client, comma-separated. Empty disables CORS
# entirely (same-origin deployments behind one reverse proxy).
#LOOMBRE_CORS_ORIGINS=http://localhost:3000
EOF
  chown root:"${LOOMBRE_USER}" "${ENV_FILE}"
  chmod 640 "${ENV_FILE}"
  echo "install.sh: wrote ${ENV_FILE} (0640, root:${LOOMBRE_USER})"
fi

# ── systemd units ───────────────────────────────────────────────────────
if [ "${NO_SYSTEMD}" -eq 1 ]; then
  echo "install.sh: --no-systemd — skipping unit install. Start manually:"
  echo "  sudo -u ${LOOMBRE_USER} env \$(cat ${ENV_FILE} | grep -v '^#' | xargs) ${PREFIX}/bin/loombre-server"
  echo "  sudo -u ${LOOMBRE_USER} env \$(cat ${ENV_FILE} | grep -v '^#' | xargs) ${PREFIX}/bin/loombre-worker"
else
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "install.sh: systemctl not found but --no-systemd was not passed — pass --no-systemd on non-systemd hosts" >&2
    exit 1
  fi
  UNIT_DIR="/etc/systemd/system"
  for svc in loombre-server loombre-worker; do
    sed \
      -e "s#__PREFIX__#${PREFIX}#g" \
      -e "s#__DATA_DIR__#${DATA_DIR}#g" \
      -e "s#__CONFIG_DIR__#${CONFIG_DIR}#g" \
      -e "s#__LOOMBRE_USER__#${LOOMBRE_USER}#g" \
      "${SCRIPT_DIR}/systemd/${svc}.service.template" > "${UNIT_DIR}/${svc}.service"
  done
  systemctl daemon-reload
  systemctl enable loombre-server.service loombre-worker.service
  echo "install.sh: systemd units installed + enabled (not started — configure ${ENV_FILE} first, then:"
  echo "  sudo systemctl start loombre-server loombre-worker"
fi

echo "install.sh: done. Loombre ${VERSION} installed at ${PREFIX}."
