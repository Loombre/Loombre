// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/linux/tray/app_other.go
//
// Off-Linux stub for app_linux.go. This binary only ships on Linux, but
// the module is developed and tested on macOS too: keeping `main`
// compilable there is what lets `go vet ./...` and `go test ./...` cover
// the argument parsing, the decision tables and the wire types without a
// Linux host or a session bus.

//go:build !linux

package main

import (
	"fmt"
	"os"

	"loombre.dev/linux-tray/internal/control"
)

func runTray(mode control.LaunchMode) int {
	fmt.Fprintf(os.Stderr,
		"loombre-tray: the Loombre tray controller runs on Linux only (requested mode: %s)\n", mode)
	return 1
}
