// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/linux/tray/internal/control/crash_test.go

package control

import (
	"testing"

	"loombre.dev/linux-tray/internal/ipc"
)

// An empty list is the HEALTHY steady state, not an error — and it must
// still produce a decision the UI renders, never a silent no-op.
func TestPlanCrashRevealWithNoFiles(t *testing.T) {
	plan := PlanCrashReveal(nil)
	if plan.Kind != CrashNoneFound {
		t.Fatalf("Kind = %v", plan.Kind)
	}
	if plan.Directory != "" || plan.NewestPath != "" || plan.Count != 0 {
		t.Fatalf("plan = %+v", plan)
	}
}

func TestPlanCrashRevealOpensTheNewestFilesDirectory(t *testing.T) {
	plan := PlanCrashReveal([]ipc.CrashFileEntry{
		{Path: "/var/lib/loombre/crashes/server-2026-09-01.log", MtimeMs: 1732400000000},
		{Path: "/var/lib/loombre/crashes/worker-2026-08-20.log", MtimeMs: 1731900000000},
	})
	if plan.Kind != CrashReveal {
		t.Fatalf("Kind = %v", plan.Kind)
	}
	if plan.NewestPath != "/var/lib/loombre/crashes/server-2026-09-01.log" {
		t.Fatalf("NewestPath = %q", plan.NewestPath)
	}
	if plan.Directory != "/var/lib/loombre/crashes" {
		t.Fatalf("Directory = %q", plan.Directory)
	}
	if plan.Count != 2 {
		t.Fatalf("Count = %d", plan.Count)
	}
}

// The contract says the server already sorts newest-first; re-sorting here
// means a server that stops honouring that still opens the right place.
func TestPlanCrashRevealResortsDefensively(t *testing.T) {
	plan := PlanCrashReveal([]ipc.CrashFileEntry{
		{Path: "/crashes/old.log", MtimeMs: 1},
		{Path: "/crashes/newest.log", MtimeMs: 99},
		{Path: "/crashes/middle.log", MtimeMs: 50},
	})
	if plan.NewestPath != "/crashes/newest.log" {
		t.Fatalf("NewestPath = %q", plan.NewestPath)
	}
}

// The caller's slice must not be reordered under it — the poll loop hands
// over a response it may still be reading.
func TestPlanCrashRevealDoesNotMutateItsInput(t *testing.T) {
	files := []ipc.CrashFileEntry{
		{Path: "/crashes/old.log", MtimeMs: 1},
		{Path: "/crashes/newest.log", MtimeMs: 99},
	}
	PlanCrashReveal(files)
	if files[0].Path != "/crashes/old.log" {
		t.Fatalf("input was reordered: %+v", files)
	}
}

func TestAdminCrashPageURL(t *testing.T) {
	cases := map[string]string{
		"http://localhost:3000":     "http://localhost:3000/admin",
		"http://localhost:3000/":    "http://localhost:3000/admin",
		"https://media.example.net": "https://media.example.net/admin",
	}
	for in, want := range cases {
		if got := AdminCrashPageURL(in); got != want {
			t.Fatalf("AdminCrashPageURL(%q) = %q, want %q", in, got, want)
		}
	}
}
