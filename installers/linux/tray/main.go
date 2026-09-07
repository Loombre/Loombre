// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/linux/tray/main.go
//
// loombre-tray — the Linux system tray controller, the third of the three
// platform controllers (installers/windows/tray is a C# NotifyIcon,
// installers/macos/menubar a Swift NSStatusItem). It speaks the same
// frozen @loombre/controller-ipc contract as the other two and offers the
// same menu; what differs is the channel for starting a stopped server
// (systemd + polkit rather than the SCM + UAC or launchd + AppleScript)
// and the confirmation model for shutdown (no toolkit here to open a
// dialog with — see internal/control/confirm.go).
//
// This file stays portable on purpose: argument parsing has no business
// being Linux-only, and keeping it here means `go vet`/`go test` on a
// developer's Mac still cover it. Everything that touches a tray, D-Bus,
// systemctl or a browser lives behind a linux build tag in app_linux.go.

package main

import (
	"fmt"
	"os"

	"loombre.dev/linux-tray/internal/control"
)

// buildVersion is stamped by the release pipeline with
// -ldflags "-X main.buildVersion=<root package.json version>", the same
// single-sourced version the server reports — see the Windows tray's
// -p:Version for the equivalent. "dev" is what a bare `go build` gets.
var buildVersion = "dev"

func main() {
	launch := control.ParseLaunch(os.Args[1:])
	switch {
	case launch.ShowHelp:
		fmt.Print(control.UsageText)
		return
	case launch.ShowVersion:
		fmt.Printf("loombre-tray %s\n", buildVersion)
		return
	}
	os.Exit(runTray(launch.Mode))
}
