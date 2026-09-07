// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/linux/tray/internal/control/state_test.go
//
// Derivation tests driven by the SHARED contract fixtures
// (installers/macos/menubar/fixtures.json), so this port and the Swift
// original are proven against the same canonical bytes rather than against
// two independently hand-written sets of literals.

package control

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"loombre.dev/linux-tray/internal/ipc"
)

const fixturesPath = "../../../../macos/menubar/fixtures.json"

func fixtureStatus(t *testing.T, key string) *ipc.StatusResponse {
	t.Helper()
	raw, err := os.ReadFile(fixturesPath)
	if err != nil {
		t.Fatalf("read shared contract fixtures %s: %v", fixturesPath, err)
	}
	var set map[string]json.RawMessage
	if err := json.Unmarshal(raw, &set); err != nil {
		t.Fatalf("parse %s: %v", fixturesPath, err)
	}
	body, ok := set[key]
	if !ok {
		t.Fatalf("%s has no %q fixture", fixturesPath, key)
	}
	var status ipc.StatusResponse
	if err := json.Unmarshal(body, &status); err != nil {
		t.Fatalf("decode %s: %v", key, err)
	}
	return &status
}

func ptr[T any](v T) *T { return &v }

func TestDeriveHealthyFixtureIsRunning(t *testing.T) {
	got := Derive(fixtureStatus(t, "statusResponseHealthy"))
	if got.Kind != KindRunning {
		t.Fatalf("Kind = %v", got.Kind)
	}
	if got.Icon() != IconRunning {
		t.Fatalf("Icon = %v", got.Icon())
	}
	if got.StatusLabel() != "Loombre is running" {
		t.Fatalf("StatusLabel = %q", got.StatusLabel())
	}
}

func TestDeriveStoppedFixtureIsNotRunning(t *testing.T) {
	got := Derive(fixtureStatus(t, "statusResponseStopped"))
	if got.Kind != KindNotRunning || got.StatusLabel() != "Loombre is not running" {
		t.Fatalf("got %+v (%q)", got, got.StatusLabel())
	}
	if got.Icon() != IconStopped {
		t.Fatalf("Icon = %v", got.Icon())
	}
}

// The crashed fixture has BOTH a crashed server and corrupt provisioning —
// crashed must win, because a dead daemon needs a restart now and a
// softer "degraded" label would bury that.
func TestDeriveCrashedOutranksCorruptProvisioning(t *testing.T) {
	got := Derive(fixtureStatus(t, "statusResponseCrashed"))
	if got.Kind != KindCrashed {
		t.Fatalf("Kind = %v", got.Kind)
	}
	if got.Icon() != IconAttention {
		t.Fatalf("Icon = %v", got.Icon())
	}
}

func TestDeriveContractMismatchWinsOverEverything(t *testing.T) {
	status := fixtureStatus(t, "statusResponseCrashed")
	status.IPCContractVersion = 2
	got := Derive(status)
	if got.Kind != KindContractMismatch || got.ServerContractVersion != 2 {
		t.Fatalf("got %+v", got)
	}
	want := "Contract version mismatch (server v2, controller v1)"
	if got.StatusLabel() != want {
		t.Fatalf("StatusLabel = %q, want %q", got.StatusLabel(), want)
	}
	if got.Icon() != IconAttention {
		t.Fatalf("Icon = %v", got.Icon())
	}
}

func TestDeriveCorruptProvisioningIsDegradedIndependentOfProcessState(t *testing.T) {
	status := fixtureStatus(t, "statusResponseHealthy")
	status.Provisioning.State = ipc.ProvisioningCorrupt
	status.Provisioning.Detail = ptr("disk-full")
	got := Derive(status)
	if got.Kind != KindDegraded {
		t.Fatalf("Kind = %v", got.Kind)
	}
	if got.StatusLabel() != "Loombre is degraded (database: disk-full)" {
		t.Fatalf("StatusLabel = %q", got.StatusLabel())
	}
}

func TestDeriveCorruptProvisioningWithoutDetailStillReadsAsDatabase(t *testing.T) {
	status := fixtureStatus(t, "statusResponseHealthy")
	status.Provisioning.State = ipc.ProvisioningCorrupt
	status.Provisioning.Detail = nil
	got := Derive(status)
	if got.StatusLabel() != "Loombre is degraded (database: corrupt)" {
		t.Fatalf("StatusLabel = %q", got.StatusLabel())
	}
}

func TestDeriveRunningServerWithNonRunningWorkerIsDegraded(t *testing.T) {
	for _, workerState := range []ipc.ProcessState{ipc.ProcessStopped, ipc.ProcessStarting, ipc.ProcessStopping} {
		status := fixtureStatus(t, "statusResponseHealthy")
		status.Worker.State = workerState
		got := Derive(status)
		if got.Kind != KindDegraded {
			t.Fatalf("worker %q: Kind = %v", workerState, got.Kind)
		}
		if !strings.Contains(got.StatusLabel(), string(workerState)) {
			t.Fatalf("worker %q: StatusLabel = %q", workerState, got.StatusLabel())
		}
	}
}

func TestDeriveTransitionalServerStates(t *testing.T) {
	cases := map[ipc.ProcessState]struct {
		kind  Kind
		label string
	}{
		ipc.ProcessStarting: {KindStarting, "Loombre is starting…"},
		ipc.ProcessStopping: {KindStopping, "Loombre is stopping…"},
	}
	for serverState, want := range cases {
		status := fixtureStatus(t, "statusResponseHealthy")
		status.Server.State = serverState
		got := Derive(status)
		if got.Kind != want.kind || got.StatusLabel() != want.label {
			t.Fatalf("server %q: got %+v (%q)", serverState, got, got.StatusLabel())
		}
		if got.Icon() != IconStopped {
			t.Fatalf("server %q: transitional states use the stopped icon, got %v", serverState, got.Icon())
		}
	}
}

func TestUnreachableAndNilStatusCollapseToNotRunning(t *testing.T) {
	if Unreachable().Kind != KindNotRunning {
		t.Fatal("Unreachable must be not-running")
	}
	if Derive(nil).Kind != KindNotRunning {
		t.Fatal("a nil status must be not-running, never a panic")
	}
}

func TestNoAccessStateNamesTheGroup(t *testing.T) {
	got := NoAccess("loombre-admin")
	if got.Kind != KindNoAccess {
		t.Fatalf("Kind = %v", got.Kind)
	}
	want := "Can't read the Loombre IPC token — add yourself to the 'loombre-admin' group"
	if got.StatusLabel() != want {
		t.Fatalf("StatusLabel = %q, want %q", got.StatusLabel(), want)
	}
	// The server is running in this state, but the tray cannot confirm it
	// — the stopped icon is the honest one.
	if got.Icon() != IconStopped {
		t.Fatalf("Icon = %v", got.Icon())
	}
}

func TestNoAccessStateWithoutAGroupStillRenders(t *testing.T) {
	if !strings.Contains(NoAccess("").StatusLabel(), "group") {
		t.Fatalf("StatusLabel = %q", NoAccess("").StatusLabel())
	}
}

func TestEveryStateHasANonEmptyLabel(t *testing.T) {
	states := []State{
		{Kind: KindNotRunning},
		{Kind: KindStarting},
		{Kind: KindRunning},
		{Kind: KindStopping},
		{Kind: KindCrashed},
		{Kind: KindDegraded, Detail: "worker stopped"},
		{Kind: KindContractMismatch, ServerContractVersion: 7},
		NoAccess("wheel"),
	}
	for _, state := range states {
		if state.StatusLabel() == "" {
			t.Errorf("Kind %v has no label", state.Kind)
		}
	}
}

func TestNotificationsCarryTheFix(t *testing.T) {
	title, body := NoAccessNotification("sudo usermod -aG wheel ada")
	if title == "" || !strings.Contains(body, "sudo usermod -aG wheel ada") {
		t.Fatalf("no-access notification must carry the exact command: %q / %q", title, body)
	}
	if !strings.Contains(body, "log out") {
		t.Fatalf("group membership only takes effect on a new login; the body must say so: %q", body)
	}

	title, body = NoTrayHostNotification()
	if title == "" || !strings.Contains(body, "AppIndicator and KStatusNotifierItem Support") {
		t.Fatalf("tray-host notification must name the GNOME extension: %q / %q", title, body)
	}
}

func TestInstalledDefaultWebURLMatchesTheShippedWebUnit(t *testing.T) {
	if InstalledDefaultWebURL != "http://localhost:3000" {
		t.Fatalf("InstalledDefaultWebURL = %q", InstalledDefaultWebURL)
	}
}
