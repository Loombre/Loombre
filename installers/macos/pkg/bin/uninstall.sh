#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Loombre :: /opt/loombre/current/bin/uninstall.sh
#
# macOS has no built-in `.pkg` uninstaller (Apple's own long-standing
# limitation, not a Loombre omission — see docs/install/macos.md). This
# script is the ship-side answer: it reverses everything
# pkg/scripts/postinstall lays down, and mirrors installers/linux/
# uninstall.sh's UX (flag names, --purge semantics, idempotent/partial-
# state-tolerant removal) as closely as the two platforms' actual
# uninstall primitives allow.
#
# SHIPPED PATH: this file ships INSIDE the pkg payload, staged by
# build-pkg.mjs's assemblePayload() into the same versioned bin/ directory
# as loombre-server/loombre-worker/loombre-web
# (/opt/loombre/<version>/bin/uninstall.sh), reachable at the STABLE,
# upgrade-proof path below via the `current` symlink (LAYOUT.md §1):
#
#   sudo /opt/loombre/current/bin/uninstall.sh [options]
#
# (The lane brief suggested a flat /opt/loombre/bin/ — this repo's actual
# payload has no such flat directory; everything ships versioned under
# /opt/loombre/<version>/bin/ with `current` as the stable symlink, so
# THIS is the location that is actually "consistent with how the payload
# is laid out by build-pkg.mjs", matching every other shim.)
#
# IDEMPOTENT / PARTIAL-STATE TOLERANT (a real audit finding): a partial
# manual uninstall can leave any subset of {daemons loaded, plists on
# disk, /opt/loombre present, the app present, the account present} — this
# script must clean up whatever subset actually exists without dying
# partway through on an already-absent item. Every fallible step below is
# individually guarded (existence check first, or `|| true`/a printed
# WARNING) — this script deliberately does NOT `set -e` globally, for
# exactly that reason (contrast pkg/scripts/postinstall, which CAN afford
# `set -e` because installer time is a single all-or-nothing transaction;
# an uninstall run against unknown, possibly-already-partial state is not).
#
# SELF-REMOVAL SAFETY: this script's own file lives inside /opt/loombre,
# which it removes as one of its own steps. That is safe by construction —
# once the interpreter has opened this file (which happens before the
# first byte of script runs), the open file descriptor keeps referencing
# the same inode/data even after `rm -rf /opt/loombre` unlinks it from the
# directory tree (ordinary POSIX unlink semantics: removing a directory
# entry does not invalidate an already-open descriptor to the file it
# pointed at). To keep this guarantee trivially true regardless of shell
# implementation details, the /opt/loombre removal step is deliberately
# ordered LAST among steps that touch real filesystem state, with nothing
# after it but the `pkgutil --forget` receipt bookkeeping call (a registry
# delete, not a read of this file's own bytes — see the note at that step
# for why it runs this late) and a plain final `echo`.
#
# Usage:
#   sudo /opt/loombre/current/bin/uninstall.sh [options]
#
# Options:
#   --purge                  Also remove app data ("/Library/Application
#                             Support/Loombre" — DB, secrets, config).
#                             Mirrors installers/linux/uninstall.sh's
#                             --purge exactly: without it, app data is the
#                             ONE thing left on disk when this finishes.
#   --dry-run                Print every action this run would take
#                             without changing anything (no root required;
#                             safe to run as any user to preview).
#   --adminUser NAME          Non-interactive service-account deletion (see
#   --adminPassword PASS      the macOS 26 note below): passed straight
#                             through to `sysadminctl -deleteUser` as
#                             `-adminUser`/`-adminPassword`. Without both,
#                             deletion falls back to the interactive GUI
#                             admin-authorization prompt. CAUTION: argv is
#                             visible to other users via `ps`/the process
#                             table and lands in shell history — prefer the
#                             interactive prompt (omit both flags) on any
#                             multi-user machine.
#   --help                    Show this help.
#
# macOS 26 NOTE — why the service-account removal below runs
# `sysadminctl -deleteUser _loombre interactive` instead of the more
# obvious `dscl . -delete /Users/_loombre` (or a plain root
# `sysadminctl -deleteUser _loombre`, no `interactive`): on macOS 26, BOTH
# of those fail with eDSPermissionError (-14120), even run as root — the
# real audit finding this script exists to work around. Only
# `sysadminctl -deleteUser _loombre interactive` (which opens a GUI
# admin-authorization prompt) succeeds. `--adminUser`/`--adminPassword`
# above cover fully unattended/scripted use instead of that GUI prompt.
# Separately: `-keepHome` no longer exists as a `sysadminctl` flag on
# macOS 26, and the tool refuses to delete `/var/empty` regardless
# ("_loombre's home (/var/empty) WILL NOT BE DELETED!") — harmless, since
# `/var/empty` is a shared system path Loombre never wrote real data into,
# not a Loombre-owned directory; this script says so in its own output
# rather than treating that refusal as an error.

DRY_RUN=0
PURGE=0
ADMIN_USER=""
ADMIN_PASSWORD=""

usage() {
  cat <<'EOF'
Usage: sudo /opt/loombre/current/bin/uninstall.sh [options]

Options:
  --purge                 Also remove app data ("/Library/Application
                           Support/Loombre" — DB, secrets, config).
                           Without it, app data is the ONE thing left on
                           disk when this script finishes.
  --dry-run                Print planned actions without changing anything
                            (no root required).
  --adminUser NAME          Scripted (non-interactive) _loombre account
  --adminPassword PASS      deletion — passed through to
                            `sysadminctl -deleteUser -adminUser -adminPassword`.
                            Without both, falls back to the interactive
                            GUI admin-authorization prompt
                            (`sysadminctl -deleteUser _loombre interactive`).
                            CAUTION: argv is visible via `ps` and shell
                            history — prefer the interactive prompt on
                            multi-user machines.
  --help                   Show this help.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --purge) PURGE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --adminUser)
      # Guard BEFORE the assignment: if this flag is the LAST argv element,
      # $2 is unset and `shift 2` fails without shifting anything — with no
      # guard the `while [ $# -gt 0 ]` loop below never makes progress and
      # spins forever at 100% CPU (this runs as root; empirically verified
      # in both sh and bash). Fail loudly and immediately instead.
      [ $# -ge 2 ] || { echo "uninstall.sh: --adminUser requires a value" >&2; exit 1; }
      ADMIN_USER="$2"; shift 2 ;;
    --adminPassword)
      [ $# -ge 2 ] || { echo "uninstall.sh: --adminPassword requires a value" >&2; exit 1; }
      ADMIN_PASSWORD="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "uninstall.sh: unrecognized argument: $1" >&2; usage >&2; exit 1 ;;
  esac
done

if [ "$DRY_RUN" -eq 0 ] && [ "$(id -u)" -ne 0 ]; then
  echo "uninstall.sh: must run as root (sudo /opt/loombre/current/bin/uninstall.sh ...), or pass --dry-run to preview without root" >&2
  exit 1
fi

echo "uninstall.sh: removing Loombre (dry-run=$([ "$DRY_RUN" -eq 1 ] && echo yes || echo no), purge=$([ "$PURGE" -eq 1 ] && echo yes || echo no))"

# The four launchd labels the installer creates — three LaunchDaemons
# (system domain) plus the menubar LaunchAgent (the logged-in console
# user's gui/<uid> domain). Kept as the SAME plain `for LABEL in ...` shape
# preinstall/postinstall already use, not an array — this file is `/bin/sh`,
# matching every other script in pkg/scripts and pkg/bin (see their own
# headers) for one interpreter across the whole payload.
DAEMON_LABELS="system/com.loombre.server system/com.loombre.worker system/com.loombre.web"

# "com.loombre.pkg" is the REAL identifier pkgbuild registers this
# component under (build-pkg.mjs's `pkgbuild --identifier com.loombre.pkg`
# — see LAYOUT.md §6). Declared up here (not just at the receipt-forget
# step near the end) because the stray-bundle check below also needs to
# read this same receipt WHILE it still exists.
RECEIPT_ID="com.loombre.pkg"

echo "uninstall.sh: --- launchd: booting out system daemons ---"
for LABEL in $DAEMON_LABELS; do
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "uninstall.sh: [dry-run] would run: launchctl bootout $LABEL (if loaded)"
    continue
  fi
  if launchctl print "$LABEL" >/dev/null 2>&1; then
    echo "uninstall.sh: stopping $LABEL"
    launchctl bootout "$LABEL" 2>/dev/null || echo "uninstall.sh: WARNING — bootout failed for $LABEL (continuing)" >&2
  else
    echo "uninstall.sh: $LABEL not loaded — nothing to stop"
  fi
done

# The menubar agent lives in the CONSOLE user's GUI domain, not the system
# domain — same detection preinstall/postinstall already use. Best-effort:
# no console user (installing/uninstalling over SSH, or sitting at the
# login window) just means there is no live GUI session holding it.
CONSOLE_UID="$(stat -f %u /dev/console 2>/dev/null || echo 0)"
# `stat -f %u` is BSD/macOS stat syntax. On GNU stat (seen on the Linux CI
# leg that runs this script's --dry-run behavior), `-f` means
# `--file-system` instead, and the output can be a multi-line filesystem-
# info block rather than a bare uid — trusting it unvalidated makes the
# `[ "$CONSOLE_UID" -eq 0 ]` test below error out (non-numeric operand) and
# fall through to the wrong branch. Coerce anything that isn't purely
# digits back to 0 (the same "no console user" value the `|| echo 0`
# fallback above already uses).
case "$CONSOLE_UID" in
  ''|*[!0-9]*) CONSOLE_UID=0 ;;
esac
MENUBAR_LABEL="gui/${CONSOLE_UID}/com.loombre.menubar"
echo "uninstall.sh: --- launchd: booting out the menubar agent (console uid ${CONSOLE_UID}) ---"
if [ "${CONSOLE_UID:-0}" -eq 0 ]; then
  echo "uninstall.sh: no console user — the menubar agent (if loaded for some other session) is left as-is; it will not be re-added since its plist is about to be removed"
elif [ "$DRY_RUN" -eq 1 ]; then
  echo "uninstall.sh: [dry-run] would run: launchctl bootout $MENUBAR_LABEL (if loaded)"
else
  if launchctl print "$MENUBAR_LABEL" >/dev/null 2>&1; then
    echo "uninstall.sh: stopping $MENUBAR_LABEL"
    launchctl bootout "$MENUBAR_LABEL" 2>/dev/null || echo "uninstall.sh: WARNING — bootout failed for $MENUBAR_LABEL (continuing)" >&2
  else
    echo "uninstall.sh: $MENUBAR_LABEL not loaded — nothing to stop"
  fi
fi

# ── plists ───────────────────────────────────────────────────────────────
DAEMON_PLISTS="/Library/LaunchDaemons/com.loombre.server.plist /Library/LaunchDaemons/com.loombre.worker.plist /Library/LaunchDaemons/com.loombre.web.plist"
AGENT_PLIST="/Library/LaunchAgents/com.loombre.menubar.plist"
echo "uninstall.sh: --- removing plists ---"
for PLIST in $DAEMON_PLISTS $AGENT_PLIST; do
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "uninstall.sh: [dry-run] would run: rm -f \"$PLIST\""
    continue
  fi
  if [ -f "$PLIST" ]; then
    rm -f "$PLIST"
    echo "uninstall.sh: removed $PLIST"
  else
    echo "uninstall.sh: $PLIST already absent"
  fi
done

# ── stray/relocated app bundle (via the still-present pkgutil receipt) ──
# rc.6-and-earlier pkgs shipped without pkgbuild's --component-plist (fixed
# in commit 3ce5edca), so PackageKit could relocate Applications/Loombre.app
# to wherever LaunchServices/Spotlight found an EXISTING copy of the bundle
# id on the target volume, instead of installing it at /Applications; a
# plain `installer -pkg ... -target <volume>` run legitimately changes
# where the receipt says the bundle landed too. Ask the receipt — read here
# while it still exists; it is only forgotten at the very end of this
# script — where it actually recorded the bundle, and remove that copy too
# if it differs from the literal /Applications/Loombre.app handled below.
#
# This is a DERIVED rm path in a root script, so it is validated tightly
# before ever being used: must be absolute, must end in "/Loombre.app",
# must not be "/", and must have a real Contents/ subdirectory. Anything
# that fails validation — including "no receipt at all" (this dev/CI
# machine, or a from-scratch/manual install with nothing registered via
# `installer(8)`/`pkgutil`) or a receipt whose volume/install-location
# can't be parsed — is treated the same way: print a note and skip, never
# guess.
STRAY_APP_PATH=""
RECEIPT_VOLUME="$(pkgutil --pkg-info-plist "$RECEIPT_ID" 2>/dev/null | plutil -extract volume raw -o - - 2>/dev/null)"
RECEIPT_LOCATION="$(pkgutil --pkg-info-plist "$RECEIPT_ID" 2>/dev/null | plutil -extract install-location raw -o - - 2>/dev/null)"
if [ -z "$RECEIPT_VOLUME" ] || [ -z "$RECEIPT_LOCATION" ]; then
  echo "uninstall.sh: no pkgutil receipt for $RECEIPT_ID (or its volume/install-location could not be parsed) — skipping relocated-bundle check"
else
  # volume + install-location + the payload-relative bundle path, each
  # segment trimmed of a leading/trailing slash before joining so "//"
  # never appears in the result.
  CANDIDATE_APP_PATH="${RECEIPT_VOLUME%/}/${RECEIPT_LOCATION#/}"
  CANDIDATE_APP_PATH="${CANDIDATE_APP_PATH%/}/Applications/Loombre.app"
  if [ "$CANDIDATE_APP_PATH" = "/Applications/Loombre.app" ]; then
    echo "uninstall.sh: pkgutil receipt confirms the standard install location — no relocated bundle to remove separately"
  else
    VALID_STRAY=0
    case "$CANDIDATE_APP_PATH" in
      /*) case "$CANDIDATE_APP_PATH" in *"/Loombre.app") VALID_STRAY=1 ;; esac ;;
    esac
    if [ "$VALID_STRAY" -eq 1 ] && [ "$CANDIDATE_APP_PATH" != "/" ] && [ -d "$CANDIDATE_APP_PATH/Contents" ]; then
      STRAY_APP_PATH="$CANDIDATE_APP_PATH"
      echo "uninstall.sh: pkgutil receipt recorded Loombre.app at \"$STRAY_APP_PATH\" (not /Applications) — will remove it too"
    else
      echo "uninstall.sh: pkgutil receipt's derived app path \"$CANDIDATE_APP_PATH\" failed validation (not an absolute, real app bundle) — skipping"
    fi
  fi
fi

# ── app bundle + logs ────────────────────────────────────────────────────
echo "uninstall.sh: --- removing /Applications/Loombre.app and logs ---"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "uninstall.sh: [dry-run] would run: rm -rf /Applications/Loombre.app"
  if [ -n "$STRAY_APP_PATH" ]; then
    echo "uninstall.sh: [dry-run] would run: rm -rf \"$STRAY_APP_PATH\" (relocated bundle recorded by the pkgutil receipt)"
  fi
  echo "uninstall.sh: [dry-run] would run: rm -rf \"/Library/Logs/Loombre\""
else
  if [ -d "/Applications/Loombre.app" ]; then
    rm -rf "/Applications/Loombre.app"
    echo "uninstall.sh: removed /Applications/Loombre.app"
  else
    echo "uninstall.sh: /Applications/Loombre.app already absent"
  fi
  if [ -n "$STRAY_APP_PATH" ]; then
    rm -rf "$STRAY_APP_PATH"
    echo "uninstall.sh: removed relocated bundle at \"$STRAY_APP_PATH\" (recorded by the pkgutil receipt)"
  fi
  if [ -d "/Library/Logs/Loombre" ]; then
    rm -rf "/Library/Logs/Loombre"
    echo "uninstall.sh: removed \"/Library/Logs/Loombre\""
  else
    echo "uninstall.sh: \"/Library/Logs/Loombre\" already absent"
  fi
fi

# ── app data (the ONE thing preserved unless --purge) ───────────────────
APP_SUPPORT="/Library/Application Support/Loombre"
echo "uninstall.sh: --- app data ---"
if [ "$PURGE" -eq 1 ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "uninstall.sh: [dry-run] would run: rm -rf \"$APP_SUPPORT\" (--purge)"
  elif [ -d "$APP_SUPPORT" ]; then
    rm -rf "$APP_SUPPORT"
    echo "uninstall.sh: --purge — removed \"$APP_SUPPORT\""
  else
    echo "uninstall.sh: --purge — \"$APP_SUPPORT\" already absent"
  fi
else
  echo "uninstall.sh: app data preserved at \"$APP_SUPPORT\" (DB, config, secrets) — pass --purge to also remove it"
fi

# ── _loombre service account + group ─────────────────────────────────────
echo "uninstall.sh: --- _loombre service account ---"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "uninstall.sh: [dry-run] NOTE — on macOS 26, 'dscl . -delete' and a plain root 'sysadminctl -deleteUser' both fail with eDSPermissionError (-14120); this script uses 'sysadminctl -deleteUser _loombre interactive' (GUI admin prompt) instead, or the scripted form below when --adminUser/--adminPassword are both given."
  if [ -n "$ADMIN_USER" ] && [ -n "$ADMIN_PASSWORD" ]; then
    echo "uninstall.sh: [dry-run] would run: sysadminctl -deleteUser _loombre -adminUser $ADMIN_USER -adminPassword ****** (if the account exists)"
  else
    echo "uninstall.sh: [dry-run] would run: sysadminctl -deleteUser _loombre interactive (if the account exists)"
  fi
  echo "uninstall.sh: [dry-run] would run: dscl . -delete /Groups/_loombre (best-effort)"
  echo "uninstall.sh: [dry-run] NOTE — '-keepHome' no longer exists on macOS 26, and sysadminctl refuses to delete /var/empty regardless (\"_loombre's home (/var/empty) WILL NOT BE DELETED!\") — harmless, not real Loombre data."
elif ! dscl . -read /Users/_loombre >/dev/null 2>&1; then
  echo "uninstall.sh: _loombre account already absent — nothing to delete"
else
  echo "uninstall.sh: deleting the _loombre service account"
  echo "uninstall.sh: NOTE — on macOS 26, 'dscl . -delete' and a plain root 'sysadminctl -deleteUser' both fail with eDSPermissionError (-14120); using 'sysadminctl -deleteUser' with 'interactive' (or --adminUser/--adminPassword) instead."
  if [ -n "$ADMIN_USER" ] && [ -n "$ADMIN_PASSWORD" ]; then
    sysadminctl -deleteUser _loombre -adminUser "$ADMIN_USER" -adminPassword "$ADMIN_PASSWORD" || \
      echo "uninstall.sh: WARNING — scripted sysadminctl -deleteUser failed; _loombre account may still exist. Re-run without --adminUser/--adminPassword for the interactive GUI prompt, or remove it via System Settings > Users & Groups." >&2
  else
    sysadminctl -deleteUser _loombre interactive || \
      echo "uninstall.sh: WARNING — sysadminctl -deleteUser interactive failed or was cancelled; _loombre account may still exist. Re-run this script, or remove it via System Settings > Users & Groups." >&2
  fi
  echo "uninstall.sh: NOTE — '-keepHome' no longer exists on macOS 26, and sysadminctl refuses to delete /var/empty regardless (\"_loombre's home (/var/empty) WILL NOT BE DELETED!\") — harmless, not real Loombre data."
  # Best-effort primary-group cleanup: may hit the identical macOS 26
  # permission wall as above; never fatal either way.
  if dscl . -read /Groups/_loombre >/dev/null 2>&1; then
    dscl . -delete /Groups/_loombre >/dev/null 2>&1 && echo "uninstall.sh: removed /Groups/_loombre" || \
      echo "uninstall.sh: NOTE — could not remove /Groups/_loombre (likely the same permission restriction noted above) — harmless; remove manually via System Settings > Users & Groups if desired." >&2
  fi
fi

# ── /opt/loombre — LAST filesystem-affecting step; see the SELF-REMOVAL
#    SAFETY note at the top of this file for why ordering this last matters.
echo "uninstall.sh: --- removing /opt/loombre ---"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "uninstall.sh: [dry-run] would run: rm -rf /opt/loombre"
elif [ -d "/opt/loombre" ]; then
  rm -rf "/opt/loombre"
  echo "uninstall.sh: removed /opt/loombre"
else
  echo "uninstall.sh: /opt/loombre already absent"
fi

# ── pkgutil receipt — forgotten LAST, deliberately ───────────────────────
# Forgetting the receipt lets a future `installer -pkg` (or the Homebrew
# cask, which wraps the same .pkg) treat a from-scratch install as fresh
# rather than a phantom "upgrade" of files that no longer exist — but doing
# that FIRST (as this script originally did) throws away the one thing that
# can still enumerate/locate this install's files if the run is abandoned
# partway through (the interactive `sysadminctl` GUI prompt above is a
# natural abandon point: an operator who walks away, or clicks Cancel,
# leaves everything after that point undone). Forgetting the receipt is
# pure bookkeeping — nothing downstream of it depends on the receipt still
# being registered — so it is safe, and strictly better, to do it last,
# after every real removal (including the receipt-driven stray-bundle
# check above) has already happened.
echo "uninstall.sh: --- pkgutil receipt ---"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "uninstall.sh: [dry-run] would run: pkgutil --forget $RECEIPT_ID (if registered)"
elif pkgutil --pkg-info "$RECEIPT_ID" >/dev/null 2>&1; then
  echo "uninstall.sh: forgetting pkgutil receipt $RECEIPT_ID"
  pkgutil --forget "$RECEIPT_ID" 2>/dev/null || echo "uninstall.sh: WARNING — pkgutil --forget failed for $RECEIPT_ID (continuing)" >&2
else
  echo "uninstall.sh: no pkgutil receipt for $RECEIPT_ID (never installed via installer(8)/pkgutil, or already forgotten) — nothing to forget"
fi

echo "uninstall.sh: done."
