// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/linux/tray/internal/control/confirm.go
//
// The confirmation model for "Shut down Loombre…". The other two
// controllers put a real dialog in front of this destructive action — a
// TaskDialog on Windows, an NSAlert on macOS. A StatusNotifierItem menu
// has no toolkit to open a window with, and pulling in GTK or Qt just to
// ask one question would trade a 6 MB static binary for a pile of runtime
// library dependencies on every distribution.
//
// So the menu item asks itself: the first click retitles it, and only a
// second click inside a short window actually stops anything. A stray
// click cannot take a household's media server down, and the window
// lapsing on its own means an armed item never stays armed.
//
// The clock is an argument, never time.Now() read internally, so every
// boundary of that window is testable.

package control

import "time"

// ConfirmWindow is how long an armed shutdown item stays armed.
const ConfirmWindow = 10 * time.Second

// Titles for the shutdown item.
const (
	TitleShutdown        = "Shut down Loombre…"
	TitleShutdownConfirm = "Click again to confirm shut-down"
	TitleShuttingDown    = "Shutting down Loombre…"
)

// ConfirmOutcome is what a click means.
type ConfirmOutcome int

const (
	// ConfirmArmed: the item is now asking for a second click.
	ConfirmArmed ConfirmOutcome = iota
	// ConfirmProceed: the second click landed in time — do it.
	ConfirmProceed
)

// ShutdownConfirm tracks the arming window. The zero value is disarmed.
type ShutdownConfirm struct {
	armedUntil time.Time
}

// Click records a click at now and reports what should happen.
func (c *ShutdownConfirm) Click(now time.Time) ConfirmOutcome {
	if c.Armed(now) {
		// Disarm before proceeding: if the shutdown fails and the item
		// comes back, it must ask again rather than sitting pre-armed.
		c.Reset()
		return ConfirmProceed
	}
	c.armedUntil = now.Add(ConfirmWindow)
	return ConfirmArmed
}

// Armed reports whether a second click at now would proceed.
func (c *ShutdownConfirm) Armed(now time.Time) bool {
	return !c.armedUntil.IsZero() && now.Before(c.armedUntil)
}

// Reset disarms the window.
func (c *ShutdownConfirm) Reset() {
	c.armedUntil = time.Time{}
}

// Title is what the shutdown item should read at now. inFlight wins over
// everything: while the stop is running the item is neither armed nor
// clickable.
func (c *ShutdownConfirm) Title(now time.Time, inFlight bool) string {
	switch {
	case inFlight:
		return TitleShuttingDown
	case c.Armed(now):
		return TitleShutdownConfirm
	default:
		return TitleShutdown
	}
}
