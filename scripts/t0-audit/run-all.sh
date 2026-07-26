#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Loombre :: scripts/t0-audit/run-all.sh
#
# Turnkey orchestrator for the Phase 4 Wave 3 / deliverable H physical T0
# audit: runs every scripts/t0-audit/*.mjs step in order, fails fast on the
# first hard problem (fix it, re-run — each step's own script is also
# runnable standalone if you only need to redo one measurement), and ends by
# stamping reports/t0-audit.md via collect-report.mjs.
#
# This is a CONVENIENCE wrapper, not a new code path — every step below is
# exactly the command docs/ops/t0-audit-runbook.md documents on its own;
# read that file first if any of this is unclear. Skips (not failures) are
# printed for steps this script cannot decide safely on your behalf (the
# headline dual-transcode item selection, the web-budget/Lighthouse pair,
# which run from a checkout rather than the packaged install).
#
# N100-ONLY end to end (systemd, real ffmpeg, real /dev/dri, real embedded
# PG). shellcheck-clean; not otherwise runnable off the real hardware.
#
# Usage (run as root — every step needs systemctl/ps access to the loombre
# service user's processes):
#   sudo ./run-all.sh --repo-checkout /home/owner/loombre-src \
#                      --hdd-tmp-dir /mnt/media-hdd/loombre-perf-tmp \
#                      [--library-name "My Library"] \
#                      [--duration-min 30] [--results-dir ./t0-audit-results]
#
# Every long option is forwarded verbatim to the underlying node script that
# understands it; unset ones fall back to that script's own default (see
# each script's header).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"

REPO_CHECKOUT=""
HDD_TMP_DIR=""
LIBRARY_NAME=""
DURATION_MIN="30"
RESULTS_DIR="${SCRIPT_DIR}/../../t0-audit-results"
DATABASE_URL_OVERRIDE=""
LIGHTHOUSE_SCORE=""
WEB_BUDGET_JSON=""

usage() {
  cat <<'EOF'
Usage: sudo ./run-all.sh --repo-checkout DIR --hdd-tmp-dir DIR [options]

Required:
  --repo-checkout DIR   Full Loombre source checkout on this N100 (pnpm
                         install already run) — used for `pnpm perf:t0` /
                         `pnpm perf:web-budget` / `pnpm perf:lighthouse`.
  --hdd-tmp-dir DIR      A real, HDD-backed directory (verify with
                         `findmnt DIR` yourself) for the scanThroughput
                         sub-measurement's synthetic library.

Optional:
  --library-name NAME    Restrict dual-transcode's auto-pick to one library.
  --duration-min N        Sustained-monitor window (default 30).
  --results-dir DIR       Where every step's JSON artifact + this report's
                           final copy live (default ./t0-audit-results).
  --database-url URL      Pre-resolved embedded-PG DATABASE_URL (skips the
                           secret-file auto-resolution both run-perf-t0.mjs
                           and sustained-monitor.mjs otherwise do).
  --lighthouse-score N    Hand-read from `pnpm perf:lighthouse`'s own
                           console output (see step 7 below) — passed to
                           collect-report.mjs.
  --web-budget-json PATH  Explicit path to a copied perf/web-budget-result.json
                           (default: looked for inside --results-dir).
  --help                  Show this help.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --repo-checkout) REPO_CHECKOUT="$2"; shift 2 ;;
    --hdd-tmp-dir) HDD_TMP_DIR="$2"; shift 2 ;;
    --library-name) LIBRARY_NAME="$2"; shift 2 ;;
    --duration-min) DURATION_MIN="$2"; shift 2 ;;
    --results-dir) RESULTS_DIR="$2"; shift 2 ;;
    --database-url) DATABASE_URL_OVERRIDE="$2"; shift 2 ;;
    --lighthouse-score) LIGHTHOUSE_SCORE="$2"; shift 2 ;;
    --web-budget-json) WEB_BUDGET_JSON="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "run-all.sh: unrecognized argument: $1" >&2; usage >&2; exit 1 ;;
  esac
done

if [ -z "${REPO_CHECKOUT}" ] || [ -z "${HDD_TMP_DIR}" ]; then
  echo "run-all.sh: --repo-checkout and --hdd-tmp-dir are required" >&2
  usage >&2
  exit 1
fi

mkdir -p "${RESULTS_DIR}"
RESULTS_DIR="$(cd "${RESULTS_DIR}" >/dev/null 2>&1 && pwd)"
echo "run-all.sh: results dir: ${RESULTS_DIR}"

DB_URL_ARGS=()
if [ -n "${DATABASE_URL_OVERRIDE}" ]; then
  DB_URL_ARGS=(--database-url "${DATABASE_URL_OVERRIDE}")
fi

step() {
  echo ""
  echo "=== run-all.sh: $1 ==="
}

step "0/7 preflight"
node "${SCRIPT_DIR}/preflight.mjs" --results-dir "${RESULTS_DIR}"

step "1/7 idle RSS (server + worker + embedded PG)"
node "${SCRIPT_DIR}/rss-sample.mjs" --label idle --results-dir "${RESULTS_DIR}"

step "2/7 cold start (steady-state)"
node "${SCRIPT_DIR}/cold-start.mjs" --runs 3 --results-dir "${RESULTS_DIR}"

step "3/7 perf-t0 (p95 hot paths @ 50k + scan throughput on HDD)"
node "${SCRIPT_DIR}/run-perf-t0.mjs" \
  --repo-checkout "${REPO_CHECKOUT}" \
  --hdd-tmp-dir "${HDD_TMP_DIR}" \
  --results-dir "${RESULTS_DIR}" \
  "${DB_URL_ARGS[@]}"

step "4/7 dual-transcode (start + verify hardware routing)"
DUAL_ARGS=(--results-dir "${RESULTS_DIR}")
if [ -n "${LIBRARY_NAME}" ]; then
  DUAL_ARGS+=(--library-name "${LIBRARY_NAME}")
fi
node "${SCRIPT_DIR}/dual-transcode.mjs" "${DUAL_ARGS[@]}"

step "5/7 sustained-monitor (${DURATION_MIN} minutes — this is the long step)"
node "${SCRIPT_DIR}/sustained-monitor.mjs" \
  --results-dir "${RESULTS_DIR}" \
  --duration-min "${DURATION_MIN}" \
  "${DB_URL_ARGS[@]}"

step "6/7 web budgets — MANUAL (run from ${REPO_CHECKOUT} yourself)"
cat <<EOF
run-all.sh does NOT run these for you (they build/boot a second web server
and, for Lighthouse, print a score this script cannot parse robustly — see
docs/ops/t0-audit-runbook.md Step E). From ${REPO_CHECKOUT}:

  pnpm perf:web-budget
  cp perf/web-budget-result.json "${RESULTS_DIR}/web-budget-result.json"

  pnpm perf:lighthouse
  # read the printed "categories:performance" score, then pass it below.
EOF

step "7/7 collect-report (stamp reports/t0-audit.md)"
COLLECT_ARGS=(--results-dir "${RESULTS_DIR}")
if [ -n "${LIGHTHOUSE_SCORE}" ]; then
  COLLECT_ARGS+=(--lighthouse-score "${LIGHTHOUSE_SCORE}")
fi
if [ -n "${WEB_BUDGET_JSON}" ]; then
  COLLECT_ARGS+=(--web-budget-json "${WEB_BUDGET_JSON}")
fi
node "${SCRIPT_DIR}/collect-report.mjs" "${COLLECT_ARGS[@]}"

echo ""
echo "run-all.sh: done. Review reports/t0-audit.md, fill the FILL: fields by hand, and decide each Verdict."
