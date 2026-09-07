// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/linux/tray/internal/control/lifecycle.go
//
// The Start/Stop decision table — a port of the Windows tray's
// ServerControl.Decide with a systemd snapshot standing in for the SCM
// one. All three controllers encode the same policy and should be edited
// together (the macOS half is MenuState.lifecyclePlan).
//
// WHY TWO CHANNELS: stopping goes over IPC, because the server owns its
// own graceful shutdown. STARTING a stopped server cannot: transport.ts's
// IPC_SERVER_START_SEMANTICS documents that POST /server/start is served
// by the server process itself, so it is reachable only while the server
// is already up and returns 409 every time. Starting goes through systemd.
//
// The load-bearing rule, and the reason this table exists at all: an
// unreachable server must yield an ENABLED Start. Both earlier trays
// shipped a version that disabled the item whenever the IPC poll failed —
// i.e. required a connection to the very process the user was trying to
// start ("Start server is always grayed out", v0.9.0-rc field reports).

package control

import (
	"loombre.dev/linux-tray/internal/ipc"
	"loombre.dev/linux-tray/internal/systemd"
)

// Action is what clicking the lifecycle item should do.
type Action int

const (
	ActionNone Action = iota
	// ActionStopViaIPC: POST /ipc/v1/server/stop over the live connection.
	ActionStopViaIPC
	// ActionStartViaSystemd: `systemctl start` the three units, which the
	// desktop's polkit agent authorizes.
	ActionStartViaSystemd
)

// Menu titles for the lifecycle item, in one place so the tests and the
// glue cannot drift apart.
const (
	TitleStart    = "Start Loombre"
	TitleStop     = "Stop server"
	TitleStarting = "Starting server…"
	TitleStopping = "Stopping server…"
)

// LifecyclePlan is title + enablement + action, derived in exactly one place.
type LifecyclePlan struct {
	Title   string
	Enabled bool
	Action  Action
}

// DecideLifecycle picks the plan. status is nil when the IPC listener is
// unreachable; snapshot is nil when systemd itself could not be asked.
func DecideLifecycle(status *ipc.StatusResponse, snapshot *systemd.Snapshot) LifecyclePlan {
	if status != nil {
		switch status.Server.State {
		case ipc.ProcessRunning:
			return LifecyclePlan{Title: TitleStop, Enabled: true, Action: ActionStopViaIPC}
		case ipc.ProcessStarting:
			return LifecyclePlan{Title: TitleStarting}
		case ipc.ProcessStopping:
			return LifecyclePlan{Title: TitleStopping}
		}
		// stopped/crashed over a LIVE connection cannot happen today (the
		// listener lives inside the server, which reports itself running),
		// but the wire type allows it and the IPC start endpoint
		// deterministically 409s — so route these through systemd exactly
		// like an unreachable server.
	}
	return decideFromSystemd(snapshot)
}

func decideFromSystemd(snapshot *systemd.Snapshot) LifecyclePlan {
	if snapshot == nil || !snapshot.UnitExists {
		// Nothing this tray could start: systemd could not be asked, or no
		// loombre-server.service is installed (a dev run, or a tarball
		// install whose units were never enabled).
		return LifecyclePlan{Title: TitleStart}
	}
	switch snapshot.State() {
	case systemd.StateStopped:
		return LifecyclePlan{Title: TitleStart, Enabled: true, Action: ActionStartViaSystemd}
	case systemd.StateRunning, systemd.StateStartPending:
		// The unit is up but the IPC listener is not answering yet: the
		// server is still booting (first start pays payload extraction,
		// initdb and migrations, which can take minutes on real hardware).
		// Say so, instead of showing a grayed-out Start over a server that
		// IS starting.
		return LifecyclePlan{Title: TitleStarting}
	case systemd.StateStopPending:
		return LifecyclePlan{Title: TitleStopping}
	default:
		return LifecyclePlan{Title: TitleStart}
	}
}
