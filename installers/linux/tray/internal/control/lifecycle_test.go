// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/linux/tray/internal/control/lifecycle_test.go
//
// Decision-table tests for DecideLifecycle, mirroring the Windows tray's
// ServerControlPlanTests.cs case for case (with systemd in place of the
// SCM) and the macOS menubar's LifecyclePlanTests.swift. The load-bearing
// case is the first one: with the IPC listener unreachable (server
// stopped) and systemd reporting the unit inactive, the item must be an
// ENABLED "Start Loombre" routed to systemd — both earlier trays shipped
// it permanently grayed out, because their enable condition required a
// connection to the very process the user was trying to start.

package control

import (
	"testing"

	"loombre.dev/linux-tray/internal/ipc"
	"loombre.dev/linux-tray/internal/systemd"
)

func statusWithServerState(state ipc.ProcessState) *ipc.StatusResponse {
	pid := int64(4242)
	started := int64(1732400000000)
	return &ipc.StatusResponse{
		IPCContractVersion: ipc.ContractVersion,
		Server:             ipc.ProcessInfo{State: state, PID: &pid, StartedAtMs: &started, Version: "1.0.0"},
		Worker:             ipc.ProcessInfo{State: ipc.ProcessRunning, PID: &pid, StartedAtMs: &started, Version: "1.0.0"},
		WebURL:             ptr("http://localhost:3000"),
		Provisioning:       ipc.ProvisioningStatus{State: ipc.ProvisioningReady, LastCheckMs: 1},
	}
}

func snapshot(active string) *systemd.Snapshot {
	return &systemd.Snapshot{UnitExists: true, LoadState: "loaded", ActiveState: active}
}

func TestDecideLifecycle(t *testing.T) {
	cases := []struct {
		name     string
		status   *ipc.StatusResponse
		snapshot *systemd.Snapshot
		want     LifecyclePlan
	}{
		{
			name:     "unreachable with an inactive unit yields an enabled start via systemd",
			snapshot: snapshot("inactive"),
			want:     LifecyclePlan{Title: TitleStart, Enabled: true, Action: ActionStartViaSystemd},
		},
		{
			name: "unreachable with a failed unit still offers start",
			// A crash-looping unit is exactly when Start is needed.
			snapshot: snapshot("failed"),
			want:     LifecyclePlan{Title: TitleStart, Enabled: true, Action: ActionStartViaSystemd},
		},
		{
			name:     "unreachable with an active unit reads as starting",
			snapshot: snapshot("active"),
			want:     LifecyclePlan{Title: TitleStarting},
		},
		{
			name:     "unreachable with an activating unit reads as starting",
			snapshot: snapshot("activating"),
			want:     LifecyclePlan{Title: TitleStarting},
		},
		{
			name:     "unreachable with a reloading unit reads as starting",
			snapshot: snapshot("reloading"),
			want:     LifecyclePlan{Title: TitleStarting},
		},
		{
			name:     "unreachable with a deactivating unit reads as stopping",
			snapshot: snapshot("deactivating"),
			want:     LifecyclePlan{Title: TitleStopping},
		},
		{
			name:     "unreachable with an unrecognised active state disables start",
			snapshot: snapshot("maintenance"),
			want:     LifecyclePlan{Title: TitleStart},
		},
		{
			name:     "unreachable with no installed unit disables start",
			snapshot: &systemd.Snapshot{UnitExists: false, LoadState: "not-found", ActiveState: "inactive"},
			want:     LifecyclePlan{Title: TitleStart},
		},
		{
			name:     "unreachable with no answer from systemd disables start",
			snapshot: nil,
			want:     LifecyclePlan{Title: TitleStart},
		},
		{
			name:   "a running server yields an enabled stop over IPC",
			status: statusWithServerState(ipc.ProcessRunning),
			want:   LifecyclePlan{Title: TitleStop, Enabled: true, Action: ActionStopViaIPC},
		},
		{
			name:   "a starting server disables the item",
			status: statusWithServerState(ipc.ProcessStarting),
			want:   LifecyclePlan{Title: TitleStarting},
		},
		{
			name:   "a stopping server disables the item",
			status: statusWithServerState(ipc.ProcessStopping),
			want:   LifecyclePlan{Title: TitleStopping},
		},
		{
			name: "a reachable but stopped server still routes start to systemd",
			// Cannot happen today (the listener lives inside the server),
			// but the wire type allows it and the IPC start endpoint
			// deterministically 409s.
			status:   statusWithServerState(ipc.ProcessStopped),
			snapshot: snapshot("inactive"),
			want:     LifecyclePlan{Title: TitleStart, Enabled: true, Action: ActionStartViaSystemd},
		},
		{
			name:     "a reachable but crashed server routes start to systemd",
			status:   statusWithServerState(ipc.ProcessCrashed),
			snapshot: snapshot("failed"),
			want:     LifecyclePlan{Title: TitleStart, Enabled: true, Action: ActionStartViaSystemd},
		},
		{
			name:     "a reachable crashed server with no systemd answer disables the item",
			status:   statusWithServerState(ipc.ProcessCrashed),
			snapshot: nil,
			want:     LifecyclePlan{Title: TitleStart},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := DecideLifecycle(tc.status, tc.snapshot)
			if got != tc.want {
				t.Fatalf("DecideLifecycle = %+v, want %+v", got, tc.want)
			}
		})
	}
}

// A disabled item must never carry an action: an action on a disabled item
// is one autoenablement bug away from firing a privileged start from a
// "Stopping server…"-titled item (the macOS MenuBuilder lesson).
func TestDisabledPlansNeverCarryAnAction(t *testing.T) {
	plans := []LifecyclePlan{
		DecideLifecycle(statusWithServerState(ipc.ProcessStarting), nil),
		DecideLifecycle(statusWithServerState(ipc.ProcessStopping), nil),
		DecideLifecycle(nil, snapshot("active")),
		DecideLifecycle(nil, snapshot("deactivating")),
		DecideLifecycle(nil, nil),
	}
	for _, plan := range plans {
		if !plan.Enabled && plan.Action != ActionNone {
			t.Errorf("disabled plan %+v carries an action", plan)
		}
	}
}

// The contract-mismatch case: the server is reachable and says it is
// running, so a stop is still meaningful — the mismatch is surfaced in the
// status line and the version line, not by disabling the kill path.
func TestContractMismatchStillAllowsStopping(t *testing.T) {
	status := statusWithServerState(ipc.ProcessRunning)
	status.IPCContractVersion = 2
	got := DecideLifecycle(status, nil)
	if got.Action != ActionStopViaIPC || !got.Enabled {
		t.Fatalf("DecideLifecycle = %+v", got)
	}
}
