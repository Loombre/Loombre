// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/linux/tray/internal/control/confirm_test.go

package control

import (
	"testing"
	"time"
)

var t0 = time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)

func TestFirstClickOnlyArms(t *testing.T) {
	var confirm ShutdownConfirm
	if got := confirm.Click(t0); got != ConfirmArmed {
		t.Fatalf("first click = %v, want armed", got)
	}
	if confirm.Title(t0, false) != TitleShutdownConfirm {
		t.Fatalf("Title = %q", confirm.Title(t0, false))
	}
}

func TestSecondClickInsideTheWindowProceeds(t *testing.T) {
	var confirm ShutdownConfirm
	confirm.Click(t0)
	if got := confirm.Click(t0.Add(5 * time.Second)); got != ConfirmProceed {
		t.Fatalf("second click = %v, want proceed", got)
	}
	// Proceeding disarms: if the stop fails and the item comes back, it
	// must ask again rather than sit pre-armed.
	if confirm.Armed(t0.Add(6 * time.Second)) {
		t.Fatal("proceeding must disarm the window")
	}
}

func TestSecondClickAfterTheWindowRearmsInsteadOfProceeding(t *testing.T) {
	var confirm ShutdownConfirm
	confirm.Click(t0)
	if got := confirm.Click(t0.Add(ConfirmWindow + time.Millisecond)); got != ConfirmArmed {
		t.Fatalf("late click = %v, want a fresh arm", got)
	}
}

// The exact boundary: a click at t0+ConfirmWindow is one instant too late.
// Pinned because an off-by-one the wrong way here would let a stray double
// click take a media server down.
func TestTheWindowBoundaryIsExclusive(t *testing.T) {
	var confirm ShutdownConfirm
	confirm.Click(t0)
	if confirm.Armed(t0.Add(ConfirmWindow)) {
		t.Fatal("the arming window must have expired at exactly t0+ConfirmWindow")
	}
	if !confirm.Armed(t0.Add(ConfirmWindow - time.Nanosecond)) {
		t.Fatal("the arming window must still be live one instant earlier")
	}
}

func TestZeroValueIsDisarmed(t *testing.T) {
	var confirm ShutdownConfirm
	if confirm.Armed(t0) {
		t.Fatal("a fresh ShutdownConfirm must not be armed")
	}
	if confirm.Title(t0, false) != TitleShutdown {
		t.Fatalf("Title = %q", confirm.Title(t0, false))
	}
}

func TestResetDisarms(t *testing.T) {
	var confirm ShutdownConfirm
	confirm.Click(t0)
	confirm.Reset()
	if confirm.Armed(t0.Add(time.Second)) {
		t.Fatal("Reset must disarm")
	}
}

func TestInFlightTitleWinsOverArming(t *testing.T) {
	var confirm ShutdownConfirm
	confirm.Click(t0)
	if got := confirm.Title(t0, true); got != TitleShuttingDown {
		t.Fatalf("Title = %q, want %q", got, TitleShuttingDown)
	}
}

func TestConfirmWindowIsTenSeconds(t *testing.T) {
	if ConfirmWindow != 10*time.Second {
		t.Fatalf("ConfirmWindow = %v", ConfirmWindow)
	}
}
