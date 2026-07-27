#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Loombre :: installers/linux/uninstall.sh
#
# Reverses install.sh. Default posture: a clean uninstall leaves NO FILES
# OUTSIDE THE DATA DIR — app payload, systemd units, the config dir (env
# file), and the system user are all removed; only DATA_DIR (the library/
# metadata database, scan/transcode caches, and any embedded-PG cluster)
# survives. Pass --purge to also delete the data dir itself (irreversible
# — this is the only thing --purge adds). Flags must match what
# install.sh was run with (--prefix/--data-dir/--config-dir/--user/
# --no-systemd) since this script has no other way to know them.
#
# Usage:
#   sudo ./uninstall.sh [--prefix /opt/loombre] [--data-dir /var/lib/loombre]
#                        [--config-dir /etc/loombre] [--user loombre]
#                        [--no-systemd] [--purge] [--help]

set -euo pipefail

PREFIX="/opt/loombre"
DATA_DIR="/var/lib/loombre"
CONFIG_DIR="/etc/loombre"
LOOMBRE_USER="loombre"
NO_SYSTEMD=0
PURGE=0

usage() {
  cat <<'EOF'
Usage: sudo ./uninstall.sh [options]

Options:
  --prefix DIR       Install location to remove (default: /opt/loombre)
  --data-dir DIR      App-data directory (default: /var/lib/loombre) — the
                       ONLY thing a plain uninstall preserves
  --config-dir DIR    Env-file location (default: /etc/loombre) — removed
                       by a plain uninstall (re-install regenerates a
                       fresh skeleton; if you need to keep a customized
                       env file, back it up first)
  --user NAME          System user to remove (default: loombre)
  --no-systemd         Skip systemd unit removal (matches install.sh's
                        --no-systemd)
  --purge              ALSO delete the data dir — irreversible, deletes
                        the library/metadata database and any embedded-PG
                        cluster. Without --purge, DATA_DIR is the only
                        thing left on disk when this script finishes.
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
    --purge) PURGE=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "uninstall.sh: unrecognized argument: $1" >&2; usage >&2; exit 1 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "uninstall.sh: must run as root (sudo ./uninstall.sh ...)" >&2
  exit 1
fi

echo "uninstall.sh: removing Loombre -> prefix=${PREFIX} purge=$([ "$PURGE" -eq 1 ] && echo yes || echo no)"

# ── systemd units ───────────────────────────────────────────────────────
if [ "${NO_SYSTEMD}" -eq 0 ] && command -v systemctl >/dev/null 2>&1; then
  systemctl stop loombre-server.service loombre-worker.service 2>/dev/null || true
  systemctl disable loombre-server.service loombre-worker.service 2>/dev/null || true
  rm -f /etc/systemd/system/loombre-server.service /etc/systemd/system/loombre-worker.service
  systemctl daemon-reload
  echo "uninstall.sh: systemd units stopped, disabled, removed"
fi

# ── PATH shim: /usr/local/bin/loombre (L2) ──────────────────────────────
#    Removed ONLY if it is a symlink whose resolved target lives under
#    PREFIX (B-4) — a foreign file, or a symlink pointing somewhere else
#    entirely (e.g. a different Loombre install at a different --prefix,
#    or an unrelated program that happens to be named `loombre`), is left
#    alone. readlink -f resolves both sides to absolute, symlink-free
#    paths before comparing, with a trailing-slash guard so a sibling
#    directory with PREFIX as a strict string prefix (e.g.
#    /opt/loombre-evil when PREFIX=/opt/loombre) can never false-match.
SHIM_PATH="/usr/local/bin/loombre"
if [ -L "${SHIM_PATH}" ]; then
  RESOLVED_PREFIX="$(readlink -f "${PREFIX}" 2>/dev/null || true)"
  RESOLVED_SHIM_TARGET="$(readlink -f "${SHIM_PATH}" 2>/dev/null || true)"
  if [ -n "${RESOLVED_PREFIX}" ] && [ -n "${RESOLVED_SHIM_TARGET}" ] \
     && { [ "${RESOLVED_SHIM_TARGET}" = "${RESOLVED_PREFIX}" ] || case "${RESOLVED_SHIM_TARGET}" in "${RESOLVED_PREFIX}"/*) true ;; *) false ;; esac; }; then
    rm -f "${SHIM_PATH}"
    echo "uninstall.sh: removed PATH shim ${SHIM_PATH} (pointed into ${PREFIX})"
  else
    echo "uninstall.sh: ${SHIM_PATH} is a symlink but does NOT resolve under ${PREFIX} — leaving it alone (foreign install or unrelated program)."
  fi
elif [ -e "${SHIM_PATH}" ]; then
  echo "uninstall.sh: ${SHIM_PATH} exists but is not a symlink — leaving it alone (never installed by this script)."
fi

# ── app payload ──────────────────────────────────────────────────────────
if [ -d "${PREFIX}" ]; then
  rm -rf "${PREFIX:?}"
  echo "uninstall.sh: removed ${PREFIX}"
fi

# ── config dir: always removed (env file, not data — see --purge note ──
#    in usage()). ─────────────────────────────────────────────────────────
if [ -d "${CONFIG_DIR}" ]; then
  rm -rf "${CONFIG_DIR:?}"
  echo "uninstall.sh: removed config dir ${CONFIG_DIR}"
fi

# ── system user: always removed ─────────────────────────────────────────
if id "${LOOMBRE_USER}" >/dev/null 2>&1; then
  if command -v userdel >/dev/null 2>&1; then
    userdel "${LOOMBRE_USER}" 2>/dev/null || true
  elif command -v deluser >/dev/null 2>&1; then
    deluser "${LOOMBRE_USER}" 2>/dev/null || true
  fi
  echo "uninstall.sh: removed system user ${LOOMBRE_USER}"
fi

# ── data dir: the ONE thing preserved unless --purge ────────────────────
if [ "${PURGE}" -eq 1 ]; then
  if [ -d "${DATA_DIR}" ]; then
    rm -rf "${DATA_DIR:?}"
    echo "uninstall.sh: --purge — removed data dir ${DATA_DIR}"
  fi
  echo "uninstall.sh: purge complete — no Loombre files remain anywhere."
else
  echo "uninstall.sh: data dir (${DATA_DIR}) preserved — re-install and point --data-dir at it to reuse, or re-run with --purge to delete it."
fi

echo "uninstall.sh: done."
