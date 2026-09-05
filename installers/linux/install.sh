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
NO_START=0
INSTALL_DEPS=0
NO_INSTALL_DEPS=0

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
  --no-start           Install and enable the units but do NOT start them.
                        Use when you want to edit the env file (external
                        PostgreSQL, non-default ports) before anything
                        binds a port or creates a database. Without this,
                        install.sh starts the stack immediately — the
                        default configuration is designed to work
                        out of the box with no editing at all.
  --install-deps       Install missing system libraries the bundled
                        PostgreSQL needs, without asking. Use for
                        unattended installs. Without it, an interactive
                        run PROMPTS (showing the exact command first) and
                        a non-interactive run only reports what is
                        missing — this script will not silently change
                        your package set in a pipeline.
  --no-install-deps    Never install anything; just report. Implies the
                        services are enabled but not started when a
                        library is genuinely missing.
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
    --no-start) NO_START=1; shift ;;
    --install-deps) INSTALL_DEPS=1; shift ;;
    --no-install-deps) NO_INSTALL_DEPS=1; shift ;;
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
chmod 755 "${PREFIX}/bin/loombre-server" "${PREFIX}/bin/loombre-worker" "${PREFIX}/bin/loombre-web" "${PREFIX}/bin/loombre"

# Next runtime cache (installer completeness audit, gap 3): the web app's
# standalone server.js chdir()s into web/apps/web and writes its runtime
# cache under .next/cache — the ONE spot inside the otherwise root-owned,
# read-only payload that must be writable by the service user. The
# loombre-web unit's ReadWritePaths= lists exactly this dir (that only
# lifts ProtectSystem=strict's read-only bind; DAC ownership is what this
# chown provides). Created here, empty, rather than shipped in the tarball.
if [ -d "${PREFIX}/web/apps/web/.next" ]; then
  mkdir -p "${PREFIX}/web/apps/web/.next/cache"
  chown -R "${LOOMBRE_USER}:${LOOMBRE_USER}" "${PREFIX}/web/apps/web/.next/cache"
fi
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
  # Rendered from loombre.env.template (shipped at the tarball root next to
  # this script) — the SAME template the .rpm/.deb packages render at build
  # time, so every Linux channel writes a byte-identical skeleton for the
  # same paths. Placeholders follow the systemd templates' idiom
  # (__DATA_DIR__ / __PREFIX__), substituted with the same sed pattern.
  if [ ! -f "${SCRIPT_DIR}/loombre.env.template" ]; then
    echo "install.sh: ${SCRIPT_DIR}/loombre.env.template is missing — the tarball is incomplete (re-extract it)" >&2
    exit 1
  fi
  sed \
    -e "s#__DATA_DIR__#${DATA_DIR}#g" \
    -e "s#__PREFIX__#${PREFIX}#g" \
    "${SCRIPT_DIR}/loombre.env.template" > "${ENV_FILE}"
  chown root:"${LOOMBRE_USER}" "${ENV_FILE}"
  chmod 640 "${ENV_FILE}"
  echo "install.sh: wrote ${ENV_FILE} (0640, root:${LOOMBRE_USER})"
fi

# Load the env file's values into this script's own shell — a re-run over
# an existing, untouched ${ENV_FILE} (see above) may carry an operator's
# custom PORT/LOOMBRE_WEB_PORT, and the closing "where to browse" message
# below must report what is actually configured, not just the defaults
# this script would have written on a fresh install.
set -a
# shellcheck disable=SC1090
. "${ENV_FILE}"
set +a

# ── embedded-PostgreSQL shared-library preflight ────────────────────────
# Runs BEFORE anything is started. It used to run at the very end of this
# script, printing a warning — which was survivable only while install.sh
# left the services stopped. Now that a default install STARTS them, a
# missing library would mean the operator's first experience is a
# crash-looping server and a warning that scrolled past underneath it.
#
# Detect, then OFFER TO FIX (owner directive: "installers detect that the
# necessary dependencies are installed and if not, automatically prompt
# the user to install them prior to continuing"). ldd against the real
# bundled binary is the detection — not a distro/version lookup table,
# which would go stale and cannot know how the host was actually built.
DEPS_MISSING=0
pg_lib_preflight() {
  _pg_bin="$(ls "${PREFIX}"/pg/*/*/bin/postgres 2>/dev/null | head -n 1)"
  [ -n "${_pg_bin}" ] || return 0
  command -v ldd >/dev/null 2>&1 || return 0

  _missing="$(ldd "${_pg_bin}" 2>/dev/null | awk '/not found/ {print $1}' | sort -u | tr '\n' ' ')"
  [ -n "${_missing}" ] || return 0

  echo "install.sh: the bundled PostgreSQL is missing shared libraries: ${_missing}"

  # Package names differ per distro for the SAME sonames; pick by which
  # package manager actually exists rather than by parsing /etc/os-release
  # (derivatives lie about ID, but they cannot fake having apt-get).
  _pm=""
  _pkgs=""
  if command -v apt-get >/dev/null 2>&1; then
    _pm="apt-get"; _install="apt-get install -y"; _pkgs="libgssapi-krb5-2 libxml2 libreadline8"
  elif command -v dnf >/dev/null 2>&1; then
    _pm="dnf"; _install="dnf install -y"; _pkgs="krb5-libs libxml2 readline"
  elif command -v zypper >/dev/null 2>&1; then
    _pm="zypper"; _install="zypper --non-interactive install"; _pkgs="krb5 libxml2-2 libreadline8"
  elif command -v pacman >/dev/null 2>&1; then
    _pm="pacman"; _install="pacman -S --noconfirm"; _pkgs="krb5 libxml2 readline"
  elif command -v apk >/dev/null 2>&1; then
    _pm="apk"; _install="apk add"; _pkgs="krb5-libs libxml2 readline"
  fi

  if [ -z "${_pm}" ]; then
    echo "install.sh: no supported package manager found (looked for apt-get, dnf, zypper, pacman, apk)." >&2
    echo "install.sh: install the packages providing ${_missing} yourself, then re-run this script." >&2
    DEPS_MISSING=1
    return 0
  fi

  _do_install=0
  if [ "${INSTALL_DEPS}" -eq 1 ]; then
    _do_install=1
  elif [ "${NO_INSTALL_DEPS}" -eq 1 ]; then
    _do_install=0
  elif [ -t 0 ]; then
    # Interactive: ask. Never install packages on someone's machine without
    # showing the exact command and getting a yes.
    printf 'install.sh: run "%s %s" now? [Y/n] ' "${_install}" "${_pkgs}"
    read -r _reply || _reply="n"
    case "${_reply}" in
      ""|y|Y|yes|YES) _do_install=1 ;;
      *) _do_install=0 ;;
    esac
  else
    # Non-interactive (CI, piped installs, config management): do NOT
    # silently mutate the system's package set. Say what is needed and let
    # the caller decide with --install-deps.
    echo "install.sh: non-interactive shell — not installing packages automatically." >&2
    echo "install.sh: re-run with --install-deps, or run: ${_install} ${_pkgs}" >&2
    DEPS_MISSING=1
    return 0
  fi

  if [ "${_do_install}" -eq 1 ]; then
    echo "install.sh: installing dependencies: ${_install} ${_pkgs}"
    if [ "${_pm}" = "apt-get" ]; then
      apt-get update -qq || true
    fi
    # shellcheck disable=SC2086
    if ! ${_install} ${_pkgs}; then
      echo "install.sh: dependency install FAILED — resolve it manually, then re-run this script." >&2
      DEPS_MISSING=1
      return 0
    fi
    # Re-probe: trust the linker, not the package manager's exit code.
    _still="$(ldd "${_pg_bin}" 2>/dev/null | awk '/not found/ {print $1}' | sort -u | tr '\n' ' ')"
    if [ -n "${_still}" ]; then
      echo "install.sh: STILL missing after install: ${_still}" >&2
      DEPS_MISSING=1
    else
      echo "install.sh: dependencies satisfied — the bundled PostgreSQL resolves all its libraries."
    fi
  else
    echo "install.sh: skipping dependency install at your request."
    DEPS_MISSING=1
  fi
}

pg_lib_preflight

if [ "${DEPS_MISSING}" -eq 1 ]; then
  # Not fatal: an operator using an external DATABASE_URL never runs these
  # binaries, and that is a first-class supported mode (D1). But do not
  # START a server that provably cannot provision its default database —
  # that just buries the real message under a restart loop.
  echo "install.sh: WARNING — embedded database mode cannot start until the libraries above are present." >&2
  echo "install.sh: services will be installed and enabled but NOT started." >&2
  echo "install.sh: (Installs using an external DATABASE_URL are unaffected — set it in ${ENV_FILE} and start manually.)" >&2
  NO_START=1
fi

# ── systemd units ───────────────────────────────────────────────────────
if [ "${NO_SYSTEMD}" -eq 1 ]; then
  echo "install.sh: --no-systemd — skipping unit install. Start manually:"
  echo "  sudo -u ${LOOMBRE_USER} env \$(cat ${ENV_FILE} | grep -v '^#' | xargs) ${PREFIX}/bin/loombre-server"
  echo "  sudo -u ${LOOMBRE_USER} env \$(cat ${ENV_FILE} | grep -v '^#' | xargs) ${PREFIX}/bin/loombre-worker"
  echo "  sudo -u ${LOOMBRE_USER} env \$(cat ${ENV_FILE} | grep -v '^#' | xargs) ${PREFIX}/bin/loombre-web"
else
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "install.sh: systemctl not found but --no-systemd was not passed — pass --no-systemd on non-systemd hosts" >&2
    exit 1
  fi
  UNIT_DIR="/etc/systemd/system"
  # Three units since the installer completeness audit: loombre-web is the
  # browser-facing UI (Next standalone server, :3000 by default) — without
  # it the tarball shipped a web client nothing ever started.
  for svc in loombre-server loombre-worker loombre-web; do
    sed \
      -e "s#__PREFIX__#${PREFIX}#g" \
      -e "s#__DATA_DIR__#${DATA_DIR}#g" \
      -e "s#__CONFIG_DIR__#${CONFIG_DIR}#g" \
      -e "s#__LOOMBRE_USER__#${LOOMBRE_USER}#g" \
      "${SCRIPT_DIR}/systemd/${svc}.service.template" > "${UNIT_DIR}/${svc}.service"
  done
  systemctl daemon-reload
  if [ "${NO_START}" -eq 1 ]; then
    systemctl enable loombre-server.service loombre-worker.service loombre-web.service
    echo "install.sh: systemd units installed + enabled, NOT started (--no-start). Configure ${ENV_FILE}, then:"
    echo "  sudo systemctl start loombre-server loombre-worker loombre-web"
  else
    # `enable --now` (enable + start in one transaction), the DEFAULT since
    # the rc.1 install-visibility fix. It used to enable only, printing a
    # `systemctl start` line and exiting — which meant a successful install
    # left a machine with nothing running and no UI to look at, matching
    # the macOS/Windows complaint from the same report.
    #
    # "Configure the env file first" was the old justification, and it does
    # not hold: the shipped defaults are a COMPLETE working configuration
    # (embedded PostgreSQL provisioned + migrated on first boot, API on
    # 3001, web UI on 3000). Editing is for people who want something other
    # than the default — and they now have --no-start to say so explicitly,
    # instead of every operator paying for that minority case.
    #
    # Start order matters here in a way `enable` never exposed: the server
    # provisions the embedded cluster and writes the credentials the worker
    # discovers, so it goes first. systemd handles the rest via the units'
    # own After=/Wants= (a slow first-boot initdb is absorbed by the
    # worker's bounded discovery poll and Restart= — see the unit
    # templates), so this is ordering, not a race to win.
    systemctl enable --now loombre-server.service loombre-worker.service loombre-web.service
    echo "install.sh: systemd units installed, enabled and STARTED."
    echo "install.sh: web UI    -> http://localhost:${LOOMBRE_WEB_PORT:-3000}"
    echo "install.sh: API       -> http://localhost:${PORT:-3001}"
    echo "install.sh: status    -> systemctl status loombre-server loombre-web loombre-worker"
    echo "install.sh: first boot provisions + migrates the bundled database; give it a few seconds."
  fi
fi

echo "install.sh: done. Loombre ${VERSION} installed at ${PREFIX}."
