// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/linux/tray/internal/control/version.go
//
// The disabled version line at the bottom of the menu. It carries two
// different versions on purpose: this binary's build version, and the IPC
// contract version it speaks. When those disagree with the server's, that
// line is the only place an operator can find out — status.ts's own header
// calls this out as the point of carrying ipcContractVersion on the wire
// at all.

package control

import (
	"fmt"

	"loombre.dev/linux-tray/internal/ipc"
)

// VersionLine renders the menu's version item. serverVersion is the
// connected server's build version, or "" when there is no connection.
func VersionLine(buildVersion string, state State, serverVersion string) string {
	if buildVersion == "" {
		buildVersion = "dev"
	}
	var line string
	if state.Kind == KindContractMismatch {
		line = fmt.Sprintf("Loombre Tray v%s — contract v%d ≠ server v%d",
			buildVersion, ipc.ContractVersion, state.ServerContractVersion)
	} else {
		line = fmt.Sprintf("Loombre Tray v%s — IPC contract v%d", buildVersion, ipc.ContractVersion)
	}
	if serverVersion != "" {
		line += fmt.Sprintf(" (server %s)", serverVersion)
	}
	return line
}
