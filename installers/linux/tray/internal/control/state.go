// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/linux/tray/internal/control/state.go
//
// Pure derivation of "what should the tray icon and status line say" from
// a /status response (or from the reasons there wasn't one). A direct port
// of the macOS menubar's MenuState.derive — the two encode the same policy
// and should be edited together — plus one state the other platforms do
// not have: NoAccess.
//
// NoAccess exists because Linux is the only platform where a correctly
// installed, perfectly healthy server is routinely invisible to the tray:
// the token file is 0640 owned by an admin group, and a user who is not in
// that group gets EACCES. Collapsing that into "Loombre is not running"
// would send someone to restart a server that never stopped.

package control

import (
	"fmt"

	"loombre.dev/linux-tray/internal/ipc"
)

// InstalledDefaultWebURL is the web UI the packages install (the web unit
// serves :3000). The single shared fallback for every "IPC can't answer,
// open SOMETHING anyway" path, so there is exactly one URL to change if
// that default ever moves — same role as the macOS menubar's
// installedDefaultWebUrl.
const InstalledDefaultWebURL = "http://localhost:3000"

// Kind is the tray's view of the world.
type Kind int

const (
	KindNotRunning Kind = iota
	KindStarting
	KindRunning
	KindStopping
	KindCrashed
	KindDegraded
	KindContractMismatch
	// KindNoAccess: the server is there, this user may not read its token.
	KindNoAccess
)

// State is a Kind plus whatever that Kind needs to render.
type State struct {
	Kind Kind
	// Detail is the degraded reason, or the group name for NoAccess.
	Detail string
	// ServerContractVersion is only meaningful for KindContractMismatch.
	ServerContractVersion int
}

// Icon is which of the three embedded PNGs the tray should show.
type Icon int

const (
	IconRunning Icon = iota
	IconStopped
	IconAttention
)

// Derive maps a live /status response onto a tray state. Priority order
// matches the macOS port exactly: a contract we do not share means we
// cannot trust any other field, a crashed process needs attention NOW and
// so outranks a merely-degraded database, and only then does the server's
// own reported state decide.
func Derive(status *ipc.StatusResponse) State {
	if status == nil {
		return Unreachable()
	}
	if !status.MatchesContractVersion() {
		return State{Kind: KindContractMismatch, ServerContractVersion: status.IPCContractVersion}
	}
	if status.Server.State == ipc.ProcessCrashed || status.Worker.State == ipc.ProcessCrashed {
		return State{Kind: KindCrashed}
	}
	if status.Provisioning.State == ipc.ProvisioningCorrupt {
		detail := "corrupt"
		if status.Provisioning.Detail != nil && *status.Provisioning.Detail != "" {
			detail = *status.Provisioning.Detail
		}
		return State{Kind: KindDegraded, Detail: "database: " + detail}
	}
	switch status.Server.State {
	case ipc.ProcessStarting:
		return State{Kind: KindStarting}
	case ipc.ProcessStopping:
		return State{Kind: KindStopping}
	case ipc.ProcessStopped:
		return State{Kind: KindNotRunning}
	case ipc.ProcessRunning:
		// A crashed worker already returned above; anything else
		// non-running is a real mismatch worth surfacing distinctly from
		// a fully healthy server.
		if status.Worker.State != ipc.ProcessRunning {
			return State{Kind: KindDegraded, Detail: "worker " + string(status.Worker.State)}
		}
		return State{Kind: KindRunning}
	default:
		return State{Kind: KindNotRunning}
	}
}

// Unreachable is the state for every transport-level failure — no
// discovery file, a stale pid, a torn read, an HTTP error. From the tray's
// point of view they all mean the same thing: there is nothing to control.
func Unreachable() State {
	return State{Kind: KindNotRunning}
}

// NoAccess is the Linux-only state: the files are there, this user is not
// in the group that may read them.
func NoAccess(group string) State {
	return State{Kind: KindNoAccess, Detail: group}
}

// StatusLabel is the disabled first line of the menu, and the tooltip.
func (s State) StatusLabel() string {
	switch s.Kind {
	case KindStarting:
		return "Loombre is starting…"
	case KindRunning:
		return "Loombre is running"
	case KindStopping:
		return "Loombre is stopping…"
	case KindCrashed:
		return "Loombre has crashed"
	case KindDegraded:
		return fmt.Sprintf("Loombre is degraded (%s)", s.Detail)
	case KindContractMismatch:
		return fmt.Sprintf("Contract version mismatch (server v%d, controller v%d)", s.ServerContractVersion, ipc.ContractVersion)
	case KindNoAccess:
		return fmt.Sprintf("Can't read the Loombre IPC token — add yourself to the '%s' group", s.groupName())
	default:
		return "Loombre is not running"
	}
}

// Icon picks the tray image. Anything the operator should look at gets the
// attention icon; transitional and unreachable states share the stopped
// one, because "not usable yet" and "not running" are the same thing to
// someone glancing at a panel.
func (s State) Icon() Icon {
	switch s.Kind {
	case KindRunning:
		return IconRunning
	case KindCrashed, KindDegraded, KindContractMismatch:
		return IconAttention
	default:
		return IconStopped
	}
}

func (s State) groupName() string {
	if s.Detail == "" {
		return "loombre"
	}
	return s.Detail
}

// NoAccessNotification is the one-time notification for the NoAccess
// state: the exact command, because "you lack permission" without the fix
// is the same dead end as no message at all.
func NoAccessNotification(usermodCommand string) (title, body string) {
	return "Loombre tray can't read the IPC token",
		"The Loombre server is running, but its control token is readable only by its admin group. Run:\n" +
			usermodCommand + "\nthen log out and back in."
}

// NoTrayHostNotification is shown once when no StatusNotifierItem host
// ever appeared on the session bus — the GNOME-without-the-extension case,
// where the process is fine and simply has nowhere to draw.
func NoTrayHostNotification() (title, body string) {
	return "Loombre tray",
		"No system tray host was found. On GNOME, install the 'AppIndicator and KStatusNotifierItem Support' extension; the tray will appear once a host is available."
}
