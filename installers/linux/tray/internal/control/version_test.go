// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/linux/tray/internal/control/version_test.go

package control

import "testing"

func TestVersionLineWithoutAConnection(t *testing.T) {
	got := VersionLine("1.2.3", Unreachable(), "")
	if got != "Loombre Tray v1.2.3 — IPC contract v1" {
		t.Fatalf("VersionLine = %q", got)
	}
}

func TestVersionLineAppendsTheServerBuildWhenConnected(t *testing.T) {
	got := VersionLine("1.2.3", State{Kind: KindRunning}, "1.0.0")
	if got != "Loombre Tray v1.2.3 — IPC contract v1 (server 1.0.0)" {
		t.Fatalf("VersionLine = %q", got)
	}
}

// The whole point of carrying ipcContractVersion on the wire: when it
// disagrees, this line is where an operator finds out.
func TestVersionLineOnContractMismatch(t *testing.T) {
	state := State{Kind: KindContractMismatch, ServerContractVersion: 2}
	got := VersionLine("1.2.3", state, "1.4.0")
	if got != "Loombre Tray v1.2.3 — contract v1 ≠ server v2 (server 1.4.0)" {
		t.Fatalf("VersionLine = %q", got)
	}
}

// An unstamped build (a bare `go build` outside the release pipeline)
// still renders something rather than "Loombre Tray v —".
func TestVersionLineFallsBackForAnUnstampedBuild(t *testing.T) {
	got := VersionLine("", Unreachable(), "")
	if got != "Loombre Tray vdev — IPC contract v1" {
		t.Fatalf("VersionLine = %q", got)
	}
}
