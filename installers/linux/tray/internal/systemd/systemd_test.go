// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/linux/tray/internal/systemd/systemd_test.go

package systemd

import (
	"strings"
	"testing"
)

func TestUnitNamesMatchTheShippedTemplates(t *testing.T) {
	// Lockstep with installers/linux/systemd/*.service.template — a typo
	// here means the tray silently controls nothing.
	if ServerUnit != "loombre-server.service" || WorkerUnit != "loombre-worker.service" || WebUnit != "loombre-web.service" {
		t.Fatalf("unit names drifted: %q %q %q", ServerUnit, WorkerUnit, WebUnit)
	}
}

func TestStartOrderPutsTheServerFirst(t *testing.T) {
	// The server hosts the embedded PostgreSQL the worker and web depend on.
	if StartOrder[0] != ServerUnit {
		t.Fatalf("StartOrder = %v", StartOrder)
	}
	if len(StartOrder) != 3 {
		t.Fatalf("a full-stack start must name all three units, got %v", StartOrder)
	}
}

func TestStopOrderPutsTheServerLast(t *testing.T) {
	// Consumers first; nothing should spend its shutdown window flailing
	// against a database that died before it did.
	if StopOrder[len(StopOrder)-1] != ServerUnit {
		t.Fatalf("StopOrder = %v", StopOrder)
	}
	if StopOrder[0] != WorkerUnit || StopOrder[1] != WebUnit {
		t.Fatalf("StopOrder = %v", StopOrder)
	}
}

func TestCommandArgs(t *testing.T) {
	show := ShowArgs(ServerUnit)
	want := []string{"show", "-p", "LoadState", "-p", "ActiveState", ServerUnit}
	if strings.Join(show, " ") != strings.Join(want, " ") {
		t.Fatalf("ShowArgs = %v", show)
	}

	start := StartArgs()
	if start[0] != "start" || strings.Join(start[1:], " ") != strings.Join(StartOrder, " ") {
		t.Fatalf("StartArgs = %v", start)
	}
	stop := StopArgs()
	if stop[0] != "stop" || strings.Join(stop[1:], " ") != strings.Join(StopOrder, " ") {
		t.Fatalf("StopArgs = %v", stop)
	}

	// StartArgs/StopArgs must not alias the package-level order slices —
	// an append that wrote through would corrupt every later call.
	start[1] = "mutated"
	if StartOrder[0] != ServerUnit {
		t.Fatalf("StartArgs aliases StartOrder: %v", StartOrder)
	}
}

func TestManualCommandsNameTheUnitsAsAPersonWouldType(t *testing.T) {
	if got := ManualStartCommand(); got != "sudo systemctl start loombre-server loombre-worker loombre-web" {
		t.Fatalf("ManualStartCommand = %q", got)
	}
	if got := ManualStopCommand(); got != "sudo systemctl stop loombre-worker loombre-web loombre-server" {
		t.Fatalf("ManualStopCommand = %q", got)
	}
}

func TestParseShow(t *testing.T) {
	cases := []struct {
		name       string
		out        string
		wantExists bool
		wantState  State
	}{
		{
			name:       "running unit",
			out:        "LoadState=loaded\nActiveState=active\n",
			wantExists: true,
			wantState:  StateRunning,
		},
		{
			name:       "unit not installed",
			out:        "LoadState=not-found\nActiveState=inactive\n",
			wantExists: false,
			wantState:  StateStopped,
		},
		{
			name:       "starting",
			out:        "LoadState=loaded\nActiveState=activating\n",
			wantExists: true,
			wantState:  StateStartPending,
		},
		{
			name:       "reloading counts as starting",
			out:        "LoadState=loaded\nActiveState=reloading\n",
			wantExists: true,
			wantState:  StateStartPending,
		},
		{
			name:       "stopping",
			out:        "LoadState=loaded\nActiveState=deactivating\n",
			wantExists: true,
			wantState:  StateStopPending,
		},
		{
			name:       "inactive",
			out:        "LoadState=loaded\nActiveState=inactive\n",
			wantExists: true,
			wantState:  StateStopped,
		},
		{
			name:       "failed is startable, not unknown",
			out:        "LoadState=loaded\nActiveState=failed\n",
			wantExists: true,
			wantState:  StateStopped,
		},
		{
			name:       "masked unit exists but has no usable state",
			out:        "LoadState=masked\nActiveState=inactive\n",
			wantExists: true,
			wantState:  StateStopped,
		},
		{
			name:       "unexpected active state",
			out:        "LoadState=loaded\nActiveState=maintenance\n",
			wantExists: true,
			wantState:  StateUnknown,
		},
		{
			name:       "empty output",
			out:        "",
			wantExists: false,
			wantState:  StateUnknown,
		},
		{
			name:       "noise and ordering do not matter",
			out:        "\nSubState=running\nActiveState=active\nLoadState=loaded\ngarbage\n",
			wantExists: true,
			wantState:  StateRunning,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			snap := ParseShow(tc.out)
			if snap.UnitExists != tc.wantExists {
				t.Errorf("UnitExists = %v, want %v (%+v)", snap.UnitExists, tc.wantExists, snap)
			}
			if snap.State() != tc.wantState {
				t.Errorf("State = %v, want %v (%+v)", snap.State(), tc.wantState, snap)
			}
		})
	}
}

func TestIsAuthCancellation(t *testing.T) {
	cancellations := []string{
		"Failed to start loombre-server.service: Interactive authentication required.",
		"Failed to start loombre-server.service: Access denied\nOperation cancelled",
		"Request canceled by the user",
		"Authentication is required to start 'loombre-server.service'.",
	}
	for _, stderr := range cancellations {
		if !IsAuthCancellation(stderr) {
			t.Errorf("expected a polkit cancellation for %q", stderr)
		}
	}
	failures := []string{
		"Failed to start loombre-server.service: Unit loombre-server.service not found.",
		"Job for loombre-server.service failed because the control process exited with error code.",
		"",
	}
	for _, stderr := range failures {
		if IsAuthCancellation(stderr) {
			t.Errorf("did not expect a polkit cancellation for %q", stderr)
		}
	}
}

func TestTailKeepsTheLastMeaningfulLine(t *testing.T) {
	if got := Tail("warming up\nJob for loombre-server.service failed.\n\n", 0); got != "Job for loombre-server.service failed." {
		t.Fatalf("Tail = %q", got)
	}
	if got := Tail("   \n\n", 0); got != "" {
		t.Fatalf("Tail of blank stderr = %q", got)
	}
	if got := Tail("abcdefghij", 4); got != "ghij" {
		t.Fatalf("Tail truncation = %q", got)
	}
}

func TestStateStrings(t *testing.T) {
	for _, s := range []State{StateStopped, StateRunning, StateStartPending, StateStopPending} {
		if s.String() == "" || s.String() == "unknown" {
			t.Errorf("State(%d) has no log-friendly name", int(s))
		}
	}
	if StateUnknown.String() != "unknown" {
		t.Errorf("StateUnknown.String() = %q", StateUnknown.String())
	}
}
