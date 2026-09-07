// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/linux/tray/icons.go
//
// The three tray images, embedded into the binary. Embedded rather than
// read from /usr/share at runtime for the same reason the other two trays
// compile theirs in: a controller whose job is to tell you the server is
// missing must not itself fail because a file is missing. StatusNotifierItem
// hosts take pixel data over D-Bus (fyne.io/systray decodes these PNGs),
// so there is no icon-theme lookup to depend on either.
//
// Deliberately not behind a linux build tag: embedding is portable, and
// keeping it here means a macOS `go build ./...` still fails loudly if an
// asset is deleted.

package main

import (
	_ "embed"

	"loombre.dev/linux-tray/internal/control"
)

//go:embed assets/tray-running.png
var iconRunning []byte

//go:embed assets/tray-stopped.png
var iconStopped []byte

//go:embed assets/tray-attention.png
var iconAttention []byte

// iconBytes maps a derived state's icon onto the embedded image.
func iconBytes(icon control.Icon) []byte {
	switch icon {
	case control.IconRunning:
		return iconRunning
	case control.IconAttention:
		return iconAttention
	default:
		return iconStopped
	}
}
