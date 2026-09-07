// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/linux/tray/internal/systemd/systemd.go
//
// Unit names, orderings, and the systemctl command lines for whole-stack
// lifecycle operations — pure data plus the parser for what `systemctl
// show` prints back, so all of it is testable on any host. The exec half
// lives in exec_linux.go.
//
// Mirrors the other two controllers' equivalents (the Windows tray's
// ServiceStack.cs, the macOS menubar's LaunchdFallback) and encodes the
// same policy: start server-FIRST because it hosts the embedded
// PostgreSQL, stop consumers-first with the server LAST so nothing spends
// its shutdown window flailing against a database that died before it did.
//
// WHY systemctl AND NOT THE IPC CONTRACT: transport.ts's
// IPC_SERVER_START_SEMANTICS names systemd as the sanctioned way to start
// a stopped Loombre server on Linux — the IPC start endpoint is served by
// the server process itself and can never start it.

package systemd

import (
	"strings"
)

// Unit names, in lockstep with installers/linux/systemd's three templates.
const (
	ServerUnit = "loombre-server.service"
	WorkerUnit = "loombre-worker.service"
	WebUnit    = "loombre-web.service"
)

// StartOrder starts the server first: the worker and web units declare
// After= on it, but After= only orders starts systemd itself initiates —
// it never pulls in a stopped unit — so a full-stack start names all three.
var StartOrder = []string{ServerUnit, WorkerUnit, WebUnit}

// StopOrder stops consumers first and the PostgreSQL-hosting server last.
var StopOrder = []string{WorkerUnit, WebUnit, ServerUnit}

// State is the small projection of ActiveState this tray's decision table
// distinguishes — deliberately coarser than systemd's own vocabulary.
type State int

const (
	StateUnknown State = iota
	StateStopped
	StateRunning
	StateStartPending
	StateStopPending
)

func (s State) String() string {
	switch s {
	case StateStopped:
		return "stopped"
	case StateRunning:
		return "running"
	case StateStartPending:
		return "start-pending"
	case StateStopPending:
		return "stop-pending"
	default:
		return "unknown"
	}
}

// Snapshot is what one `systemctl show` call learned about the server
// unit. UnitExists=false means systemd answered but there is no such unit
// (a dev run, or a tarball install that never enabled the units); a nil
// *Snapshot at a call site means the systemctl call itself failed.
type Snapshot struct {
	UnitExists  bool
	LoadState   string
	ActiveState string
}

// State projects ActiveState onto the decision table's vocabulary.
func (s Snapshot) State() State {
	switch s.ActiveState {
	case "active":
		return StateRunning
	case "activating", "reloading":
		return StateStartPending
	case "deactivating":
		return StateStopPending
	case "inactive", "failed":
		// `failed` belongs with `stopped`: the unit is not running and the
		// fix is the same — start it. Refusing to offer Start after a
		// crash-loop would gray out the one action that helps.
		return StateStopped
	default:
		return StateUnknown
	}
}

// ShowArgs is the query: `systemctl show -p LoadState -p ActiveState <unit>`.
// `show` exits 0 even for a unit that does not exist (it prints
// LoadState=not-found), so a non-zero exit really does mean systemd itself
// could not be reached.
func ShowArgs(unit string) []string {
	return []string{"show", "-p", "LoadState", "-p", "ActiveState", unit}
}

// ParseShow reads the Key=Value lines `systemctl show` prints. Unknown
// keys are ignored so adding a -p property later cannot break this.
func ParseShow(out string) Snapshot {
	var snap Snapshot
	for _, line := range strings.Split(out, "\n") {
		key, value, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok {
			continue
		}
		switch key {
		case "LoadState":
			snap.LoadState = value
		case "ActiveState":
			snap.ActiveState = value
		}
	}
	// Only `not-found` means "no such unit". `masked`, `error` and
	// `bad-setting` describe a unit that EXISTS but is unusable, so they
	// stay UnitExists=true: the menu offers Start, systemctl reports the
	// real reason, and the notification carries it. Reporting them as
	// absent would gray the item out with no explanation anywhere.
	snap.UnitExists = snap.LoadState != "" && snap.LoadState != "not-found"
	return snap
}

// StartArgs starts the whole stack in dependency order.
func StartArgs() []string {
	return append([]string{"start"}, StartOrder...)
}

// StopArgs stops the whole stack in reverse dependency order.
func StopArgs() []string {
	return append([]string{"stop"}, StopOrder...)
}

// ManualStartCommand is what a notification tells the user to run when the
// tray's own attempt failed — the same units, spelled the way a person
// would type them.
func ManualStartCommand() string {
	return "sudo systemctl start " + strings.Join(shortNames(StartOrder), " ")
}

// ManualStopCommand is ManualStartCommand's counterpart for shutdown.
func ManualStopCommand() string {
	return "sudo systemctl stop " + strings.Join(shortNames(StopOrder), " ")
}

func shortNames(units []string) []string {
	out := make([]string, len(units))
	for i, unit := range units {
		out[i] = strings.TrimSuffix(unit, ".service")
	}
	return out
}

// IsAuthCancellation reports whether systemctl failed because the user
// dismissed the polkit prompt (or no polkit agent answered), rather than
// because anything is actually broken. Declining an authentication prompt
// is a decision, not an error, so the tray says so quietly instead of
// raising a failure notification.
func IsAuthCancellation(stderr string) bool {
	lowered := strings.ToLower(stderr)
	for _, marker := range []string{
		"interactive authentication required",
		"authentication is required",
		"cancelled",
		"canceled",
	} {
		if strings.Contains(lowered, marker) {
			return true
		}
	}
	return false
}

// Tail trims a command's stderr down to something that fits in a desktop
// notification, keeping the END (where the actual failure is reported).
func Tail(stderr string, maxLen int) string {
	trimmed := strings.TrimSpace(stderr)
	if trimmed == "" {
		return ""
	}
	// Collapse to single lines: notify-send renders embedded newlines
	// inconsistently across servers, and the last line is the useful one.
	lines := strings.Split(trimmed, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if line := strings.TrimSpace(lines[i]); line != "" {
			trimmed = line
			break
		}
	}
	if maxLen > 0 && len(trimmed) > maxLen {
		return trimmed[len(trimmed)-maxLen:]
	}
	return trimmed
}
