#!/bin/sh
# Loombre :: installers/macos/pkg/scripts/pick-service-uid.sh
#
# Selects a free macOS "service account" UID for `_loombre`: strictly BELOW
# 500 (macOS's own boundary — UID 500 is the first HUMAN account uid) and
# strictly ABOVE 200 (below which sit Apple's own reserved system
# accounts). Sourced/invoked by pkg/scripts/postinstall; split out into its
# own file so it has a testable seam (see pkg/pick-service-uid.test.mjs) —
# postinstall itself has no test harness of its own, and this repo's
# installer tests are Node-over-real-scripts (component-plist.test.mjs,
# distribution-xml.test.mjs), not a shell test framework.
#
# THE REAL BUG this fixes (rc.6 field audit — _loombre installed at UID
# 500, macOS's first HUMAN account uid, so `_loombre` silently became a
# regular, loginable-looking account instead of a hidden service one). The
# original one-liner:
#
#   dscl . -list /Users UniqueID | awk '{print $2}' \
#     | awk '$1<500 && $1>200 {print}' | sort -n | tail -1
#   NEXT_UID=${NEXT_UID:-200}
#   NEXT_UID=$((NEXT_UID + 1))
#
# filtered CANDIDATES to the service range, then took the HIGHEST already-
# used candidate and added 1 — but never re-checked that the +1 RESULT was
# still under 500. If the highest already-used candidate in range happened
# to be 499 (or macOS shipped enough hidden accounts to reach it), the
# result was exactly 500 — past the guard, because the guard only ran on
# the *inputs*, never on the *output*.
#
# This version scans ascending for the first UID in [201, 499] NOT already
# in use, so the result is a member of the allowed range by construction —
# no separate bounds check on the output can ever be forgotten again. If
# the entire 201-499 range (299 possible UIDs) is somehow already taken, it
# fails loudly (nonzero exit, nothing on stdout) rather than silently
# wrapping into the human-UID range — the caller (postinstall) must treat
# that as a fatal install error, not fall back to a bad UID.
#
# TWO NAMESPACES, ONE NUMBER (a second real audit finding, found alongside
# the one above): postinstall assigns the value THIS script picks as BOTH
# `_loombre`'s UniqueID (a /Users id) AND its PrimaryGroupID (a /Groups
# id) — the standard macOS "hidden service account" shape. This script is
# the one place that decides that single free number, but it only ever
# sees whatever its caller pipes in on stdin; it does no dscl querying of
# its own. If the caller fed it ONLY `/Users UniqueID`, a uid that is free
# among users but already taken as a GID in `/Groups PrimaryGroupID` would
# get picked anyway, and postinstall would then hand out a duplicate GID.
# The caller (postinstall) MUST pipe in the MERGED output of both `dscl
# . -list /Users UniqueID` and `dscl . -list /Groups PrimaryGroupID` — see
# postinstall's own call site. This script's matching logic needs no
# change to support that: `is_used()` below is a plain whole-line lookup
# against whatever it's given, with no notion of which namespace a used id
# came from, so a merged, unlabeled union of both lists works unchanged.
#
# Input:  one existing id per line on stdin, UNFILTERED (this script does
#         its own range filtering) — the caller pipes the MERGED, raw
#         `dscl . -list /Users UniqueID | awk '{print $2}'` AND
#         `dscl . -list /Groups PrimaryGroupID | awk '{print $2}'` output
#         (see postinstall's call site for the exact merge).
# Output: the chosen UID on stdout (nothing else), exit 0.
# Failure: nothing on stdout, an explanation on stderr, exit 1.
#
# Usage:
#   { dscl . -list /Users UniqueID; dscl . -list /Groups PrimaryGroupID; } \
#     | awk '{print $2}' | ./pick-service-uid.sh
set -eu

MIN_UID=201
MAX_UID=499

USED_LIST="$(cat -)"

is_used() {
  # Exact whole-line match against the (unfiltered) used-UID list — never a
  # substring match, so e.g. candidate "20" cannot false-match an existing
  # "201".
  printf '%s\n' "$USED_LIST" | grep -qx "$1"
}

CANDIDATE=$MIN_UID
while [ "$CANDIDATE" -le "$MAX_UID" ]; do
  if ! is_used "$CANDIDATE"; then
    echo "$CANDIDATE"
    exit 0
  fi
  CANDIDATE=$((CANDIDATE + 1))
done

echo "pick-service-uid.sh: FATAL — no free service UID in ${MIN_UID}-${MAX_UID} (the entire macOS service-UID range is already in use) — refusing to allocate a UID >= 500 (macOS's first human-account uid, the exact rc.6 bug this script exists to prevent)." >&2
exit 1
